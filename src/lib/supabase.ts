import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { resilientFetch, REQUEST_TIMEOUT_MS } from './resilientFetch'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** 是否已配置云端（未配置时保持本地单人模式） */
export const isCloudConfigured = Boolean(supabaseUrl && supabaseAnonKey)

export const SUPABASE_URL = supabaseUrl ?? ''
export const SUPABASE_ANON_KEY = supabaseAnonKey ?? ''

// 带超时的 fetch 抽在 lib/resilientFetch.ts（不依赖 Capacitor），后台管理端也用它。
// 这里重新导出，App 内的模块与测试继续从 lib/supabase 引用即可。
export { resilientFetch, REQUEST_TIMEOUT_MS }

const isNative = Capacitor.isNativePlatform()

// 原生端（APK）用 Capacitor Preferences 持久保存登录态；
// Web 端使用 supabase-js 默认的 localStorage。
const nativeStorage = {
  getItem: async (key: string): Promise<string | null> => {
    const { value } = await Preferences.get({ key })
    return value
  },
  setItem: async (key: string, value: string): Promise<void> => {
    await Preferences.set({ key, value })
  },
  removeItem: async (key: string): Promise<void> => {
    await Preferences.remove({ key })
  },
}

/**
 * supabase-js 存放 session 的键：`sb-<project-ref>-auth-token`（其 createClient 里的默认值）。
 * 算不出来时留空 —— 依赖它的 readPersistedUser 会安全地退化成「读不到」。
 */
function storageKeyFor(url: string): string {
  try {
    return `sb-${new URL(url).hostname.split('.')[0]}-auth-token`
  } catch {
    return ''
  }
}

const SESSION_STORAGE_KEY = supabaseUrl ? storageKeyFor(supabaseUrl) : ''

/**
 * 直接从持久化存储里读上次登录的用户 —— **不发任何网络请求**。
 *
 * 为什么需要它：`auth.getSession()` 在 access token 过期时会顺手去刷新，弱网下可能
 * 长时间挂住。超时兜底时如果直接判定「未登录」，用户会被赶到登录页、以为自己被登出
 * （实测：token 刷新被挂住时，打开 App 停在「正在打开…」10 秒后跳到登录页），
 * 然后在弱网里反复重试登录 —— 而本地明明还存着登录态。
 *
 * 拿得到就先当已登录放行：真失效了，后续请求会 401，`onAuthStateChange` 会触发
 * `SIGNED_OUT` 再清理一次，不会把无效状态留在界面上。
 */
export async function readPersistedUser(): Promise<User | null> {
  if (!isCloudConfigured || !SESSION_STORAGE_KEY) return null
  try {
    const raw = isNative
      ? await nativeStorage.getItem(SESSION_STORAGE_KEY)
      : localStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { user?: User } | null
    return parsed?.user ?? null
  } catch {
    // 存储读不出来（损坏、被清）与「没有登录态」在调用方看来是同一件事
    return null
  }
}

export const supabase: SupabaseClient | null = isCloudConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      global: { fetch: resilientFetch },
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: isNative ? nativeStorage : undefined,
      },
    })
  : null

/**
 * 当前这条网络对云端的可达性。
 *
 * 分三种而不是布尔，是因为「连不上」有两种完全不同的原因，给用户的建议也不同：
 * - `offline`：**手机根本没联网**（飞行模式 / 移动数据关了）→ 让他去开网络
 * - `unreachable`：手机有网、但**到不了我们的服务器** → 常见于运营商对境外域名的
 *   DNS 干扰 / IPv6 路由不通 / 中间设备拦截。这时候说「请检查移动数据」是**误导**，
 *   用户会反复开关数据也解决不了；应该建议换 Wi-Fi、换运营商网络或稍后再试。
 *
 * ⚠️ 浏览器 fetch 只给 `TypeError: Failed to fetch`，**无法直接区分 DNS 失败 / TLS 失败 / 超时**。
 * 能可靠拿到的只有 `navigator.onLine`（本机有没有网卡级连接）—— 用它把 `offline` 分出来，
 * 剩下的统称 `unreachable`。再细的归因只能在服务端/用户侧用专业工具查。
 */
export type CloudReachability = 'ok' | 'offline' | 'unreachable'

/** 登录页预热探测的上限：到点就放弃并如实告诉用户「现在连不上」 */
export const PREFLIGHT_TIMEOUT_MS = 8000

/** `navigator.onLine === false` 时的探测上限：压短，但**仍然要探**（见 preflightCloud 的说明） */
export const OFFLINE_PROBE_TIMEOUT_MS = 1500

/**
 * 把「本机有没有网」与「探测结果」合成可达性。
 *
 * 抽成**纯函数**是为了能直测：之前这段判断写在 `preflightCloud` 里，
 * 而 `isCloudConfigured` 在测试环境恒为 false（会先早退）、视图层又把 `preflightCloud` mock 掉了 ——
 * 结果那行判断**没有任何测试**（把 `===` 改成 `!==`，全量 1552 条一条都不会红）。
 *
 * 关键纪律：`online === false` **不能单独下结论**。`navigator.onLine` 只是网络变更事件的快照，
 * 切 Wi-Fi↔移动数据瞬间、后台回前台、VPN / 无默认路由时都可能短暂甚至持续陈旧。
 * 所以调用方**必须**在 `online === false` 时也真探一次（用短超时），探测成功就自动纠正它。
 */
export function classifyReachability(online: boolean | undefined, probe: 'ok' | 'fail'): CloudReachability {
  // 探测成功 = 网络真的通（online 报 false 也无所谓，以实际探测为准）
  if (probe === 'ok') return 'ok'
  // 探测失败：只有「本机明确没有网」才判 offline，否则是「有网但到不了服务器」
  return online === false ? 'offline' : 'unreachable'
}

/**
 * 预热到云端的连接，并顺带回答「当前这条网络到底通不通、是哪一类不通」。
 *
 * 手机上的首次请求要现做 DNS + TLS 握手（实测生产库首次 1489ms、后续约 310ms），
 * 移动数据下这一步更容易失败 —— 用户看到的就是「一登录就报网络异常」，
 * 而代码里那 3 次重试要跑完 15 秒超时 × 3 才给出提示，等待过程毫无反馈。
 *
 * 所以登录页一打开就先跑一趟轻量探测（GoTrue 的 health 端点，不需要登录态）：
 * - 通：连接已建好，用户点登录时直接复用，省掉那一次握手；
 * - 不通：在用户输完手机号之前就把话说清楚（并给「重新检测」），
 *   而不是让他填完再等 45 秒。
 *
 * 注意这里**不抛错、不弹窗**：探测失败不代表登录一定失败（可能只是抖动），
 * 只作为提示；真正点登录时仍会走完整的重试逻辑。
 */
export async function preflightCloud(timeoutMs = PREFLIGHT_TIMEOUT_MS): Promise<CloudReachability> {
  // 本地单机模式：没有云端可言，**不是「不可达」** —— 别让未来的调用方把本地模式当网络故障
  if (!isCloudConfigured) return 'ok'
  const online = typeof navigator !== 'undefined' ? navigator.onLine : undefined

  // ⚠️ `online === false` 时**也要真探一次**，只把超时压短。
  // 曾经的写法是这里直接 `return 'offline'`（零证据早退）—— 代价是：onLine 一旦陈旧/误报 false，
  // 「手机当前没有联网」会**永久**显示，连点「重新检测」都走同一条早退，没有任何自愈路径。
  // 而改动之前（布尔实现）不管 onLine 报什么都会先探一次，探通就什么都不显示 ——
  // 也就是说那个早退是**真回归**，不是换句话术。
  const effectiveTimeout = online === false ? Math.min(timeoutMs, OFFLINE_PROBE_TIMEOUT_MS) : timeoutMs
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), effectiveTimeout)
  try {
    // 用 resilientFetch：GET 的连接类失败会自动重试，这正是「多点一次就好了」的那一步
    const res = await resilientFetch(`${SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: SUPABASE_ANON_KEY },
      signal: controller.signal,
    })
    // 收到**任何 HTTP 响应**都说明「网络可达」——401（anon key 配错）、5xx（服务端故障）
    // 都不是线路问题，不能告到用户头上说「运营商限制」。可达性 ≠ 业务成功。
    void res
    return classifyReachability(online, 'ok')
  } catch {
    return classifyReachability(online, 'fail')
  } finally {
    clearTimeout(timer)
  }
}

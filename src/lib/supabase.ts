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

/** 登录页预热探测的上限：到点就放弃并如实告诉用户「现在连不上」 */
export const PREFLIGHT_TIMEOUT_MS = 8000

/**
 * 预热到云端的连接，并顺带回答「当前这条网络到底通不通」。
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
export async function preflightCloud(timeoutMs = PREFLIGHT_TIMEOUT_MS): Promise<boolean> {
  if (!isCloudConfigured) return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // 用 resilientFetch：GET 的连接类失败会自动重试，这正是「多点一次就好了」的那一步
    const res = await resilientFetch(`${SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: SUPABASE_ANON_KEY },
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

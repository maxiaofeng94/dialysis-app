import { ref, computed } from 'vue'
import type { User } from '@supabase/supabase-js'
import {
  supabase,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  isCloudConfigured,
  resilientFetch,
  readPersistedUser,
} from '../lib/supabase'
import { cacheClear } from '../lib/cloudCache'
import { clearCurrentPatient } from './patient'
import { withTimeout } from '../utils/timeout'

export const user = ref<User | null>(null)
export const initialized = ref(false)
export const isLoggedIn = computed(() => isCloudConfigured && !!user.value)

/**
 * 恢复登录态的上限：`getSession()` 正常只读本地存储，但 access token 过期时会顺手
 * 去刷新，弱网下可能长时间挂住 —— 路由守卫会 await 它，挂住就是永久白屏。
 */
const INIT_TIMEOUT_MS = 10000

/**
 * 网络类失败的重试节奏。首次请求要现做 DNS + TLS 握手，偶发直接失败，
 * 隔一下再试基本就通了（用户反馈的「多点几次才能登录」正是缺了这一步）。
 * 长度即额外重试次数。
 */
const NETWORK_RETRY_DELAYS_MS = [500, 1500]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 这条错误是不是「网络没通」。
 *
 * 必须用 supabase 返回的**英文原文**判断（`friendlyAuthMessage` 转成中文之后就认不出来了）：
 * 密码错了、账号被禁这类业务错误重试一万次也没用，只有网络问题值得重试。
 */
function isNetworkFailure(message: string): boolean {
  const m = (message ?? '').toLowerCase()
  if (!m) return false
  return (
    m.includes('failed to fetch') ||
    m.includes('network') ||
    m.includes('load failed') ||
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('abort') ||
    m.includes('fetch')
  )
}

/**
 * 清掉与账号绑定的本机残留：云端数据缓存 + 当前病人选择。
 * 登出、以及被服务端踢下线（令牌吊销/禁用）都要走这里 ——
 * 否则共用设备上换账号时，可能先看到上一个账号的病人档案与记录。
 */
async function clearLocalState() {
  await cacheClear()
  await clearCurrentPatient()
}

/** init() 的重入锁：路由守卫在并发导航时可能同时触发多次，重复注册 onAuthStateChange 会叠加回调 */
let initPromise: Promise<void> | null = null

async function init(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    if (!isCloudConfigured) {
      initialized.value = true
      return
    }
    // 超时兜底成 null 而不是一直等：宁可让用户看到登录页，也不能白屏
    const session = await withTimeout(supabase!.auth.getSession(), INIT_TIMEOUT_MS, null)
    if (session) {
      user.value = session.data.session?.user ?? null
    } else {
      // 超时了。注意：`getSession()` 正常只读本地存储，需要发网络请求只可能是
      // 「access token 过期、正在刷新」—— 也就是说本地明明还存着登录态。
      // 这时候判定「未登录」会把人赶到登录页，他会以为自己被登出，然后在弱网里
      // 反复重试登录（实测：刷新被挂住时 10 秒后跳登录页）。先按已登录放行：
      // 真失效了后续请求会 401，onAuthStateChange 会触发 SIGNED_OUT 再清一次。
      user.value = await readPersistedUser()
    }
    supabase!.auth.onAuthStateChange((event, session) => {
      user.value = session?.user ?? null
      // 注意：主动登出也会触发 SIGNED_OUT，这里再清一次是幂等的
      if (event === 'SIGNED_OUT') void clearLocalState()
    })
    initialized.value = true
  })()
  return initPromise
}

/**
 * 调 Edge Function（目前只有注册）。
 *
 * 断网/网关抖动要重试：手机首次请求的 DNS + TLS 握手偶发失败，一次失败就弹
 * 「网络连接失败」会让用户以为注册不上，反复点反而更容易撞上限流。
 * 5xx（网关抖动）也重试；4xx 是明确的业务结果，重试没有意义。
 */
async function callFunction(name: string, body: unknown) {
  const attempts = NETWORK_RETRY_DELAYS_MS.length + 1

  for (let i = 0; i < attempts; i++) {
    const last = i === attempts - 1
    try {
      // 用 resilientFetch 拿超时（非幂等 POST 不会被它重试，重试由上面的循环显式做）
      const res = await resilientFetch(`${SUPABASE_URL}/functions/v1/${name}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify(body),
      })
      if (res.status >= 500 && !last) {
        await sleep(NETWORK_RETRY_DELAYS_MS[i])
        continue
      }
      const data = await res.json().catch(() => ({}))
      return { ok: res.ok, data }
    } catch {
      // 断网时 fetch 直接 reject：转成用户能懂的文案，别让调用方卡在异常里
      if (last) break
      await sleep(NETWORK_RETRY_DELAYS_MS[i])
    }
  }

  return { ok: false, data: { error: '网络连接失败，请检查网络后重试' } }
}

/** 把 Supabase / 网络的英文报错转成用户看得懂的中文 */
function friendlyAuthMessage(message: string): string {
  const m = (message ?? '').toLowerCase()
  if (m.includes('invalid login')) return '手机号或密码不正确'
  if (m.includes('email not confirmed')) return '账号未确认，请联系管理员'
  if (m.includes('rate limit') || m.includes('too many')) return '尝试过于频繁，请稍后再试'
  if (m.includes('failed to fetch') || m.includes('network') || m.includes('fetch')) {
    return '网络连接失败，请检查网络后重试'
  }
  if (m.includes('banned') || m.includes('disabled')) return '账号已被禁用，请联系管理员'
  return message || '操作失败，请稍后再试'
}

function phoneToEmail(phone: string): string {
  return `${phone}@phone.local`
}

/**
 * 注册（服务端 createUser，伪邮箱 + 密码）
 * turnstileToken：启用了人机验证时必须带上（未启用时服务端会忽略）
 */
async function register(
  phone: string,
  password: string,
  turnstileToken?: string,
): Promise<{ ok: boolean; message: string }> {
  const { ok, data } = await callFunction('register', { phone, password, turnstileToken })
  if (ok) return { ok: true, message: '注册成功' }
  // 失败时响应体可能不是 JSON（网关 502/504 返回 HTML、函数未部署返回 404 文本），
  // 此时 data?.error 为空 —— 绝不能回落到「注册成功」，否则用户以为注册好了、其实没登录。
  return { ok: false, message: data?.error ?? '注册失败，请稍后再试' }
}

/**
 * 登录：手机号 + 密码。
 *
 * 网络类失败会自动重试（见 NETWORK_RETRY_DELAYS_MS）：手机上首次请求要现做
 * DNS + TLS 握手，偶发直接失败，用户反馈的「总提示网络失败，多点几次才行」
 * 就是缺了这一步。密码错、账号被禁这类业务错误不重试，立刻返回提示。
 *
 * `onRetry` 让界面能把「正在重试第几次」显示出来：重试最多要跑 15 秒 × 3，
 * 没有反馈的话用户只会以为卡死了，然后反复点击。
 */
async function login(
  phone: string,
  password: string,
  onRetry?: (attempt: number, total: number) => void,
): Promise<{ ok: boolean; message: string }> {
  // 本地模式（未配置云端）时 supabase 为 null，直接给出说明 —— 别让登录页卡在「提交中」。
  if (!supabase) return { ok: false, message: '当前是单机版，无需登录' }

  const credentials = { email: phoneToEmail(phone), password }
  const attempts = NETWORK_RETRY_DELAYS_MS.length + 1
  let lastMessage = ''

  for (let i = 0; i < attempts; i++) {
    if (i > 0) onRetry?.(i + 1, attempts)
    try {
      const { error } = await supabase.auth.signInWithPassword(credentials)
      if (!error) return { ok: true, message: '登录成功' }
      lastMessage = error.message
    } catch (err) {
      lastMessage = err instanceof Error ? err.message : String(err ?? '')
    }

    if (!isNetworkFailure(lastMessage) || i === attempts - 1) break
    await sleep(NETWORK_RETRY_DELAYS_MS[i])
  }

  return { ok: false, message: friendlyAuthMessage(lastMessage) }
}

async function logout() {
  try {
    await supabase?.auth.signOut()
  } finally {
    // 即使登出请求失败（离线/令牌已失效），本机也必须清干净：
    // 否则共用设备上换账号时会先看到上一个账号的病人档案与记录。
    user.value = null
    await clearLocalState()
  }
}

export function useAuth() {
  return { user, initialized, isLoggedIn, init, register, login, logout }
}

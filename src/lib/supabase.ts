import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** 是否已配置云端（未配置时保持本地单人模式） */
export const isCloudConfigured = Boolean(supabaseUrl && supabaseAnonKey)

export const SUPABASE_URL = supabaseUrl ?? ''
export const SUPABASE_ANON_KEY = supabaseAnonKey ?? ''

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

/** 单次请求最长等待时间：到点就中止，交给上层重试/提示，别让按钮一直转圈 */
export const REQUEST_TIMEOUT_MS = 15000

/** 只读请求的连接类失败重试节奏（写入类不重试：可能重复插入记录） */
const RETRY_DELAYS_MS = [400, 1200]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 只有幂等方法才允许在 fetch 层自动重试 */
function isIdempotentMethod(method: string | undefined): boolean {
  const m = (method ?? 'GET').toUpperCase()
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS'
}

/**
 * 「连接根本没建立」类失败：DNS 解析不了、连不上、断网 —— 请求没到达服务端，重试安全。
 * 超时中止（AbortError）**不算**：那种情况下请求可能已经被服务端处理了。
 */
function isConnectionFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; message?: string }
  if (e.name === 'AbortError') return false
  const m = (e.message ?? '').toLowerCase()
  return e.name === 'TypeError' || m.includes('failed to fetch') || m.includes('network')
}

/** 单次请求 + 超时；调用方自带的 signal 也会被尊重 */
async function fetchOnce(input: RequestInfo | URL, init: RequestInit | undefined): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const outer = init?.signal
  if (outer) {
    if (outer.aborted) controller.abort()
    else outer.addEventListener('abort', () => controller.abort(), { once: true })
  }
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 给 supabase-js 用的 fetch。
 *
 * 为什么需要它：手机（尤其医院里信号弱、或刚从 Wi-Fi 切到移动数据）首次请求要现做
 * DNS + TLS 握手，偶发会直接失败。supabase-js 默认既不超时也不重试 ——
 * 用户看到「网络连接失败」，再点一次（连接已建立）就好了，也就是反馈里的「要多点几次」。
 *
 * 写入类请求（POST 的 insert/upsert）不在这里重试，避免重试造成重复记录；
 * 登录/注册的重试放在 stores/auth.ts 里显式做。
 */
export async function resilientFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const retriable = isIdempotentMethod(init?.method)
  const attempts = retriable ? RETRY_DELAYS_MS.length + 1 : 1
  let lastError: unknown

  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchOnce(input, init)
    } catch (err) {
      lastError = err
      if (!retriable || !isConnectionFailure(err) || i === attempts - 1) throw err
      await sleep(RETRY_DELAYS_MS[i])
    }
  }
  throw lastError
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

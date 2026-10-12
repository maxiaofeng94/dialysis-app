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

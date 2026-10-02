import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * 后台管理端自己的 Supabase 客户端。
 *
 * 刻意不 import 主项目的 src/lib/supabase.ts：
 * 那个文件会带入 Capacitor Preferences 等移动端依赖与 PWA 逻辑，后台用不到。
 *
 * 后台同样只持有 anon key —— service_role 只存在于 admin-api Edge Function 内。
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** 是否已配置云端（未配置时后台无法使用，登录页会给出提示） */
export const isConfigured = Boolean(url && anonKey)

export const SUPABASE_URL = url ?? ''
export const SUPABASE_ANON_KEY = anonKey ?? ''

export const supabase: SupabaseClient | null = isConfigured
  ? createClient(url!, anonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : null

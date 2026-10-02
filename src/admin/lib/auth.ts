import { ref } from 'vue'
import type { User } from '@supabase/supabase-js'
import { supabase, isConfigured } from './supabase'
import { api, messageOf, setUnauthorizedHandler } from './api'
import type { Whoami } from './types'

/** Supabase 会话里的用户 */
export const adminUser = ref<User | null>(null)
/** admin-api 返回的身份信息（含 isAdmin） */
export const me = ref<Whoami | null>(null)
/** 是否已完成初始化（路由守卫依赖它，避免刷新瞬间被踢回登录页） */
export const ready = ref(false)

let signOutReason: string | null = null

function phoneToEmail(phone: string): string {
  return `${phone}@phone.local`
}

/** 取出并清空上次登出原因（用于登录页提示，例如空闲超时、登录态失效） */
export function consumeSignOutReason(): string | null {
  const reason = signOutReason
  signOutReason = null
  return reason
}

export async function refreshWhoami(): Promise<void> {
  try {
    me.value = await api.whoami()
  } catch {
    me.value = null
  }
}

export async function logout(reason?: string): Promise<void> {
  signOutReason = reason ?? null
  await supabase?.auth.signOut()
  adminUser.value = null
  me.value = null
}

/**
 * 登录凭证失效（接口返回 401）时统一处理：
 * 清掉本地会话并回到登录页，登录页会展示原因。
 * 用 hash 直接跳转而不是 router，避免与 router → auth 的循环依赖。
 */
async function handleUnauthorized(): Promise<void> {
  if (!adminUser.value) return
  await logout('登录状态已失效，请重新登录')
  window.location.hash = '#/login'
}

export async function initAuth(): Promise<void> {
  if (!isConfigured) {
    ready.value = true
    return
  }
  setUnauthorizedHandler(() => {
    void handleUnauthorized()
  })

  const { data } = await supabase!.auth.getSession()
  adminUser.value = data.session?.user ?? null
  if (adminUser.value) await refreshWhoami()
  supabase!.auth.onAuthStateChange((_event, session) => {
    adminUser.value = session?.user ?? null
    if (!session?.user) me.value = null
  })
  ready.value = true
}

function friendlyAuthError(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('invalid login')) return '手机号或密码不正确'
  if (m.includes('email not confirmed')) return '账号未确认'
  if (m.includes('banned') || m.includes('disabled')) return '账号已被禁用，请联系其他管理员'
  if (m.includes('rate limit') || m.includes('too many')) return '尝试过于频繁，请稍后再试'
  return message
}

/** 登录：手机号 + 密码（与 App 同一套账号），登录后立即校验后台权限 */
export async function login(phone: string, password: string): Promise<{ ok: boolean; message: string }> {
  if (!isConfigured) {
    return { ok: false, message: '未配置 Supabase 连接，无法登录' }
  }
  const { error } = await supabase!.auth.signInWithPassword({ email: phoneToEmail(phone), password })
  if (error) return { ok: false, message: friendlyAuthError(error.message) }

  try {
    const who = await api.whoami()
    if (!who.isAdmin) {
      await supabase!.auth.signOut()
      adminUser.value = null
      me.value = null
      return { ok: false, message: '该账号没有后台权限' }
    }
    me.value = who
    return { ok: true, message: '登录成功' }
  } catch (err) {
    await supabase!.auth.signOut()
    adminUser.value = null
    me.value = null
    return { ok: false, message: messageOf(err) }
  }
}

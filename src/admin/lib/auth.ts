import { ref } from 'vue'
import type { User } from '@supabase/supabase-js'
import { supabase, isConfigured } from './supabase'
import { api, messageOf, setForbiddenHandler, setUnauthorizedHandler } from './api'
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
  // 必须 scope:'local'：后台与手机 App 共用同一套账号，
  // 默认的 'global' 会把该账号在手机上的登录态一起吊销。
  await supabase?.auth.signOut({ scope: 'local' })
  adminUser.value = null
  me.value = null
}

/** 当前是否已经在登录页（避免重复跳转，也避免打断登录页自身的提示） */
function isLoginHash(): boolean {
  return window.location.hash.replace(/^#/, '').split('?')[0] === '/login'
}

/**
 * 登录凭证失效（接口返回 401，或本地已经取不到 token）时统一处理：
 * 清掉本地会话并回到登录页，登录页会展示原因。
 * 用 hash 直接跳转而不是 router，避免与 router → auth 的循环依赖。
 */
async function handleUnauthorized(): Promise<void> {
  await logout('登录状态已失效，请重新登录')
  window.location.hash = '#/login'
}

let checkingForbidden = false

/**
 * 接口返回 403（无后台权限）时复核身份：
 * 只有 whoami 明确回答 isAdmin === false 才登出，避免单个 action 被拒、
 * 复核请求本身失败等情况把仍然是管理员的账号误踢出去。
 */
async function handleForbidden(): Promise<void> {
  if (checkingForbidden) return
  checkingForbidden = true
  try {
    await refreshWhoami()
    if (me.value?.isAdmin === false) {
      await logout('后台权限已被撤销')
      window.location.hash = '#/login'
    }
  } finally {
    checkingForbidden = false
  }
}

export async function initAuth(): Promise<void> {
  if (!isConfigured) {
    ready.value = true
    return
  }
  setUnauthorizedHandler(() => {
    void handleUnauthorized()
  })
  setForbiddenHandler(() => handleForbidden())

  const { data } = await supabase!.auth.getSession()
  adminUser.value = data.session?.user ?? null
  if (adminUser.value) await refreshWhoami()
  supabase!.auth.onAuthStateChange((_event, session) => {
    adminUser.value = session?.user ?? null
    if (!session?.user) {
      me.value = null
      // 会话在别处失效（token 被清掉/被撤销）时回到登录页，不要停在只会报错的僵尸态
      if (!isLoginHash()) window.location.hash = '#/login'
    }
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
      // 只退掉后台这台设备：该账号在手机 App 上的登录态必须保留
      await supabase!.auth.signOut({ scope: 'local' })
      adminUser.value = null
      me.value = null
      return { ok: false, message: '该账号没有后台权限' }
    }
    me.value = who
    return { ok: true, message: '登录成功' }
  } catch (err) {
    await supabase!.auth.signOut({ scope: 'local' })
    adminUser.value = null
    me.value = null
    return { ok: false, message: messageOf(err) }
  }
}

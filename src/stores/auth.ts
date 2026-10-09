import { ref, computed } from 'vue'
import type { User } from '@supabase/supabase-js'
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY, isCloudConfigured } from '../lib/supabase'
import { cacheClear } from '../lib/cloudCache'
import { clearCurrentPatient } from './patient'

export const user = ref<User | null>(null)
export const initialized = ref(false)
export const isLoggedIn = computed(() => isCloudConfigured && !!user.value)

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
    const { data } = await supabase!.auth.getSession()
    user.value = data.session?.user ?? null
    supabase!.auth.onAuthStateChange((event, session) => {
      user.value = session?.user ?? null
      // 注意：主动登出也会触发 SIGNED_OUT，这里再清一次是幂等的
      if (event === 'SIGNED_OUT') void clearLocalState()
    })
    initialized.value = true
  })()
  return initPromise
}

async function callFunction(name: string, body: unknown) {
  // 注册接口无需登录：带上项目 key 即可（该函数部署为免 JWT 校验）
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, data }
  } catch {
    // 断网时 fetch 直接 reject：转成用户能懂的文案，别让调用方卡在异常里
    return { ok: false, data: { error: '网络连接失败，请检查网络后重试' } }
  }
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

/** 登录：手机号 + 密码 */
async function login(phone: string, password: string): Promise<{ ok: boolean; message: string }> {
  try {
    // 本地模式（未配置云端）时 supabase 为 null，这里会抛 TypeError —— 必须兜住，
    // 否则登录页会卡在「提交中」再也回不来。
    const { error } = await supabase!.auth.signInWithPassword({
      email: phoneToEmail(phone),
      password,
    })
    if (error) return { ok: false, message: friendlyAuthMessage(error.message) }
    return { ok: true, message: '登录成功' }
  } catch (err) {
    const raw = err instanceof Error ? err.message : ''
    if (!supabase) return { ok: false, message: '当前是单机版，无需登录' }
    return { ok: false, message: friendlyAuthMessage(raw) }
  }
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

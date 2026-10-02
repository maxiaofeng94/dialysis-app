import { ref, computed } from 'vue'
import type { User } from '@supabase/supabase-js'
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY, isCloudConfigured } from '../lib/supabase'
import { cacheClear } from '../lib/cloudCache'

export const user = ref<User | null>(null)
export const initialized = ref(false)
export const isLoggedIn = computed(() => isCloudConfigured && !!user.value)

async function init() {
  if (!isCloudConfigured) {
    initialized.value = true
    return
  }
  const { data } = await supabase!.auth.getSession()
  user.value = data.session?.user ?? null
  supabase!.auth.onAuthStateChange((_event, session) => {
    user.value = session?.user ?? null
  })
  initialized.value = true
}

async function callFunction(name: string, body: unknown) {
  // 注册接口无需登录：带上项目 key 即可（该函数部署为免 JWT 校验）
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
  return { ok, message: data?.error ?? '注册成功' }
}

/** 登录：手机号 + 密码 */
async function login(phone: string, password: string): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase!.auth.signInWithPassword({
    email: phoneToEmail(phone),
    password,
  })
  if (error) return { ok: false, message: error.message }
  return { ok: true, message: '登录成功' }
}

async function logout() {
  await supabase?.auth.signOut()
  user.value = null
  // 清掉云端数据缓存：否则换账号登录会先看到上一个账号的数据
  await cacheClear()
}

export function useAuth() {
  return { user, initialized, isLoggedIn, init, register, login, logout }
}

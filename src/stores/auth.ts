import { ref, computed } from 'vue'
import type { User } from '@supabase/supabase-js'
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY, isCloudConfigured } from '../lib/supabase'

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
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, data }
}

async function sendCode(phone: string): Promise<{ ok: boolean; message: string }> {
  const { ok, data } = await callFunction('send-otp', { phone })
  return { ok, message: data?.error ?? data?.message ?? '发送成功' }
}

async function verifyAndLogin(phone: string, code: string): Promise<{ ok: boolean; message: string }> {
  const { ok, data } = await callFunction('verify-otp', { phone, code })
  if (!ok || !data?.success) return { ok: false, message: data?.error ?? '验证失败' }
  // 用本次验证码作为密码换取会话（伪邮箱规则与 verify-otp 一致）
  const { error } = await supabase!.auth.signInWithPassword({
    email: `${phone}@phone.local`,
    password: code,
  })
  if (error) return { ok: false, message: error.message }
  return { ok: true, message: '登录成功' }
}

async function logout() {
  await supabase?.auth.signOut()
  user.value = null
}

export function useAuth() {
  return { user, initialized, isLoggedIn, init, sendCode, verifyAndLogin, logout }
}

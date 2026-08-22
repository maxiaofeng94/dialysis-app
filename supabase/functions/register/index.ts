// ============================================================
// 注册：手机号 + 密码（服务端密钥建号）
// 部署：supabase functions deploy register
// 说明：用伪邮箱 {手机号}@phone.local 作为 Supabase Auth 邮箱，
//       密码为用户设置的密码；登录用 signInWithPassword 直接登录。
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)

  try {
    const { phone, password } = await req.json()
    if (!/^1[3-9]\d{9}$/.test(phone ?? '')) return json({ error: '手机号格式不正确' }, 400)
    if (typeof password !== 'string' || password.length < 6) {
      return json({ error: '密码至少 6 位' }, 400)
    }

    const email = `${phone}@phone.local`
    const { error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { phone, name: '' },
    })
    if (error) {
      const msg = (error.message ?? '').toLowerCase()
      if (msg.includes('already') || msg.includes('exists') || msg.includes('registered')) {
        return json({ error: '该手机号已注册，请直接登录' }, 400)
      }
      return json({ error: error.message }, 400)
    }
    return json({ success: true })
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : '注册失败' }, 500)
  }
})

// ============================================================
// 校验短信验证码并登录/注册
// 部署：supabase functions deploy verify-otp
// 流程：校验验证码 → 标记已用 → 创建/更新 Supabase Auth 用户
//       （邮箱用伪邮箱 {手机号}@phone.local，密码设为本次验证码）
//       前端随后用 signInWithPassword({email, password: code}) 换取会话
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

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

function isChinaMobile(phone: string): boolean {
  return /^1[3-9]\d{9}$/.test(phone)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)

  try {
    const { phone, code } = await req.json()
    if (!isChinaMobile(phone)) return json({ error: '手机号格式不正确' }, 400)
    if (!/^\d{6}$/.test(code ?? '')) return json({ error: '验证码格式不正确' }, 400)

    // 查有效验证码（未使用、未过期）
    const { data: rows } = await supabase
      .from('otp_codes')
      .select('id')
      .eq('phone', phone)
      .eq('code', code)
      .eq('used', false)
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
    if (!rows?.length) return json({ error: '验证码错误或已过期' }, 400)

    // 标记验证码已用
    await supabase.from('otp_codes').update({ used: true }).eq('id', rows[0].id)

    // 伪邮箱：手机号 → 邮箱（前端据此登录）
    const email = `${phone}@phone.local`

    // 创建用户；若已存在则更新密码为本次验证码
    const { error: createErr } = await supabase.auth.admin.createUser({
      email,
      password: code,
      email_confirm: true,
      user_metadata: { phone, name: '' },
    })
    if (createErr) {
      const { data: list } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 })
      const found = list?.users.find((u) => u.email === email)
      if (!found) return json({ error: '用户处理失败，请重试' }, 500)
      await supabase.auth.admin.updateUserById(found.id, { password: code })
    }

    return json({ success: true, email })
  } catch (err) {
    console.error('verify-otp error:', err)
    return json({ error: err instanceof Error ? err.message : '验证失败' }, 500)
  }
})

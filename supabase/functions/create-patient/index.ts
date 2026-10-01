// ============================================================
// 创建病人（服务端密钥，原子完成：建病人 + 添加调用者为 owner）
// 部署：supabase functions deploy create-patient
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
    const { name, wheelchairWeight, rinseBackVolume } = await req.json()
    if (!name?.trim()) return json({ error: '请填写病人姓名' }, 400)

    // 识别调用者：service 客户端自身没有 session，必须显式传入请求头里的用户 access token
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!token) return json({ error: '未登录' }, 401)
    const { data: authData } = await supabase.auth.getUser(token)
    const uid = authData.user?.id
    if (!uid) return json({ error: '登录已过期，请重新登录' }, 401)

    const { data: patient, error: pErr } = await supabase
      .from('patients')
      .insert({
        name: name.trim(),
        wheelchair_weight: wheelchairWeight ?? 0,
        rinse_back_volume: rinseBackVolume ?? 300,
      })
      .select()
      .single()
    if (pErr) return json({ error: pErr.message }, 400)

    const { error: mErr } = await supabase.from('patient_members').insert({
      patient_id: patient.id,
      user_id: uid,
      role: 'owner',
    })
    if (mErr) {
      await supabase.from('patients').delete().eq('id', patient.id)
      return json({ error: mErr.message }, 400)
    }

    return json({ success: true, patient })
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : '创建失败' }, 500)
  }
})

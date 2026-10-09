// ============================================================
// 邀请成员（服务端密钥）：按手机号把已注册用户加入病人成员
// 仅 owner 可调用；RLS 之外由函数内校验角色
// 部署：supabase functions deploy invite-member
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2'
import { preflight, jsonResponse } from '../_shared/cors.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

Deno.serve(async (req) => {
  // CORS 头按 Origin 白名单下发（见 _shared/cors.ts）
  const json = (data: unknown, status = 200) => jsonResponse(req, data, status)

  if (req.method === 'OPTIONS') return preflight(req)
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)

  try {
    const { patientId, phone, role } = await req.json()
    if (!patientId || !/^1[3-9]\d{9}$/.test(phone ?? '')) {
      return json({ error: '参数不正确' }, 400)
    }
    const targetRole = role ?? 'caregiver'
    if (!['owner', 'caregiver', 'doctor', 'viewer'].includes(targetRole)) {
      return json({ error: '角色不正确' }, 400)
    }

    // 识别调用者：service 客户端自身没有 session，必须显式传入请求头里的用户 access token
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!token) return json({ error: '未登录' }, 401)
    const { data: authData } = await supabase.auth.getUser(token)
    const uid = authData.user?.id
    if (!uid) return json({ error: '登录已过期，请重新登录' }, 401)

    // 校验调用者是该病人的 owner
    const { data: caller } = await supabase
      .from('patient_members')
      .select('role')
      .eq('patient_id', patientId)
      .eq('user_id', uid)
      .maybeSingle()
    if (!caller || caller.role !== 'owner') return json({ error: '仅创建者可邀请成员' }, 403)

    // 按手机号查找已注册用户
    const { data: userRow } = await supabase
      .from('users')
      .select('id')
      .eq('phone', phone)
      .maybeSingle()
    if (!userRow) return json({ error: '该手机号尚未注册，请先让对方登录一次' }, 404)

    // 检查是否已是成员
    const { data: existing } = await supabase
      .from('patient_members')
      .select('id')
      .eq('patient_id', patientId)
      .eq('user_id', userRow.id)
      .maybeSingle()
    if (existing) return json({ error: '该成员已在列表' }, 400)

    const { error: insErr } = await supabase.from('patient_members').insert({
      patient_id: patientId,
      user_id: userRow.id,
      role: targetRole,
    })
    if (insErr) return json({ error: insErr.message }, 400)

    return json({ success: true })
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : '邀请失败' }, 500)
  }
})

// ============================================================
// 创建病人（服务端密钥，原子完成：建病人 + 添加调用者为 owner）
// 部署：supabase functions deploy create-patient
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
    // 请求体不是合法 JSON 时按空对象处理，交给下面的参数校验回 400（而不是抛异常变 500）
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>

    // 必须显式判类型：只写 `!name?.trim()` 的话，传数字 12345 会因为 `12345.trim` 不存在抛 TypeError → 500
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return json({ error: '请填写病人姓名' }, 400)

    const wheelchairWeight = Number(body.wheelchairWeight ?? 0)
    const rinseBackVolume = Number(body.rinseBackVolume ?? 300)
    if (
      !Number.isFinite(wheelchairWeight) ||
      wheelchairWeight < 0 ||
      !Number.isFinite(rinseBackVolume) ||
      rinseBackVolume < 0
    ) {
      return json({ error: '轮椅及衣物重量与回水量必须是不小于 0 的数字' }, 400)
    }
    // ⚠️ 轻微-8（第三轮独立评审）：上限校验必须与 App / 后台 / admin-api 一致。
    // 这里原来只判 `>= 0`，任何登录用户直接 POST 本函数就能写进 13000kg ——
    // 之后所有按档案计算的「上机前实际体重」都会是负数，用户看到的是离谱数字却查不出原因。
    // App 端会先拦，但迁移路径（`migrate.ts` 透传本地档案值，`validateBackup` 不校验量程）
    // 能绕过前端，所以服务端必须自己守住。
    if (wheelchairWeight > 100) {
      return json({ error: '轮椅及衣物重量不能超过 100kg（单位是 kg，不是克）' }, 400)
    }
    if (rinseBackVolume > 2000) {
      return json({ error: '回水量不能超过 2000ml' }, 400)
    }

    // 识别调用者：service 客户端自身没有 session，必须显式传入请求头里的用户 access token
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!token) return json({ error: '未登录' }, 401)
    const { data: authData } = await supabase.auth.getUser(token)
    const uid = authData.user?.id
    if (!uid) return json({ error: '登录已过期，请重新登录' }, 401)

    const { data: patient, error: pErr } = await supabase
      .from('patients')
      .insert({
        name,
        wheelchair_weight: wheelchairWeight,
        rinse_back_volume: rinseBackVolume,
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

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase'
import { cacheGet, cacheSet, cacheVersion, FRESH_MS } from './cloudCache'
import type { Patient } from '../types'

export interface MemberInfo {
  userId: string
  name: string | null
  phone: string | null
  role: string
}

function patientFromRow(r: any): Patient {
  return {
    id: r.id,
    name: r.name,
    birthday: r.birthday ?? '',
    wheelchairWeight: Number(r.wheelchair_weight ?? 0),
    rinseBackVolume: Number(r.rinse_back_volume ?? 300),
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: new Date(r.updated_at).getTime(),
  }
}

async function currentUid(): Promise<string | null> {
  const { data } = await supabase!.auth.getUser()
  return data.user?.id ?? null
}

/**
 * 调用 Edge Function 的请求头：
 * - Authorization 必须是当前登录用户的 access token（函数靠它识别调用者）；
 * - apikey 带上项目 key，供函数网关识别项目。
 */
async function edgeHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase!.auth.getSession()
  const token = data.session?.access_token || SUPABASE_ANON_KEY
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    apikey: SUPABASE_ANON_KEY,
  }
}

/** 当前用户可访问的病人列表（含角色）—— 带本地缓存，先显示再后台刷新 */
export async function listMyPatients(): Promise<{ patient: Patient; role: string }[]> {
  const uid = await currentUid()
  if (!uid) return []
  const key = `myPatients:${uid}`
  const load = async () => {
    const { data } = await supabase!.from('patient_members').select('role, patients(*)').eq('user_id', uid)
    const list = (data ?? []).map((r: any) => ({
      patient: patientFromRow(r.patients),
      role: r.role,
    }))
    await cacheSet(key, list)
    return list
  }
  const cached = await cacheGet<{ patient: Patient; role: string }[]>(key)
  if (cached) {
    // 必须和 cachedRepository.cacheFirst 用同一道「新鲜度」闸门：
    // 否则「命中缓存 → 后台刷新 → cacheVersion++ → 页面 watch 重读 → 又命中缓存 …」
    // 会自激成一个停不下来的请求循环（成员页/首页实测每轮都打一次 join 查询）。
    if (Date.now() - cached.updatedAt >= FRESH_MS) {
      void load()
        .then(() => {
          cacheVersion.value++
        })
        .catch(() => {})
    }
    return cached.value
  }
  return load()
}

/** 某病人的成员列表 —— 带本地缓存，先显示再后台刷新 */
export async function listMembers(patientId: string): Promise<MemberInfo[]> {
  const key = `members:${patientId}`
  const load = async () => {
    const { data } = await supabase!
      .from('patient_members')
      .select('user_id, role, users(name, phone)')
      .eq('patient_id', patientId)
    const list = (data ?? []).map((r: any) => ({
      userId: r.user_id,
      name: r.users?.name ?? null,
      phone: r.users?.phone ?? null,
      role: r.role,
    }))
    await cacheSet(key, list)
    return list
  }
  const cached = await cacheGet<MemberInfo[]>(key)
  if (cached) {
    // 同上：没有这道闸门时，成员页会在 watch(cacheVersion) 与后台刷新之间反复自激
    if (Date.now() - cached.updatedAt >= FRESH_MS) {
      void load()
        .then(() => {
          cacheVersion.value++
        })
        .catch(() => {})
    }
    return cached.value
  }
  return load()
}

/** 我的资料（public.users）—— 记录人显示用 */
export async function getMyProfile(): Promise<{ name: string | null; phone: string | null } | null> {
  const uid = await currentUid()
  if (!uid) return null
  const { data } = await supabase!.from('users').select('name, phone').eq('id', uid).maybeSingle()
  return data ? { name: data.name ?? null, phone: data.phone ?? null } : null
}

/** 修改我的姓名（记录人显示时优先用姓名，为空则显示手机号） */
export async function updateMyName(name: string) {
  const uid = await currentUid()
  if (!uid) return { ok: false, error: '未登录' }
  const { error } = await supabase!.from('users').update({ name: name || null }).eq('id', uid)
  return { ok: !error, error: error?.message }
}

/** 创建病人（Edge Function 原子完成：病人 + owner 成员） */
export async function createPatient(name: string, wheelchairWeight = 0, rinseBackVolume = 300) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/create-patient`, {
    method: 'POST',
    headers: await edgeHeaders(),
    body: JSON.stringify({ name, wheelchairWeight, rinseBackVolume }),
  })
  return { ok: res.ok, data: await res.json().catch(() => ({})) }
}

/** 按手机号邀请成员（Edge Function，仅 owner） */
export async function inviteMember(patientId: string, phone: string, role: string) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/invite-member`, {
    method: 'POST',
    headers: await edgeHeaders(),
    body: JSON.stringify({ patientId, phone, role }),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, error: data?.error }
}

/**
 * 成员表的写操作也要 `.select()` 复查影响行数。
 * RLS 对无权限的行是静默过滤的：更新/删除 0 行同样返回 204、error 为 null，
 * 前端如果只看 error，就会提示「已移除 / 角色已更新」，实际什么都没发生。
 */
function memberWriteFailed(data: unknown[] | null, action: string): { ok: false; error: string } | null {
  if (data?.length) return null
  return { ok: false, error: `${action}失败：可能没有权限，或该成员已被其他人处理` }
}

/** 设置成员角色（RLS 仅 owner 可改） */
export async function setMemberRole(patientId: string, userId: string, role: string) {
  const { data, error } = await supabase!
    .from('patient_members')
    .update({ role })
    .eq('patient_id', patientId)
    .eq('user_id', userId)
    .select('user_id')
  if (error) return { ok: false, error: error.message }
  return memberWriteFailed(data, '修改成员角色') ?? { ok: true }
}

/** 移除成员（RLS 仅 owner 可删） */
export async function removeMember(patientId: string, userId: string) {
  const { data, error } = await supabase!
    .from('patient_members')
    .delete()
    .eq('patient_id', patientId)
    .eq('user_id', userId)
    .select('user_id')
  if (error) return { ok: false, error: error.message }
  return memberWriteFailed(data, '移除成员') ?? { ok: true }
}

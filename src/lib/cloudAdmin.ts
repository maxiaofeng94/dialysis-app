import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase'
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

/** 当前用户可访问的病人列表（含角色） */
export async function listMyPatients(): Promise<{ patient: Patient; role: string }[]> {
  const uid = await currentUid()
  if (!uid) return []
  const { data } = await supabase!.from('patient_members').select('role, patients(*)').eq('user_id', uid)
  return (data ?? []).map((r: any) => ({
    patient: patientFromRow(r.patients),
    role: r.role,
  }))
}

/** 某病人的成员列表 */
export async function listMembers(patientId: string): Promise<MemberInfo[]> {
  const { data } = await supabase!.from('patient_members').select('user_id, role, users(name, phone)').eq('patient_id', patientId)
  return (data ?? []).map((r: any) => ({
    userId: r.user_id,
    name: r.users?.name ?? null,
    phone: r.users?.phone ?? null,
    role: r.role,
  }))
}

/** 创建病人（Edge Function 原子完成：病人 + owner 成员） */
export async function createPatient(name: string, wheelchairWeight = 0, rinseBackVolume = 300) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/create-patient`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ name, wheelchairWeight, rinseBackVolume }),
  })
  return { ok: res.ok, data: await res.json() }
}

/** 按手机号邀请成员（Edge Function，仅 owner） */
export async function inviteMember(patientId: string, phone: string, role: string) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/invite-member`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ patientId, phone, role }),
  })
  const data = await res.json()
  return { ok: res.ok, error: data?.error }
}

/** 设置成员角色（RLS 仅 owner 可改） */
export async function setMemberRole(patientId: string, userId: string, role: string) {
  const { error } = await supabase!
    .from('patient_members')
    .update({ role })
    .eq('patient_id', patientId)
    .eq('user_id', userId)
  return { ok: !error, error: error?.message }
}

/** 移除成员（RLS 仅 owner 可删） */
export async function removeMember(patientId: string, userId: string) {
  const { error } = await supabase!
    .from('patient_members')
    .delete()
    .eq('patient_id', patientId)
    .eq('user_id', userId)
  return { ok: !error, error: error?.message }
}

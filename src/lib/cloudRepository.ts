import { supabase } from './supabase'
import type { Repository } from '../repo/repository'
import type {
  Patient,
  DryWeight,
  DialysisSession,
  BloodPressure,
  BloodGlucose,
  AdverseReaction,
} from '../types'

// 说明：前端领域对象为 camelCase，数据库列为 snake_case，此处做双向映射。
// 所有查询受 Supabase RLS 约束（按 patient_members 角色）。

function requireClient() {
  if (!supabase) throw new Error('云端未配置')
  return supabase
}

// ---------- 行 → 领域对象 ----------

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

function dryWeightFromRow(r: any): DryWeight {
  return {
    id: r.id,
    patientId: r.patient_id,
    value: Number(r.value),
    effectiveDate: r.effective_date,
    note: r.note,
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: new Date(r.updated_at).getTime(),
  }
}

function sessionFromRow(r: any): DialysisSession {
  return {
    id: r.id,
    patientId: r.patient_id,
    date: r.date,
    preWeightMeasured: r.pre_weight_measured != null ? Number(r.pre_weight_measured) : null,
    postWeightMeasured: r.post_weight_measured != null ? Number(r.post_weight_measured) : null,
    wheelchairWeightUsed: Number(r.wheelchair_weight_used ?? 0),
    rinseBackVolumeUsed: Number(r.rinse_back_volume_used ?? 300),
    operator: null, // 云端以 operator_id 记录，显示名后续从 users 表关联
    status: r.status,
    notes: r.notes,
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: new Date(r.updated_at).getTime(),
  }
}

function bpFromRow(r: any): BloodPressure {
  return {
    id: r.id,
    sessionId: r.session_id,
    measuredAt: new Date(r.measured_at).getTime(),
    systolic: r.systolic,
    diastolic: r.diastolic,
    note: r.note,
  }
}

function bgFromRow(r: any): BloodGlucose {
  return {
    id: r.id,
    sessionId: r.session_id,
    measuredAt: new Date(r.measured_at).getTime(),
    value: Number(r.value),
    note: r.note,
  }
}

function reactionFromRow(r: any): AdverseReaction {
  return {
    id: r.id,
    sessionId: r.session_id,
    type: r.type,
    detail: r.detail,
    severity: r.severity,
    recordedAt: new Date(r.recorded_at).getTime(),
  }
}

// ---------- 领域对象 → 行 ----------

function patientToRow(p: Patient) {
  return {
    id: p.id,
    name: p.name,
    birthday: p.birthday || null,
    wheelchair_weight: p.wheelchairWeight,
    rinse_back_volume: p.rinseBackVolume,
    updated_at: new Date().toISOString(),
  }
}

function dryWeightToRow(d: DryWeight) {
  return {
    id: d.id,
    patient_id: d.patientId,
    value: d.value,
    effective_date: d.effectiveDate,
    note: d.note,
    updated_at: new Date().toISOString(),
  }
}

function sessionToRow(s: DialysisSession) {
  return {
    id: s.id,
    patient_id: s.patientId,
    date: s.date,
    pre_weight_measured: s.preWeightMeasured,
    post_weight_measured: s.postWeightMeasured,
    wheelchair_weight_used: s.wheelchairWeightUsed,
    rinse_back_volume_used: s.rinseBackVolumeUsed,
    operator_id: null as string | null, // 保存时自动填入当前登录用户
    status: s.status,
    notes: s.notes,
    updated_at: new Date().toISOString(),
  }
}

function bpToRow(b: BloodPressure) {
  return {
    id: b.id,
    session_id: b.sessionId,
    measured_at: new Date(b.measuredAt).toISOString(),
    systolic: b.systolic,
    diastolic: b.diastolic,
    note: b.note,
  }
}

function bgToRow(g: BloodGlucose) {
  return {
    id: g.id,
    session_id: g.sessionId,
    measured_at: new Date(g.measuredAt).toISOString(),
    value: g.value,
    note: g.note,
  }
}

function reactionToRow(r: AdverseReaction) {
  return {
    id: r.id,
    session_id: r.sessionId,
    type: r.type,
    detail: r.detail,
    severity: r.severity,
    recorded_at: new Date(r.recordedAt).toISOString(),
  }
}

// ---------- 云端仓储实现 ----------

class CloudRepository implements Repository {
  private client() {
    return requireClient()
  }

  async getPatient(id: string) {
    const { data } = await this.client().from('patients').select('*').eq('id', id).maybeSingle()
    return data ? patientFromRow(data) : undefined
  }

  async savePatient(patient: Patient) {
    const { error } = await this.client().from('patients').update(patientToRow(patient)).eq('id', patient.id)
    if (error) throw error
  }

  async listDryWeights(patientId: string) {
    const { data } = await this.client()
      .from('dry_weights')
      .select('*')
      .eq('patient_id', patientId)
      .order('effective_date', { ascending: false })
    return (data ?? []).map(dryWeightFromRow)
  }

  async saveDryWeight(dw: DryWeight) {
    const { error } = await this.client().from('dry_weights').upsert(dryWeightToRow(dw))
    if (error) throw error
  }

  async deleteDryWeight(id: string) {
    const { error } = await this.client().from('dry_weights').delete().eq('id', id)
    if (error) throw error
  }

  async listSessions(patientId: string) {
    const { data } = await this.client()
      .from('sessions')
      .select('*')
      .eq('patient_id', patientId)
      .order('date', { ascending: false })
    return (data ?? []).map(sessionFromRow)
  }

  async getSession(id: string) {
    const { data } = await this.client().from('sessions').select('*').eq('id', id).maybeSingle()
    return data ? sessionFromRow(data) : undefined
  }

  async saveSession(session: DialysisSession) {
    const row = sessionToRow(session)
    const {
      data: { user },
    } = await this.client().auth.getUser()
    row.operator_id = user?.id ?? null
    const { error } = await this.client().from('sessions').upsert(row)
    if (error) throw error
  }

  async deleteSession(id: string) {
    // 外键 on delete cascade 自动删除血压/血糖/不良反应
    const { error } = await this.client().from('sessions').delete().eq('id', id)
    if (error) throw error
  }

  async listBloodPressures(sessionId: string) {
    const { data } = await this.client()
      .from('blood_pressures')
      .select('*')
      .eq('session_id', sessionId)
      .order('measured_at', { ascending: true })
    return (data ?? []).map(bpFromRow)
  }

  async saveBloodPressure(bp: BloodPressure) {
    const { error } = await this.client().from('blood_pressures').upsert(bpToRow(bp))
    if (error) throw error
  }

  async deleteBloodPressure(id: string) {
    const { error } = await this.client().from('blood_pressures').delete().eq('id', id)
    if (error) throw error
  }

  async listBloodGlucoses(sessionId: string) {
    const { data } = await this.client()
      .from('blood_glucoses')
      .select('*')
      .eq('session_id', sessionId)
      .order('measured_at', { ascending: true })
    return (data ?? []).map(bgFromRow)
  }

  async saveBloodGlucose(glucose: BloodGlucose) {
    const { error } = await this.client().from('blood_glucoses').upsert(bgToRow(glucose))
    if (error) throw error
  }

  async deleteBloodGlucose(id: string) {
    const { error } = await this.client().from('blood_glucoses').delete().eq('id', id)
    if (error) throw error
  }

  async listAdverseReactions(sessionId: string) {
    const { data } = await this.client()
      .from('adverse_reactions')
      .select('*')
      .eq('session_id', sessionId)
      .order('recorded_at', { ascending: true })
    return (data ?? []).map(reactionFromRow)
  }

  async replaceAdverseReactions(sessionId: string, reactions: AdverseReaction[]) {
    const client = this.client()
    const { error: delErr } = await client.from('adverse_reactions').delete().eq('session_id', sessionId)
    if (delErr) throw delErr
    if (reactions.length) {
      const { error: insErr } = await client.from('adverse_reactions').insert(reactions.map(reactionToRow))
      if (insErr) throw insErr
    }
  }

  async exportAll() {
    const client = this.client()
    const [patients, dryWeights, sessions, bps, bgs, reactions] = await Promise.all([
      client.from('patients').select('*'),
      client.from('dry_weights').select('*'),
      client.from('sessions').select('*'),
      client.from('blood_pressures').select('*'),
      client.from('blood_glucoses').select('*'),
      client.from('adverse_reactions').select('*'),
    ])
    return JSON.stringify(
      {
        version: 1,
        exportedAt: Date.now(),
        patients: patients.data ?? [],
        dryWeights: dryWeights.data ?? [],
        sessions: sessions.data ?? [],
        bloodPressures: bps.data ?? [],
        bloodGlucoses: bgs.data ?? [],
        adverseReactions: reactions.data ?? [],
      },
      null,
      2,
    )
  }

  async importAll() {
    throw new Error('云端模式无需导入，数据已保存在云端')
  }
}

export const cloudRepository: Repository = new CloudRepository()

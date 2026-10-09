import { supabase } from './supabase'
import { DEFAULT_PATIENT_ID } from '../constants'
import type { Repository } from '../repo/repository'
import type {
  Patient,
  DryWeight,
  DialysisSession,
  BloodPressure,
  BloodGlucose,
  BloodFlow,
  AdverseReaction,
} from '../types'

// 说明：前端领域对象为 camelCase，数据库列为 snake_case，此处做双向映射。
// 所有查询受 Supabase RLS 约束（按 patient_members 角色）。

function requireClient() {
  if (!supabase) throw new Error('云端未配置')
  return supabase
}

/**
 * 本地默认病人 id（`patient-default`）**不是 uuid**，云端主键是 uuid —— 拿它去查库，
 * PostgREST 会因为类型转换失败直接返回 400。读接口现在会把 error 抛出来，
 * 于是「这个账号还没有病人」会被显示成「加载失败，请检查网络后重试」。
 *
 * 所以这种「云端不可能存在」的 id 直接判空，不必发请求。
 * （实测发现：新注册的账号 `currentPatientId` 仍是本地默认值时就会踩到。）
 */
function isQueryableId(value: string): boolean {
  return value !== DEFAULT_PATIENT_ID && value.trim() !== ''
}

// 透析记录查询：带出记录人姓名（sessions.operator_id → users，RLS 允许同病人成员互看）
const SESSION_SELECT = '*, operator:users(name, phone)'

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
    // 记录人显示名：优先姓名，没填姓名时退回手机号（未关联到时为空）
    operator: r.operator?.name || r.operator?.phone || null,
    doctorUf: r.doctor_uf != null ? Number(r.doctor_uf) : null,
    status: r.status,
    abortedAt: r.aborted_at != null ? new Date(r.aborted_at).getTime() : null,
    abortTags: Array.isArray(r.abort_tags) ? [...r.abort_tags] : [],
    abortReason: r.abort_reason ?? null,
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

function bloodFlowFromRow(r: any): BloodFlow {
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
    operator_id: null as string | null, // 由 saveSession 填入当前登录用户（见下方说明）
    doctor_uf: s.doctorUf,
    status: s.status,
    aborted_at: s.abortedAt != null ? new Date(s.abortedAt).toISOString() : null,
    abort_tags: s.abortTags ?? [],
    abort_reason: s.abortReason,
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

function bloodFlowToRow(f: BloodFlow) {
  return {
    id: f.id,
    session_id: f.sessionId,
    measured_at: new Date(f.measuredAt).toISOString(),
    value: f.value,
    note: f.note,
  }
}

/**
 * 删除类操作必须 `.select('id')` 把「真正被删掉的行」要回来。
 *
 * 原因：RLS 对无权限的行是**静默过滤**——删除 0 行同样返回 204、error 为 null。
 * 前端如果只看 error，就会把「没删掉」当成「删掉了」：清缓存、跳回首页，
 * 几秒后缓存刷新，记录又「复活」——用户会以为 App 坏了（还会重复操作）。
 */
function assertDeleted(data: { id?: unknown }[] | null, what: string): void {
  if (!data?.length) throw new Error(`${what}失败：可能没有修改权限，或它已被其他人删除`)
}

// ---------- 云端仓储实现 ----------

class CloudRepository implements Repository {
  private client() {
    return requireClient()
  }

  // 读接口统一要检查 error：PostgREST 出错时 data 为 null，若静默当成「没有数据」，
  // 断网/401/超时会显示成「档案和记录全没了」，用户可能因此重建档案或去导入备份，
  // 造成二次伤害。宁可抛错，让页面显示「加载失败 + 重试」。
  async getPatient(id: string) {
    if (!isQueryableId(id)) return undefined
    const { data, error } = await this.client().from('patients').select('*').eq('id', id).maybeSingle()
    if (error) throw error
    return data ? patientFromRow(data) : undefined
  }

  async savePatient(patient: Patient) {
    // 必须 upsert：update 命中 0 行时 PostgREST 不报错（行不存在、或被 RLS 静默过滤），
    // 档案改动会「看起来保存成功但其实没写进去」。其它写方法也都是 upsert，这里保持一致。
    const { error } = await this.client().from('patients').upsert(patientToRow(patient))
    if (error) throw error
  }

  async listDryWeights(patientId: string) {
    if (!isQueryableId(patientId)) return []
    const { data, error } = await this.client()
      .from('dry_weights')
      .select('*')
      .eq('patient_id', patientId)
      .order('effective_date', { ascending: false })
    if (error) throw error
    return (data ?? []).map(dryWeightFromRow)
  }

  async saveDryWeight(dw: DryWeight) {
    const { error } = await this.client().from('dry_weights').upsert(dryWeightToRow(dw))
    if (error) throw error
  }

  async deleteDryWeight(id: string) {
    const { data, error } = await this.client().from('dry_weights').delete().eq('id', id).select('id')
    if (error) throw error
    assertDeleted(data, '删除干体重')
  }

  async listSessions(patientId: string) {
    if (!isQueryableId(patientId)) return []
    const { data, error } = await this.client()
      .from('sessions')
      .select(SESSION_SELECT)
      .eq('patient_id', patientId)
      // 二级排序键 created_at：否则同一天的多条记录在云端与本地（本地按 createdAt 倒序）
      // 的显示顺序会相反，用户会以为记录「跳来跳去」
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
    if (error) throw error
    return (data ?? []).map(sessionFromRow)
  }

  async getSession(id: string) {
    if (!isQueryableId(id)) return undefined
    const { data, error } = await this.client().from('sessions').select(SESSION_SELECT).eq('id', id).maybeSingle()
    // 这里必须区分「查不到」与「查询失败」：调用方（报告页）拿 undefined 会直接跳回首页，
    // 断网时就变成「记录凭空消失」。
    if (error) throw error
    return data ? sessionFromRow(data) : undefined
  }

  async saveSession(session: DialysisSession) {
    const row = sessionToRow(session)
    // 必须写当前用户：schema.sql 的 sessions_insert / sessions_update 策略带
    // `with check (... and operator_id = auth.uid())`，写成别人（哪怕是「保留原记录人」）
    // 都会被 RLS 拒绝，而且 PostgREST 只回 204、前端看不出失败。
    // 副作用：B 编辑 A 创建的记录后，记录人显示名会变成 B（语义偏向「最后修改人」）。
    // 要真正区分「创建人 / 最后修改人」得改数据库（新增列 + 触发器），不能只改前端。
    const {
      data: { user },
    } = await this.client().auth.getUser()
    row.operator_id = user?.id ?? null
    const { error } = await this.client().from('sessions').upsert(row)
    if (error) throw error
  }

  async deleteSession(id: string) {
    // 外键 on delete cascade 自动删除血压/血糖/血流量/不良反应
    const { data, error } = await this.client().from('sessions').delete().eq('id', id).select('id')
    if (error) throw error
    assertDeleted(data, '删除记录')
  }

  async listBloodPressures(sessionId: string) {
    if (!isQueryableId(sessionId)) return []
    const { data, error } = await this.client()
      .from('blood_pressures')
      .select('*')
      .eq('session_id', sessionId)
      .order('measured_at', { ascending: true })
    if (error) throw error
    return (data ?? []).map(bpFromRow)
  }

  async saveBloodPressure(bp: BloodPressure) {
    const { error } = await this.client().from('blood_pressures').upsert(bpToRow(bp))
    if (error) throw error
  }

  async deleteBloodPressure(id: string) {
    const { data, error } = await this.client().from('blood_pressures').delete().eq('id', id).select('id')
    if (error) throw error
    assertDeleted(data, '删除血压')
  }

  async listBloodGlucoses(sessionId: string) {
    if (!isQueryableId(sessionId)) return []
    const { data, error } = await this.client()
      .from('blood_glucoses')
      .select('*')
      .eq('session_id', sessionId)
      .order('measured_at', { ascending: true })
    if (error) throw error
    return (data ?? []).map(bgFromRow)
  }

  async saveBloodGlucose(glucose: BloodGlucose) {
    const { error } = await this.client().from('blood_glucoses').upsert(bgToRow(glucose))
    if (error) throw error
  }

  async deleteBloodGlucose(id: string) {
    const { data, error } = await this.client().from('blood_glucoses').delete().eq('id', id).select('id')
    if (error) throw error
    assertDeleted(data, '删除血糖')
  }

  async listBloodFlows(sessionId: string) {
    if (!isQueryableId(sessionId)) return []
    const { data, error } = await this.client()
      .from('blood_flows')
      .select('*')
      .eq('session_id', sessionId)
      .order('measured_at', { ascending: true })
    if (error) throw error
    return (data ?? []).map(bloodFlowFromRow)
  }

  async saveBloodFlow(flow: BloodFlow) {
    const { error } = await this.client().from('blood_flows').upsert(bloodFlowToRow(flow))
    if (error) throw error
  }

  async deleteBloodFlow(id: string) {
    const { data, error } = await this.client().from('blood_flows').delete().eq('id', id).select('id')
    if (error) throw error
    assertDeleted(data, '删除血流量')
  }

  async listAdverseReactions(sessionId: string) {
    if (!isQueryableId(sessionId)) return []
    const { data, error } = await this.client()
      .from('adverse_reactions')
      .select('*')
      .eq('session_id', sessionId)
      .order('recorded_at', { ascending: true })
    if (error) throw error
    return (data ?? []).map(reactionFromRow)
  }

  async replaceAdverseReactions(sessionId: string, reactions: AdverseReaction[]) {
    const client = this.client()

    // 顺序很关键：先查旧 id → 再写新数据 → 最后删掉「旧的但这次不在列表里」的。
    // 反过来做（先 delete 再 insert）会在 insert 失败时把原有不良反应整批丢掉。
    const { data: existing, error: readErr } = await client
      .from('adverse_reactions')
      .select('id')
      .eq('session_id', sessionId)
    if (readErr) throw readErr

    if (reactions.length) {
      const { error: upsertErr } = await client.from('adverse_reactions').upsert(reactions.map(reactionToRow))
      if (upsertErr) throw upsertErr
    }

    const keep = new Set(reactions.map((r) => r.id))
    const removeIds = (existing ?? []).map((r: { id: string }) => r.id).filter((id: string) => !keep.has(id))
    if (removeIds.length) {
      const { error: delErr } = await client.from('adverse_reactions').delete().in('id', removeIds)
      if (delErr) throw delErr
    }
  }

  async exportAll() {
    const client = this.client()
    const [patients, dryWeights, sessions, bps, bgs, bfs, reactions] = await Promise.all([
      client.from('patients').select('*'),
      client.from('dry_weights').select('*'),
      client.from('sessions').select(SESSION_SELECT),
      client.from('blood_pressures').select('*'),
      client.from('blood_glucoses').select('*'),
      client.from('blood_flows').select('*'),
      client.from('adverse_reactions').select('*'),
    ])
    // 必须逐个检查：任何一张表查询失败都会让导出静默变成「空备份」，
    // 用户拿着一个空文件以为备份好了 —— 等真需要恢复时才发现什么都没存下。
    const parts: [string, { error: { message: string } | null }][] = [
      ['病人档案', patients],
      ['干体重', dryWeights],
      ['透析记录', sessions],
      ['血压', bps],
      ['血糖', bgs],
      ['血流量', bfs],
      ['不良反应', reactions],
    ]
    for (const [label, res] of parts) {
      if (res.error) throw new Error(`导出失败（${label}）：${res.error.message}`)
    }
    // 导出为与本地模式一致的领域对象格式，便于跨模式备份/恢复
    return JSON.stringify(
      {
        version: 1,
        exportedAt: Date.now(),
        patients: (patients.data ?? []).map(patientFromRow),
        dryWeights: (dryWeights.data ?? []).map(dryWeightFromRow),
        sessions: (sessions.data ?? []).map(sessionFromRow),
        bloodPressures: (bps.data ?? []).map(bpFromRow),
        bloodGlucoses: (bgs.data ?? []).map(bgFromRow),
        bloodFlows: (bfs.data ?? []).map(bloodFlowFromRow),
        adverseReactions: (reactions.data ?? []).map(reactionFromRow),
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

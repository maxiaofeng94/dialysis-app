export type SessionStatus = 'ongoing' | 'completed' | 'aborted'
export type ReactionSeverity = 'mild' | 'moderate' | 'severe'

export interface Patient {
  id: string
  name: string
  birthday: string
  wheelchairWeight: number
  rinseBackVolume: number
  createdAt: number
  updatedAt: number
  /** 云端原始 `updated_at`（ISO），乐观锁用；含义同 DialysisSession.updatedAtIso */
  updatedAtIso?: string | null
}

export interface DryWeight {
  id: string
  patientId: string
  value: number
  effectiveDate: string
  note: string | null
  createdAt: number
  updatedAt: number
}

export interface DialysisSession {
  id: string
  patientId: string
  date: string
  preWeightMeasured: number | null
  postWeightMeasured: number | null
  wheelchairWeightUsed: number
  rinseBackVolumeUsed: number
  operator: string | null
  doctorUf: number | null
  status: SessionStatus
  /** 中止时间（毫秒时间戳），status === 'aborted' 时有效 */
  abortedAt: number | null
  /** 中止原因快捷标签（ABORT_REASONS 的 key） */
  abortTags: string[]
  /** 中止原因补充描述 */
  abortReason: string | null
  notes: string | null
  createdAt: number
  updatedAt: number
  /**
   * 云端行的原始 `updated_at`（ISO 字符串；仅云端模式有值）。
   *
   * **乐观锁的版本号**：多人同时编辑同一条记录时，保存要带上「我读到的版本」，
   * 服务端只在它没变时才允许覆盖。
   *
   * ⚠️ 必须原样回传库里的字符串，不能拿 `updatedAt`（毫秒时间戳）重新拼 ——
   * `timestamptz` 是微秒精度，转成毫秒再传回去会永远匹配不上，变成「永远冲突」。
   */
  updatedAtIso?: string | null
}

export interface BloodPressure {
  id: string
  sessionId: string
  measuredAt: number
  systolic: number
  diastolic: number
  /**
   * 心率（bpm）。**选填**：老数据与老备份都没有这个字段，读取时统一兜底成 null。
   * 不做「偏高 / 偏低」判定 —— 透析患者心率受用药影响大，打红绿标签容易误导，
   * 只如实记录数值（血压才做评估，因为它是核心监测指标）。
   */
  pulse: number | null
  note: string | null
}

export interface BloodGlucose {
  id: string
  sessionId: string
  measuredAt: number
  value: number
  note: string | null
}

export interface BloodFlow {
  id: string
  sessionId: string
  measuredAt: number
  value: number
  note: string | null
}

export interface AdverseReaction {
  id: string
  sessionId: string
  type: string
  detail: string | null
  severity: ReactionSeverity | null
  recordedAt: number
}

/** 病人配置里允许留痕的字段（目前只有「轮椅及衣物重量」） */
export type PatientChangeField = 'wheelchairWeight'

/**
 * 病人配置变更记录。
 *
 * 为什么单独建表而不是复用后台的 `admin_audit_logs`：那张表只记「管理员在后台改了什么」，
 * 而且 RLS 只给管理员读 —— App 端用户看不到，等于没有留痕。
 *
 * 语义：**只追加、不可改不可删**（数据库层不建 update/delete 策略），
 * 所以「谁在什么时候把轮椅及衣物重量从多少改成了多少」永远查得到。
 */
export interface PatientChangeLog {
  id: string
  patientId: string
  field: PatientChangeField
  oldValue: number | null
  newValue: number | null
  /** 变更人显示名（变更当时读取的姓名，与记录人同一个口径；本地单机模式为 null） */
  operator: string | null
  changedAt: number
}

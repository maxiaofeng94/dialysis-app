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

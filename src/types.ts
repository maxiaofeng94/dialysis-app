export type SessionStatus = 'ongoing' | 'completed'
export type ReactionSeverity = 'mild' | 'moderate' | 'severe'

export interface Patient {
  id: string
  name: string
  birthday: string
  wheelchairWeight: number
  rinseBackVolume: number
  createdAt: number
  updatedAt: number
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
  notes: string | null
  createdAt: number
  updatedAt: number
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

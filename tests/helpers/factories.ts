/**
 * 领域对象工厂：测试数据统一从这里造，避免各测试文件里手写一大坨字段。
 * 默认值贴近真实数据（轮椅 20kg、回水 300ml），需要边界值时用参数覆盖。
 */
import type {
  Patient,
  DryWeight,
  DialysisSession,
  BloodPressure,
  BloodGlucose,
  BloodFlow,
  AdverseReaction,
} from '../../src/types'

let seq = 0
/** 稳定的自增后缀，保证同一测试内 id 不重复且可预期 */
export function nextId(prefix = 'id'): string {
  seq += 1
  return `${prefix}-${seq}`
}

export function resetIdSeq(): void {
  seq = 0
}

export function makePatient(patch: Partial<Patient> = {}): Patient {
  return {
    id: patch.id ?? nextId('patient'),
    name: '张三',
    birthday: '1950-06-01',
    wheelchairWeight: 20,
    rinseBackVolume: 300,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...patch,
  }
}

export function makeDryWeight(patch: Partial<DryWeight> = {}): DryWeight {
  return {
    id: patch.id ?? nextId('dry'),
    patientId: 'patient-1',
    value: 60,
    effectiveDate: '2024-01-01',
    note: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...patch,
  }
}

export function makeSession(patch: Partial<DialysisSession> = {}): DialysisSession {
  return {
    id: patch.id ?? nextId('session'),
    patientId: 'patient-1',
    date: '2024-01-10',
    preWeightMeasured: 80,
    postWeightMeasured: null,
    wheelchairWeightUsed: 20,
    rinseBackVolumeUsed: 300,
    operator: null,
    doctorUf: null,
    status: 'ongoing',
    abortedAt: null,
    abortTags: [],
    abortReason: null,
    notes: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...patch,
  }
}

export function makeBp(patch: Partial<BloodPressure> = {}): BloodPressure {
  return {
    id: patch.id ?? nextId('bp'),
    sessionId: 'session-1',
    measuredAt: 1_700_000_100_000,
    systolic: 130,
    diastolic: 80,
    note: null,
    ...patch,
  }
}

export function makeBg(patch: Partial<BloodGlucose> = {}): BloodGlucose {
  return {
    id: patch.id ?? nextId('bg'),
    sessionId: 'session-1',
    measuredAt: 1_700_000_100_000,
    value: 6.5,
    note: null,
    ...patch,
  }
}

export function makeBf(patch: Partial<BloodFlow> = {}): BloodFlow {
  return {
    id: patch.id ?? nextId('bf'),
    sessionId: 'session-1',
    measuredAt: 1_700_000_100_000,
    value: 250,
    note: null,
    ...patch,
  }
}

export function makeReaction(patch: Partial<AdverseReaction> = {}): AdverseReaction {
  return {
    id: patch.id ?? nextId('ar'),
    sessionId: 'session-1',
    type: 'cramp',
    detail: null,
    severity: 'mild',
    recordedAt: 1_700_000_100_000,
    ...patch,
  }
}

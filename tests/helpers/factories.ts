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
  PatientChangeLog,
} from '../../src/types'
import { DEFAULT_PATIENT_ID } from '../../src/constants'

/**
 * 测试数据的「当前病人 id」。
 *
 * 统一用真实的 `DEFAULT_PATIENT_ID`（`patient-default`），**不要**各自写 `patient-1`：
 * 页面测试里 `currentPatientId` mock 成 `patient-default`，而记录/子表的 `patientId`
 * 若写成 `patient-1`，两者就对不上 —— 那是**真实数据里不可能出现的状态**。
 * 本轮 `resolveEffectiveConfig` / `snapshotConfigInto` 加了归属校验后，这种不一致
 * 会让校验一律走回退分支，十几个用例集体变红（不是校验写错了，是 fixture 假）。
 */
export const TEST_PATIENT_ID = DEFAULT_PATIENT_ID

let seq = 0
/** 稳定的自增后缀，保证同一测试内 id 不重复且可预期 */
export function nextId(prefix = 'id'): string {
  seq += 1
  return `${prefix}-${seq}`
}

export function resetIdSeq(): void {
  seq = 0
}

/**
 * 病人档案。
 *
 * ⚠️ 默认 id 必须是 `TEST_PATIENT_ID`（= 真实的 `DEFAULT_PATIENT_ID`），与
 * `makeSession` / 子表工厂的 `patientId` 保持一致 —— 两者对不上时，真实的
 * 「记录属于哪个病人」这层关系在测试数据里是断的：`resolveEffectiveConfig` /
 * `snapshotConfigInto` 的归属校验会一律走回退分支，「进行中跟随当前档案」全部失效。
 * 需要多个病人时显式传 id。
 */
export function makePatient(patch: Partial<Patient> = {}): Patient {
  return {
    id: patch.id ?? TEST_PATIENT_ID,
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
    patientId: TEST_PATIENT_ID,
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
    patientId: TEST_PATIENT_ID,
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
    // 心率默认 null（选填字段）：老数据与「用户没填」都是这个值，
    // 需要心率的用例显式传 pulse
    pulse: null,
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

export function makeChangeLog(patch: Partial<PatientChangeLog> = {}): PatientChangeLog {
  return {
    id: patch.id ?? nextId('pcl'),
    patientId: TEST_PATIENT_ID,
    field: 'wheelchairWeight',
    oldValue: 13.4,
    newValue: 13.5,
    operator: '张三',
    changedAt: 1_700_000_100_000,
    ...patch,
  }
}

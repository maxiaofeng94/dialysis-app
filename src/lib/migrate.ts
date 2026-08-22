import { DEFAULT_PATIENT_ID } from '../constants'
import { localRepository } from '../repo/localRepository'
import { createPatient } from './cloudAdmin'
import { repository } from '../repo'
import { uuid } from '../utils/id'

/**
 * 把本机本地数据（IndexedDB）迁移到云端：
 * 1. 用本地病人档案在云端新建病人（调用者成为 owner）；
 * 2. 迁移干体重、透析记录及血压/血糖/不良反应（重新生成 id，关联到新病人/新会话）。
 */
export async function migrateLocalToCloud(): Promise<{ ok: boolean; message: string }> {
  const patient = await localRepository.getPatient(DEFAULT_PATIENT_ID)
  if (!patient) return { ok: false, message: '本机没有病人数据' }

  const res = await createPatient(patient.name, patient.wheelchairWeight, patient.rinseBackVolume)
  if (!res.ok || !res.data?.patient?.id) {
    return { ok: false, message: res.data?.error ?? '创建云端病人失败' }
  }
  const newPatientId = res.data.patient.id

  // 干体重
  const dryWeights = await localRepository.listDryWeights(DEFAULT_PATIENT_ID)
  for (const d of dryWeights) {
    await repository.saveDryWeight({ ...d, id: uuid(), patientId: newPatientId })
  }

  // 透析记录 + 子数据
  const sessions = await localRepository.listSessions(DEFAULT_PATIENT_ID)
  for (const s of sessions) {
    const newSessionId = uuid()
    const { id: _oldId, ...rest } = s
    await repository.saveSession({ ...rest, id: newSessionId, patientId: newPatientId })

    for (const b of await localRepository.listBloodPressures(s.id)) {
      await repository.saveBloodPressure({ ...b, id: uuid(), sessionId: newSessionId })
    }
    for (const g of await localRepository.listBloodGlucoses(s.id)) {
      await repository.saveBloodGlucose({ ...g, id: uuid(), sessionId: newSessionId })
    }
    const ars = await localRepository.listAdverseReactions(s.id)
    await repository.replaceAdverseReactions(
      newSessionId,
      ars.map((a) => ({ ...a, id: uuid(), sessionId: newSessionId })),
    )
  }

  return { ok: true, message: `已迁移 ${sessions.length} 条透析记录到云端` }
}

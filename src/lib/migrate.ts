import { DEFAULT_PATIENT_ID } from '../constants'
import { localRepository } from '../repo/localRepository'
import { createPatient } from './cloudAdmin'
import { repository } from '../repo'
import { uuid } from '../utils/id'

/**
 * 把本机本地数据（IndexedDB）迁移到云端：
 * 1. 用本地病人档案在云端新建病人（调用者成为 owner）；
 * 2. 迁移干体重、透析记录及血压/血糖/血流量/不良反应（重新生成 id，关联到新病人/新会话）。
 *
 * 注意：**没有幂等保护** —— 每调用一次就会在云端新建一个病人。调用方必须自己防重复点击，
 * 并在成功后用返回的 `patientId` 把「当前病人」切过去（否则界面上看到的还是本地那个旧病人）。
 */
export async function migrateLocalToCloud(): Promise<{ ok: boolean; message: string; patientId?: string }> {
  try {
    return await runMigration()
  } catch (err) {
    // 中途失败会留下「半个病人」（已建的病人 + 部分记录），这里至少要把原因说清楚，
    // 而不是抛一个用户看不懂的异常。
    return {
      ok: false,
      message: err instanceof Error ? `迁移中断：${err.message}` : '迁移中断，请检查网络后重试',
    }
  }
}

async function runMigration(): Promise<{ ok: boolean; message: string; patientId?: string }> {
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
    for (const f of await localRepository.listBloodFlows(s.id)) {
      await repository.saveBloodFlow({ ...f, id: uuid(), sessionId: newSessionId })
    }
    const ars = await localRepository.listAdverseReactions(s.id)
    await repository.replaceAdverseReactions(
      newSessionId,
      ars.map((a) => ({ ...a, id: uuid(), sessionId: newSessionId })),
    )
  }

  return { ok: true, message: `已迁移 ${sessions.length} 条透析记录到云端`, patientId: newPatientId }
}

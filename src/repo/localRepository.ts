import { db } from '../db/database'
import type { Repository } from './repository'
import type { Patient, DryWeight, DialysisSession, BloodPressure, BloodGlucose, BloodFlow, AdverseReaction } from '../types'

/** 兼容旧数据（旧版本无中止相关字段）与外部导入数据 */
function normalizeSession(s: DialysisSession): DialysisSession {
  return {
    ...s,
    status: s.status ?? 'ongoing',
    abortedAt: s.abortedAt ?? null,
    abortTags: Array.isArray(s.abortTags) ? [...s.abortTags] : [],
    abortReason: s.abortReason ?? null,
  }
}

interface BackupData {
  version?: number
  patients?: Patient[]
  dryWeights?: DryWeight[]
  sessions?: DialysisSession[]
  bloodPressures?: BloodPressure[]
  bloodGlucoses?: BloodGlucose[]
  bloodFlows?: BloodFlow[]
  adverseReactions?: AdverseReaction[]
}

const BACKUP_TABLES = [
  'patients',
  'dryWeights',
  'sessions',
  'bloodPressures',
  'bloodGlucoses',
  'bloodFlows',
  'adverseReactions',
] as const

/**
 * 导入前把整份备份校验一遍。
 *
 * 为什么要先校验：导入是「先清空、再写入」的操作，如果等到写第一张表时才失败，
 * 本机原有数据已经被清掉了 —— 用户只会看到「文件格式不正确」，但数据已经没了。
 * 所以这里宁可在动手之前就整体拒绝。
 */
function validateBackup(data: unknown): asserts data is BackupData {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('备份文件格式不正确：顶层不是对象')
  }
  const d = data as BackupData & Record<string, unknown>
  if (d.version != null) {
    const version = Number(d.version)
    if (!Number.isFinite(version)) {
      throw new Error(`备份文件格式不正确：version 不是数字（${String(d.version)}）`)
    }
    if (version > 1) {
      throw new Error(`备份文件版本（${version}）比当前版本新，请先升级 App 再导入`)
    }
  }
  for (const table of BACKUP_TABLES) {
    const rows = d[table]
    if (rows == null) continue // 允许只含部分表的备份（例如别人手工整理过的）
    if (!Array.isArray(rows)) throw new Error(`备份文件格式不正确：${table} 不是数组`)
    rows.forEach((row, i) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`备份文件格式不正确：${table} 第 ${i + 1} 条不是对象`)
      }
      const id = (row as { id?: unknown }).id
      if (typeof id !== 'string' || !id) {
        throw new Error(`备份文件格式不正确：${table} 第 ${i + 1} 条缺少 id`)
      }
    })
  }
}

class LocalRepository implements Repository {
  getPatient(id: string) {
    return db.patients.get(id)
  }
  async savePatient(patient: Patient) {
    await db.patients.put({ ...patient })
  }

  async listDryWeights(patientId: string) {
    const list = await db.dryWeights.where('patientId').equals(patientId).toArray()
    return list.sort((a, b) =>
      a.effectiveDate < b.effectiveDate ? 1 : a.effectiveDate > b.effectiveDate ? -1 : b.createdAt - a.createdAt,
    )
  }
  async saveDryWeight(dryWeight: DryWeight) {
    await db.dryWeights.put({ ...dryWeight })
  }
  async deleteDryWeight(id: string) {
    await db.dryWeights.delete(id)
  }

  async listSessions(patientId: string) {
    const list = (await db.sessions.where('patientId').equals(patientId).toArray()).map(normalizeSession)
    return list.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1
      return b.createdAt - a.createdAt
    })
  }
  async getSession(id: string) {
    const s = await db.sessions.get(id)
    return s ? normalizeSession(s) : undefined
  }
  async saveSession(session: DialysisSession) {
    await db.sessions.put({ ...normalizeSession(session) })
  }
  async deleteSession(id: string) {
    await db.transaction('rw', db.sessions, db.bloodPressures, db.bloodGlucoses, db.bloodFlows, db.adverseReactions, async () => {
      await db.bloodPressures.where('sessionId').equals(id).delete()
      await db.bloodGlucoses.where('sessionId').equals(id).delete()
      await db.bloodFlows.where('sessionId').equals(id).delete()
      await db.adverseReactions.where('sessionId').equals(id).delete()
      await db.sessions.delete(id)
    })
  }

  async listBloodPressures(sessionId: string) {
    const list = await db.bloodPressures.where('sessionId').equals(sessionId).toArray()
    return list.sort((a, b) => a.measuredAt - b.measuredAt)
  }
  async saveBloodPressure(bp: BloodPressure) {
    await db.bloodPressures.put({ ...bp })
  }
  async deleteBloodPressure(id: string) {
    await db.bloodPressures.delete(id)
  }

  async listBloodGlucoses(sessionId: string) {
    const list = await db.bloodGlucoses.where('sessionId').equals(sessionId).toArray()
    return list.sort((a, b) => a.measuredAt - b.measuredAt)
  }
  async saveBloodGlucose(glucose: BloodGlucose) {
    await db.bloodGlucoses.put({ ...glucose })
  }
  async deleteBloodGlucose(id: string) {
    await db.bloodGlucoses.delete(id)
  }

  async listBloodFlows(sessionId: string) {
    const list = await db.bloodFlows.where('sessionId').equals(sessionId).toArray()
    return list.sort((a, b) => a.measuredAt - b.measuredAt)
  }
  async saveBloodFlow(flow: BloodFlow) {
    await db.bloodFlows.put({ ...flow })
  }
  async deleteBloodFlow(id: string) {
    await db.bloodFlows.delete(id)
  }

  async listAdverseReactions(sessionId: string) {
    const list = await db.adverseReactions.where('sessionId').equals(sessionId).toArray()
    return list.sort((a, b) => a.recordedAt - b.recordedAt)
  }
  async replaceAdverseReactions(sessionId: string, reactions: AdverseReaction[]) {
    await db.transaction('rw', db.adverseReactions, async () => {
      await db.adverseReactions.where('sessionId').equals(sessionId).delete()
      await db.adverseReactions.bulkPut(reactions)
    })
  }

  async exportAll() {
    const data = {
      version: 1,
      exportedAt: Date.now(),
      patients: await db.patients.toArray(),
      dryWeights: await db.dryWeights.toArray(),
      sessions: (await db.sessions.toArray()).map(normalizeSession),
      bloodPressures: await db.bloodPressures.toArray(),
      bloodGlucoses: await db.bloodGlucoses.toArray(),
      bloodFlows: await db.bloodFlows.toArray(),
      adverseReactions: await db.adverseReactions.toArray(),
    }
    return JSON.stringify(data, null, 2)
  }
  async importAll(json: string) {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      throw new Error('备份文件不是合法的 JSON')
    }
    // 先整体校验：这一步抛错时，本机数据一个字节都没动
    validateBackup(parsed)
    const data = parsed

    // 清空 + 写入放在同一个事务里：中途失败会整体回滚，不会留下「清了一半」的库
    await db.transaction(
      'rw',
      [db.patients, db.dryWeights, db.sessions, db.bloodPressures, db.bloodGlucoses, db.bloodFlows, db.adverseReactions],
      async () => {
        await db.patients.clear()
        await db.dryWeights.clear()
        await db.sessions.clear()
        await db.bloodPressures.clear()
        await db.bloodGlucoses.clear()
        await db.bloodFlows.clear()
        await db.adverseReactions.clear()
        await db.patients.bulkPut(data.patients ?? [])
        await db.dryWeights.bulkPut(data.dryWeights ?? [])
        await db.sessions.bulkPut((data.sessions ?? []).map(normalizeSession))
        await db.bloodPressures.bulkPut(data.bloodPressures ?? [])
        await db.bloodGlucoses.bulkPut(data.bloodGlucoses ?? [])
        await db.bloodFlows.bulkPut(data.bloodFlows ?? [])
        await db.adverseReactions.bulkPut(data.adverseReactions ?? [])
      },
    )
  }
}

export const localRepository: Repository = new LocalRepository()

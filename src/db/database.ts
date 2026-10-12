import Dexie, { type Table } from 'dexie'
import type { Patient, DryWeight, DialysisSession, BloodPressure, BloodGlucose, BloodFlow, AdverseReaction } from '../types'

export class DialysisDB extends Dexie {
  patients!: Table<Patient, string>
  dryWeights!: Table<DryWeight, string>
  sessions!: Table<DialysisSession, string>
  bloodPressures!: Table<BloodPressure, string>
  bloodGlucoses!: Table<BloodGlucose, string>
  bloodFlows!: Table<BloodFlow, string>
  adverseReactions!: Table<AdverseReaction, string>

  constructor() {
    super('dialysis-db')
    this.version(2).stores({
      patients: 'id, createdAt',
      dryWeights: 'id, patientId, [patientId+effectiveDate]',
      sessions: 'id, patientId, date, [patientId+date], [patientId+createdAt]',
      bloodPressures: 'id, sessionId',
      bloodGlucoses: 'id, sessionId',
      bloodFlows: 'id, sessionId',
      adverseReactions: 'id, sessionId',
    })

    // 另一个标签页要求升级数据库版本时，必须主动让路：
    // 旧连接不让位的话，新页面会一直停在 Dexie 的 `blocked` 状态 ——
    // open() 既不 resolve 也不 reject，所有表操作全部 pending，
    // 于是「缓存优先」的每个页面都永久骨架、连 catch 都进不去（web 端多标签页时会遇到）。
    this.on('versionchange', () => {
      this.close()
    })
  }
}

export const db = new DialysisDB()

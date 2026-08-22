import Dexie, { type Table } from 'dexie'
import type { Patient, DryWeight, DialysisSession, BloodPressure, BloodGlucose, AdverseReaction } from '../types'

export class DialysisDB extends Dexie {
  patients!: Table<Patient, string>
  dryWeights!: Table<DryWeight, string>
  sessions!: Table<DialysisSession, string>
  bloodPressures!: Table<BloodPressure, string>
  bloodGlucoses!: Table<BloodGlucose, string>
  adverseReactions!: Table<AdverseReaction, string>

  constructor() {
    super('dialysis-db')
    this.version(1).stores({
      patients: 'id, createdAt',
      dryWeights: 'id, patientId, [patientId+effectiveDate]',
      sessions: 'id, patientId, date, [patientId+date], [patientId+createdAt]',
      bloodPressures: 'id, sessionId',
      bloodGlucoses: 'id, sessionId',
      adverseReactions: 'id, sessionId',
    })
  }
}

export const db = new DialysisDB()

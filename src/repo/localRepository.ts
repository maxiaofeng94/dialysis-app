import { db } from '../db/database'
import type { Repository } from './repository'
import type { Patient, DryWeight, DialysisSession, BloodPressure, BloodGlucose, AdverseReaction } from '../types'

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
    const list = await db.sessions.where('patientId').equals(patientId).toArray()
    return list.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1
      return b.createdAt - a.createdAt
    })
  }
  getSession(id: string) {
    return db.sessions.get(id)
  }
  async saveSession(session: DialysisSession) {
    await db.sessions.put({ ...session })
  }
  async deleteSession(id: string) {
    await db.transaction('rw', db.sessions, db.bloodPressures, db.bloodGlucoses, db.adverseReactions, async () => {
      await db.bloodPressures.where('sessionId').equals(id).delete()
      await db.bloodGlucoses.where('sessionId').equals(id).delete()
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
      sessions: await db.sessions.toArray(),
      bloodPressures: await db.bloodPressures.toArray(),
      bloodGlucoses: await db.bloodGlucoses.toArray(),
      adverseReactions: await db.adverseReactions.toArray(),
    }
    return JSON.stringify(data, null, 2)
  }
  async importAll(json: string) {
    const data = JSON.parse(json) as {
      patients?: Patient[]
      dryWeights?: DryWeight[]
      sessions?: DialysisSession[]
      bloodPressures?: BloodPressure[]
      bloodGlucoses?: BloodGlucose[]
      adverseReactions?: AdverseReaction[]
    }
    await db.patients.clear()
    await db.dryWeights.clear()
    await db.sessions.clear()
    await db.bloodPressures.clear()
    await db.bloodGlucoses.clear()
    await db.adverseReactions.clear()
    await db.patients.bulkPut(data.patients ?? [])
    await db.dryWeights.bulkPut(data.dryWeights ?? [])
    await db.sessions.bulkPut(data.sessions ?? [])
    await db.bloodPressures.bulkPut(data.bloodPressures ?? [])
    await db.bloodGlucoses.bulkPut(data.bloodGlucoses ?? [])
    await db.adverseReactions.bulkPut(data.adverseReactions ?? [])
  }
}

export const localRepository: Repository = new LocalRepository()

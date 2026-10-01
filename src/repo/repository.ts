import type { Patient, DryWeight, DialysisSession, BloodPressure, BloodGlucose, BloodFlow, AdverseReaction } from '../types'

export interface Repository {
  getPatient(id: string): Promise<Patient | undefined>
  savePatient(patient: Patient): Promise<void>

  listDryWeights(patientId: string): Promise<DryWeight[]>
  saveDryWeight(dryWeight: DryWeight): Promise<void>
  deleteDryWeight(id: string): Promise<void>

  listSessions(patientId: string): Promise<DialysisSession[]>
  getSession(id: string): Promise<DialysisSession | undefined>
  saveSession(session: DialysisSession): Promise<void>
  deleteSession(id: string): Promise<void>

  listBloodPressures(sessionId: string): Promise<BloodPressure[]>
  saveBloodPressure(bp: BloodPressure): Promise<void>
  deleteBloodPressure(id: string): Promise<void>

  listBloodGlucoses(sessionId: string): Promise<BloodGlucose[]>
  saveBloodGlucose(glucose: BloodGlucose): Promise<void>
  deleteBloodGlucose(id: string): Promise<void>

  listBloodFlows(sessionId: string): Promise<BloodFlow[]>
  saveBloodFlow(flow: BloodFlow): Promise<void>
  deleteBloodFlow(id: string): Promise<void>

  listAdverseReactions(sessionId: string): Promise<AdverseReaction[]>
  replaceAdverseReactions(sessionId: string, reactions: AdverseReaction[]): Promise<void>

  exportAll(): Promise<string>
  importAll(json: string): Promise<void>
}

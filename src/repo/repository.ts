import type { Patient, DryWeight, DialysisSession, BloodPressure, BloodGlucose, BloodFlow, AdverseReaction } from '../types'

export interface Repository {
  getPatient(id: string): Promise<Patient | undefined>
  savePatient(patient: Patient): Promise<void>

  listDryWeights(patientId: string): Promise<DryWeight[]>
  saveDryWeight(dryWeight: DryWeight): Promise<void>
  deleteDryWeight(id: string): Promise<void>

  listSessions(patientId: string): Promise<DialysisSession[]>
  getSession(id: string): Promise<DialysisSession | undefined>
  /**
   * 保存一条透析记录（整行覆盖）。
   *
   * **乐观锁**：多人可能同时编辑同一个病人的同一条记录，整行覆盖会「后保存的把先保存的抹掉」
   * 且双方都毫无察觉。`expectedUpdatedAt` 传「我读到的版本」（`DialysisSession.updatedAtIso`），
   * 云端只在库里的版本仍是它时才允许写入；否则抛 `ConflictError`，由页面询问用户
   * 「重新加载」还是「覆盖保存」。
   *
   * - `expectedUpdatedAt` 省略/为 null：不做版本检查（新建记录，以及本地单机模式）
   * - 返回值：写入后的新版本（`updatedAtIso`），调用方必须用它更新本地版本，
   *   否则下一次保存会拿旧版本去比 → 自己跟自己冲突
   */
  saveSession(session: DialysisSession, expectedUpdatedAt?: string | null): Promise<string | null>
  deleteSession(id: string): Promise<void>

  listBloodPressures(sessionId: string): Promise<BloodPressure[]>
  /**
   * 批量拉取多条记录的血压（趋势页用）。
   *
   * 逐条 `listBloodPressures` 的话，「最近 30 条记录」就是 30 次往返 ——
   * 血压 + 血糖 = 60 个请求，弱网下首屏要等几十秒，还会把请求风暴放大。
   */
  listBloodPressuresMany(sessionIds: string[]): Promise<BloodPressure[]>
  saveBloodPressure(bp: BloodPressure): Promise<void>
  deleteBloodPressure(id: string): Promise<void>

  listBloodGlucoses(sessionId: string): Promise<BloodGlucose[]>
  /** 批量拉取多条记录的血糖（趋势页用），理由同 listBloodPressuresMany */
  listBloodGlucosesMany(sessionIds: string[]): Promise<BloodGlucose[]>
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

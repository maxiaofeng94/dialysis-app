import type { Patient, DryWeight, DialysisSession, BloodPressure, BloodGlucose, BloodFlow, AdverseReaction } from '../types'

export interface Repository {
  /** 读病人档案；`opts.fresh` 含义同 `getSession`（乐观锁冲突后重新加载要用） */
  getPatient(id: string, opts?: { fresh?: boolean }): Promise<Patient | undefined>
  /**
   * 保存病人档案（轮椅重量 / 回水量 / 姓名 / 生日，**整行覆盖**）。
   *
   * 乐观锁的用法与 `saveSession` 完全一致：`expectedUpdatedAt` 传
   * `Patient.updatedAtIso`，只有库里的版本没变时才写入，否则抛 `ConflictError`。
   * 两人同时改档案时，后保存的人不会静默抹掉对方刚改的轮椅重量。
   */
  savePatient(patient: Patient, expectedUpdatedAt?: string | null): Promise<string | null>

  listDryWeights(patientId: string): Promise<DryWeight[]>
  saveDryWeight(dryWeight: DryWeight): Promise<void>
  deleteDryWeight(id: string): Promise<void>

  listSessions(patientId: string): Promise<DialysisSession[]>
  /**
   * 读一条透析记录。
   *
   * `opts.fresh` = true 时**跳过本地缓存直接读云端**：乐观锁冲突后的「重新加载」必须用它 ——
   * 缓存里存的正是冲突前那份旧数据，照常走缓存会让用户以为对方根本没改过
   * （实测踩到：提示「已被其他人修改」后重新加载，看到的还是自己原来的内容）。
   */
  getSession(id: string, opts?: { fresh?: boolean }): Promise<DialysisSession | undefined>
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

  /** 读一条记录的不良反应；`opts.fresh` 含义同 `getSession`（冲突后重新加载要用） */
  listAdverseReactions(sessionId: string, opts?: { fresh?: boolean }): Promise<AdverseReaction[]>
  /**
   * 整表替换一条记录的不良反应。
   *
   * **乐观锁**：这个接口的语义是「列表之外的全删」，两个家属各勾一项时，
   * 后保存的人会把先保存的人勾的那项当成「已被取消」删掉（前端串行化只能防同一台设备）。
   * `expectedIds` 传「我打开页面时读到的全部 id」，云端比对现在库里的 id 集合，
   * 不一致就抛 `ConflictError`。
   */
  replaceAdverseReactions(
    sessionId: string,
    reactions: AdverseReaction[],
    expectedIds?: string[],
  ): Promise<void>

  exportAll(): Promise<string>
  importAll(json: string): Promise<void>
}

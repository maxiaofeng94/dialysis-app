import type { DialysisSession, DryWeight, Patient } from '../types'

export interface SessionComputed {
  preWeightActual: number | null
  postWeightActual: number | null
  effectiveDryWeight: number | null
  planUf: number | null
  actualUf: number | null
  rinseBackMl: number
  machineUf: number | null
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/**
 * 脱水量在界面上永远是「脱掉多少」，不能是负数。
 * 上机前体重低于干体重时（称重忘了扣轮椅、或干体重填错），算式会得出 -20 之类的值，
 * 界面上显示「计划脱水 -20.0 L」会被家属读成「要往身体里输 20 升」。
 * 所以三个脱水量统一按 0 兜底（体重本身不钳制：那是原始测量值，要照实显示）。
 */
function nonNegative(n: number): number {
  return round1(Math.max(0, n))
}

/** 取某日期 D 的有效干体重：生效日期 <= D 的最新一条；若全部晚于 D，取最早生效的一条兜底 */
export function getEffectiveDryWeight(dryWeights: DryWeight[], date: string): number | null {
  if (!dryWeights.length) return null
  const sorted = [...dryWeights].sort((a, b) => {
    if (a.effectiveDate === b.effectiveDate) return b.createdAt - a.createdAt
    return a.effectiveDate < b.effectiveDate ? 1 : -1
  })
  const onOrBefore = sorted.find((d) => d.effectiveDate <= date)
  if (onOrBefore) return onOrBefore.value
  return sorted[sorted.length - 1].value
}

export function calcWeights(
  preMeasured: number | null,
  postMeasured: number | null,
  wheelchairWeight: number,
  rinseMl: number,
  dry: number | null,
): SessionComputed {
  const preWeightActual = preMeasured != null ? round1(preMeasured - wheelchairWeight) : null
  const postWeightActual = postMeasured != null ? round1(postMeasured - wheelchairWeight) : null
  const planUf = preWeightActual != null && dry != null ? nonNegative(preWeightActual - dry) : null
  const actualUf =
    preWeightActual != null && postWeightActual != null
      ? nonNegative(preWeightActual - postWeightActual)
      : null
  const machineUf = planUf != null ? nonNegative(planUf + rinseMl / 1000) : null
  return {
    preWeightActual,
    postWeightActual,
    effectiveDryWeight: dry,
    planUf,
    actualUf,
    rinseBackMl: rinseMl,
    machineUf,
  }
}

export interface EffectiveConfig {
  /** 本次计算实际使用的「轮椅及衣物重量」（kg） */
  wheelchairWeight: number
  /** 本次计算实际使用的回水量（ml） */
  rinseMl: number
  /**
   * 这个值是不是**实时取自病人档案**（而不是记录里的快照）。
   *
   * true = 记录还在进行中，界面应当提示「按当前档案计算」——
   * 否则用户改了档案、看到详情页的数变了，会以为历史上所有的记录都被改掉了。
   */
  fromPatientProfile: boolean
}

/**
 * 解析一条记录**当前应使用的**轮椅及衣物重量与回水量。
 *
 * 需求背景（用户真实场景）：天气转冷后加了衣服，家属在设置里把「轮椅及衣物重量」从 13.4
 * 改成 13.5；但每条记录在创建时把档案值**快照**进了 `wheelchairWeightUsed` / `rinseBackVolumeUsed`，
 * 之后所有计算都只认快照 —— 于是进行中的那条记录一直显示按 13.4 算出来的实际体重，
 * 用户只能把整条记录删掉重录。
 *
 * 现在的口径：
 * - **进行中（ongoing）**：实时跟随当前病人档案 → 改完立即生效，无需重录；
 * - **已完成 / 已中止**：一律用记录里的快照 → 历史不可变，给医生看过的报告数字永远不变。
 *
 * 三条回退条件（任一不满足就走快照）：
 * 1. 不是进行中 —— 历史不可变；
 * 2. 拿不到档案（离线且本机没缓存、或还没建档案）—— 绝不能把重量当成 0，
 *    否则实际体重会凭空多出「一辆轮椅」；
 * 3. **档案不属于这条记录的病人** —— 切换病人后打开旧记录（见下方 patientId 的说明）。
 *
 * ⚠️ 第 3 条是本轮评审揪出来的真缺陷：`currentPatientId` 是全局的，而记录的 `patientId`
 * 来自路由参数，两者没有任何校验。曾经的失败路径（完全可达，不是手工改 URL）：
 *   ① 首页打开病人 P1 的记录 A → `/session/A`
 *   ② 底部「设置」→ 切换病人到 P2（只 setCurrentPatientId，不改历史栈）
 *   ③ 按返回键回到 `/session/A`，本页重新挂载，此时 currentPatientId 已是 P2
 *   ④ 界面按 P2 的轮椅重量算出错误体重；若用户此时点「标记完成」，
 *      P2 的值会被**固化进 P1 这条记录的冻结快照**（展示层的错变成库里的错，不可逆）
 */
export function resolveEffectiveConfig(
  session: DialysisSession,
  patient: Patient | null | undefined,
): EffectiveConfig {
  const snapshot = {
    wheelchairWeight: Number(session.wheelchairWeightUsed ?? 0),
    rinseMl: Number(session.rinseBackVolumeUsed ?? 0),
    fromPatientProfile: false,
  }
  if (session.status !== 'ongoing' || !patient) return snapshot
  // 归属校验：两边都有 id 且不一致 → 不是这条记录的病人，回退快照
  if (session.patientId && patient.id && session.patientId !== patient.id) return snapshot
  return {
    wheelchairWeight: Number(patient.wheelchairWeight ?? snapshot.wheelchairWeight),
    rinseMl: Number(patient.rinseBackVolume ?? snapshot.rinseMl),
    fromPatientProfile: true,
  }
}

/**
 * 计算一条透析记录的体重与脱水量。
 *
 * `patient` 传当前病人档案（首页/详情/报告/趋势都已经加载了），
 * 传 null 表示「拿不到档案」→ 退回记录里的快照。
 */
export function computeSession(
  session: DialysisSession,
  dry: number | null,
  patient?: Patient | null,
): SessionComputed {
  const cfg = resolveEffectiveConfig(session, patient)
  return calcWeights(
    session.preWeightMeasured,
    session.postWeightMeasured,
    cfg.wheelchairWeight,
    cfg.rinseMl,
    dry,
  )
}

/**
 * 把当前档案里的重量 / 回水量固化进记录（标记完成、中止时调用）。
 *
 * 只在「进行中 → 完成/中止」这个转换点调用：那之后 `resolveEffectiveConfig`
 * 就会改走快照，历史数字从此固定。
 *
 * ⚠️ **调用方必须先判断「原本就是进行中」** —— 已中止的记录在界面上有「补充中止原因」
 * 入口，那条路径**不是**状态转换，绝不能再固化一次：
 * 2 个月前中止的那次透析，当时轮椅及衣物 13.4kg；今天档案改成 15kg；
 * 家属点开补录中止原因并确认 → 若这里无条件固化，这条记录的上机前实际会从 66.6 变成 65.0，
 * 报告数字随之改变 —— 直接违反「历史报告数字不可变」的承诺。
 * `snapshotConfigInto` 本身无法判断（它只看得到当前 session），所以由调用方传 `fromStatus`。
 */
export function snapshotConfigInto(
  session: DialysisSession,
  patient: Patient | null | undefined,
): void {
  if (!patient) return
  // 归属校验同 resolveEffectiveConfig：别的病人的档案绝不能写进这条记录
  if (session.patientId && patient.id && session.patientId !== patient.id) return
  session.wheelchairWeightUsed = Number(patient.wheelchairWeight ?? session.wheelchairWeightUsed ?? 0)
  session.rinseBackVolumeUsed = Number(patient.rinseBackVolume ?? session.rinseBackVolumeUsed ?? 0)
}

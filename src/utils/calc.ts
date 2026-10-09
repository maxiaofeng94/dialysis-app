import type { DialysisSession, DryWeight } from '../types'

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

export function computeSession(session: DialysisSession, dry: number | null): SessionComputed {
  return calcWeights(
    session.preWeightMeasured,
    session.postWeightMeasured,
    session.wheelchairWeightUsed,
    session.rinseBackVolumeUsed,
    dry,
  )
}

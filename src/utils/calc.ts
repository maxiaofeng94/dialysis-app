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
  const planUf = preWeightActual != null && dry != null ? round1(preWeightActual - dry) : null
  const actualUf = preWeightActual != null && postWeightActual != null ? round1(preWeightActual - postWeightActual) : null
  const machineUf = planUf != null ? round1(planUf + rinseMl / 1000) : null
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

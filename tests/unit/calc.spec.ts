import { describe, it, expect } from 'vitest'
import { round1, getEffectiveDryWeight, calcWeights, computeSession } from '../../src/utils/calc'
import { makeDryWeight, makeSession, resetIdSeq } from '../helpers/factories'

describe('round1', () => {
  it('保留一位小数（四舍五入）', () => {
    expect(round1(1.25)).toBe(1.3)
    expect(round1(1.24)).toBe(1.2)
    expect(round1(0.05)).toBe(0.1) // Math.round(0.5) = 1
    expect(round1(-1.25)).toBe(-1.2) // Math.round(-12.5) = -12
  })

  it('整数原样返回', () => {
    expect(round1(60)).toBe(60)
    expect(round1(0)).toBe(0)
  })
})

describe('getEffectiveDryWeight', () => {
  it('空列表返回 null', () => {
    expect(getEffectiveDryWeight([], '2024-06-01')).toBeNull()
  })

  it('取生效日期不晚于目标日期的最新一条', () => {
    resetIdSeq()
    const list = [
      makeDryWeight({ id: 'a', value: 61, effectiveDate: '2024-01-01' }),
      makeDryWeight({ id: 'b', value: 60, effectiveDate: '2024-03-01' }),
      makeDryWeight({ id: 'c', value: 59, effectiveDate: '2024-05-01' }),
    ]
    expect(getEffectiveDryWeight(list, '2024-04-15')).toBe(60)
    expect(getEffectiveDryWeight(list, '2024-05-01')).toBe(59) // 当天生效即算数
    expect(getEffectiveDryWeight(list, '2024-06-30')).toBe(59)
  })

  it('同一天生效的取后创建的那条', () => {
    const list = [
      makeDryWeight({ id: 'old', value: 60, effectiveDate: '2024-03-01', createdAt: 100 }),
      makeDryWeight({ id: 'new', value: 62, effectiveDate: '2024-03-01', createdAt: 200 }),
    ]
    expect(getEffectiveDryWeight(list, '2024-03-01')).toBe(62)
  })

  it('全部晚于目标日期时，用最早生效的一条兜底', () => {
    const list = [
      makeDryWeight({ id: 'a', value: 61, effectiveDate: '2024-03-01' }),
      makeDryWeight({ id: 'b', value: 58, effectiveDate: '2024-07-01' }),
      makeDryWeight({ id: 'c', value: 60, effectiveDate: '2024-05-01' }),
    ]
    expect(getEffectiveDryWeight(list, '2024-01-01')).toBe(61)
  })

  it('不修改传入数组的顺序（内部先拷贝）', () => {
    const list = [
      makeDryWeight({ id: 'a', value: 61, effectiveDate: '2024-01-01' }),
      makeDryWeight({ id: 'b', value: 60, effectiveDate: '2024-03-01' }),
    ]
    const before = list.map((d) => d.id)
    getEffectiveDryWeight(list, '2024-02-01')
    expect(list.map((d) => d.id)).toEqual(before)
  })
})

describe('calcWeights', () => {
  it('常规计算：实际体重 / 计划脱水 / 实际脱水 / 机器脱水量', () => {
    const r = calcWeights(80, 78, 20, 300, 60)
    expect(r.preWeightActual).toBe(60)
    expect(r.postWeightActual).toBe(58)
    expect(r.planUf).toBe(0)
    expect(r.actualUf).toBe(2)
    expect(r.rinseBackMl).toBe(300)
    expect(r.machineUf).toBe(0.3) // 计划脱水 + 回水量/1000
    expect(r.effectiveDryWeight).toBe(60)
  })

  it('未测量上机前体重时，所有推导值都为 null', () => {
    const r = calcWeights(null, 78, 20, 300, 60)
    expect(r.preWeightActual).toBeNull()
    expect(r.postWeightActual).toBe(58)
    expect(r.planUf).toBeNull()
    expect(r.actualUf).toBeNull()
    expect(r.machineUf).toBeNull()
  })

  it('没有干体重时计划脱水量为 null，但实际脱水仍可算', () => {
    const r = calcWeights(80, 78.5, 20, 300, null)
    expect(r.preWeightActual).toBe(60)
    expect(r.planUf).toBeNull()
    expect(r.machineUf).toBeNull()
    expect(r.actualUf).toBe(1.5)
    expect(r.effectiveDryWeight).toBeNull()
  })

  it('浮点边界：0.1 + 0.2 类误差被规整到一位小数', () => {
    const r = calcWeights(80.15, 79.05, 20.1, 300, 59.95)
    expect(r.preWeightActual).toBe(60.1) // 80.15 - 20.1 = 60.049999…
    expect(r.postWeightActual).toBe(59) // 79.05 - 20.1 = 58.95 → 59（round1 语义）
    expect(r.planUf).toBe(0.1) // 60.05 → 0.1
  })

  // 实测（Playwright 打测试库）发现：上机前体重低于干体重时，界面会显示「计划脱水 -20.0 L」，
  // 家属会读成「要往身体里输 20 升」。三个脱水量一律按 0 兜底。
  it('上机前体重低于干体重 → 计划脱水按 0 兜底，机器超滤只算回水量', () => {
    const r = calcWeights(80, 78, 20, 300, 80) // 实际体重 60，干体重 80 → 算式 -20
    expect(r.preWeightActual).toBe(60)
    expect(r.planUf).toBe(0) // 回归：曾经是 -20
    expect(r.machineUf).toBe(0.3) // 回归：曾经是 -19.7
  })

  it('下机后比上机前还重 → 实际脱水按 0 兜底', () => {
    const r = calcWeights(80, 82, 20, 300, 60)
    expect(r.preWeightActual).toBe(60)
    expect(r.postWeightActual).toBe(62)
    expect(r.actualUf).toBe(0) // 回归：曾经是 -2
  })

  it('只钳制脱水量，体重本身照实显示（那是原始测量值）', () => {
    // 称重 15kg、轮椅 20kg → 实际体重 -5kg（显然是填错了，但界面要照实显示这个 -5）
    const r = calcWeights(15, 12, 20, 0, 60)
    expect(r.preWeightActual).toBe(-5) // 15 - 20
    expect(r.postWeightActual).toBe(-8) // 12 - 20
    expect(r.planUf).toBe(0) // -5 - 60 < 0 → 兜底
    expect(r.actualUf).toBe(3) // -5 - (-8) = 3，本身是正数，正常保留
    expect(r.machineUf).toBe(0) // 0 + 回水 0
  })

  it('正数脱水量不受影响（钳制不能把正常值改小）', () => {
    const r = calcWeights(85, 82.5, 22, 400, 60.5)
    expect(r.planUf).toBe(2.5)
    expect(r.actualUf).toBe(2.5)
    expect(r.machineUf).toBe(2.9)
  })
})

describe('computeSession', () => {
  it('从记录对象取出字段参与计算', () => {
    const s = makeSession({ preWeightMeasured: 80, postWeightMeasured: 77, wheelchairWeightUsed: 20, rinseBackVolumeUsed: 300 })
    const r = computeSession(s, 58)
    expect(r.preWeightActual).toBe(60)
    expect(r.actualUf).toBe(3)
    expect(r.planUf).toBe(2)
    expect(r.machineUf).toBe(2.3)
  })

  it('干体重为 null 时计划脱水为 null（记录可无干体重）', () => {
    const s = makeSession({ preWeightMeasured: 80 })
    expect(computeSession(s, null).planUf).toBeNull()
  })
})

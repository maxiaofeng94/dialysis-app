/**
 * src/utils/assess.ts 单元测试
 *
 * 这两个函数是临床参考值的判定口径，阈值边界（正常/偏高/偏低的分界）属于回归价值最高的部分：
 * 血压 收缩 90~139、舒张 60~89 为正常；血糖 3.9~11.1 为正常（闭区间）。
 */
import { describe, it, expect } from 'vitest'
import { assessBp, assessGlucose } from '../../src/utils/assess'

describe('assessBp · 阈值边界', () => {
  it.each([
    ['正常上限：收缩 139 / 舒张 89', 139, 89],
    ['正常下限：收缩 90 / 舒张 60', 90, 60],
    ['范围正中的常规值', 120, 80],
    ['收缩贴上限、舒张贴下限', 139, 60],
    ['收缩贴下限、舒张贴上限', 90, 89],
  ])('%s → 正常', (_label, systolic, diastolic) => {
    expect(assessBp(systolic, diastolic)).toEqual({ level: 'normal', text: '正常', color: 'success' })
  })

  it.each([
    ['收缩 140 刚好越上限', 140, 80],
    ['舒张 90 刚好越上限', 120, 90],
    ['收缩与舒张同时偏高', 150, 95],
    ['重度高血压', 200, 120],
  ])('%s → 偏高', (_label, systolic, diastolic) => {
    expect(assessBp(systolic, diastolic)).toEqual({ level: 'high', text: '偏高', color: 'danger' })
  })

  it.each([
    ['收缩 89 刚好低于下限', 89, 70],
    ['舒张 59 刚好低于下限', 110, 59],
    ['两者同时偏低', 85, 55],
    ['极端低值 0/0', 0, 0],
  ])('%s → 偏低', (_label, systolic, diastolic) => {
    expect(assessBp(systolic, diastolic)).toEqual({ level: 'low', text: '偏低', color: 'warning' })
  })

  it('收缩偏低但舒张偏高时以「偏高」优先（先判高再判低）', () => {
    expect(assessBp(89, 95)).toEqual({ level: 'high', text: '偏高', color: 'danger' })
    // 收缩远低于下限也一样先命中高分支
    expect(assessBp(60, 95).level).toBe('high')
  })

  it('返回对象只有 level / text / color 三个字段', () => {
    expect(Object.keys(assessBp(120, 80)).sort()).toEqual(['color', 'level', 'text'])
  })

  it('NaN 输入会落到「正常」（记录实际行为：调用方需自行保证数值有效）', () => {
    expect(assessBp(NaN, NaN).level).toBe('normal')
  })
})

describe('assessGlucose · 阈值边界', () => {
  it.each([
    ['上限 11.1（闭区间）', 11.1],
    ['下限 3.9（闭区间）', 3.9],
    ['常见餐后值 7.8', 7.8],
    ['正常范围中点 6.5', 6.5],
  ])('%s → 正常', (_label, value) => {
    expect(assessGlucose(value)).toEqual({ level: 'normal', text: '正常', color: 'success' })
  })

  it.each([
    ['11.2 刚好越上限', 11.2],
    ['明显高血糖 20', 20],
  ])('%s → 偏高', (_label, value) => {
    expect(assessGlucose(value)).toEqual({ level: 'high', text: '偏高', color: 'danger' })
  })

  it.each([
    ['3.8 刚好低于下限', 3.8],
    ['0 属于偏低（不是「无数据」）', 0],
    ['负值也是偏低', -1],
  ])('%s → 偏低', (_label, value) => {
    expect(assessGlucose(value)).toEqual({ level: 'low', text: '偏低', color: 'warning' })
  })

  it('NaN 输入会落到「正常」（记录实际行为）', () => {
    expect(assessGlucose(NaN).level).toBe('normal')
  })

  it('返回对象只有 level / text / color 三个字段', () => {
    expect(Object.keys(assessGlucose(6)).sort()).toEqual(['color', 'level', 'text'])
  })
})

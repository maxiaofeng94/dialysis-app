/**
 * src/constants.ts 单元测试
 *
 * 重点：
 * 1. 中文标签映射（reactionLabel / abortReasonLabel）——查不到 key 时必须原样返回，
 *    否则历史数据里的旧 key 会被显示成空白；
 * 2. abortText 的组合规则——快捷标签与补充描述的拼接顺序、other 的去重、空值兜底，
 *    这段逻辑直接影响「中止原因」在详情页/报告里的展示。
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PATIENT_ID,
  DEFAULT_RINSE_BACK_ML,
  REACTION_TYPES,
  ABORT_REASONS,
  SESSION_STATUS_LABEL,
  SESSION_STATUS_TAG,
  reactionLabel,
  abortReasonLabel,
  abortText,
} from '../../src/constants'

describe('reactionLabel', () => {
  it('已知 key 返回中文标签', () => {
    expect(reactionLabel('vomit')).toBe('呕吐')
    expect(reactionLabel('legWeakness')).toBe('腿脚无力')
    expect(reactionLabel('dizziness')).toBe('头晕')
    expect(reactionLabel('hypotension')).toBe('低血压')
    expect(reactionLabel('cramp')).toBe('抽筋')
    expect(reactionLabel('headache')).toBe('头痛')
    expect(reactionLabel('other')).toBe('其他')
  })

  it('未知 key 原样返回（兼容历史数据）', () => {
    expect(reactionLabel('unknown-key')).toBe('unknown-key')
    expect(reactionLabel('')).toBe('')
  })

  it('与 REACTION_TYPES 表逐项一致', () => {
    for (const item of REACTION_TYPES) {
      expect(reactionLabel(item.key)).toBe(item.label)
    }
  })
})

describe('abortReasonLabel', () => {
  it('已知 key 返回中文标签', () => {
    expect(abortReasonLabel('vascularAccess')).toBe('血管条件差/穿刺失败')
    expect(abortReasonLabel('hypotension')).toBe('低血压')
    expect(abortReasonLabel('patientRequest')).toBe('患者要求下机')
    expect(abortReasonLabel('machineFault')).toBe('机器故障')
    expect(abortReasonLabel('clotting')).toBe('凝血/堵管')
    expect(abortReasonLabel('other')).toBe('其他')
  })

  it('未知 key 原样返回', () => {
    expect(abortReasonLabel('whatever')).toBe('whatever')
  })

  it('与 ABORT_REASONS 表逐项一致', () => {
    for (const item of ABORT_REASONS) {
      expect(abortReasonLabel(item.key)).toBe(item.label)
    }
  })
})

describe('选项表结构', () => {
  it('REACTION_TYPES：key 唯一、label 非空、含 other', () => {
    const keys = REACTION_TYPES.map((r) => r.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(REACTION_TYPES.every((r) => r.label.trim().length > 0)).toBe(true)
    expect(keys).toContain('other')
  })

  it('ABORT_REASONS：key 唯一、label 非空、含 other', () => {
    const keys = ABORT_REASONS.map((r) => r.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(ABORT_REASONS.every((r) => r.label.trim().length > 0)).toBe(true)
    expect(keys).toContain('other')
  })
})

describe('会话状态映射', () => {
  it('三种状态的中文名齐全', () => {
    expect(SESSION_STATUS_LABEL).toEqual({
      ongoing: '进行中',
      completed: '已完成',
      aborted: '已中止',
    })
  })

  it('三种状态的 Tag 类型齐全（进行中=warning / 已完成=success / 已中止=danger）', () => {
    expect(SESSION_STATUS_TAG).toEqual({
      ongoing: 'warning',
      completed: 'success',
      aborted: 'danger',
    })
  })
})

describe('本地默认常量', () => {
  it('默认病人 id 是固定字符串（不是 uuid，迁移时靠它识别本地数据）', () => {
    expect(DEFAULT_PATIENT_ID).toBe('patient-default')
  })

  it('默认回水量 300ml', () => {
    expect(DEFAULT_RINSE_BACK_ML).toBe(300)
  })
})

describe('abortText · 组合规则', () => {
  it('只有快捷标签：用「、」连接中文标签', () => {
    expect(abortText(['vascularAccess'])).toBe('血管条件差/穿刺失败')
    expect(abortText(['hypotension', 'clotting'])).toBe('低血压、凝血/堵管')
    expect(abortText(['patientRequest', 'machineFault', 'clotting'])).toBe(
      '患者要求下机、机器故障、凝血/堵管',
    )
  })

  it('只有补充描述：直接输出描述', () => {
    expect(abortText([], '患者自觉不适')).toBe('患者自觉不适')
    expect(abortText(null, '机器报警')).toBe('机器报警')
    expect(abortText(undefined, '机器报警')).toBe('机器报警')
  })

  it('标签 + 描述：描述追加在最后，用「、」分隔', () => {
    expect(abortText(['hypotension'], '血压 80/50')).toBe('低血压、血压 80/50')
    expect(abortText(['hypotension', 'clotting'], '滤器发黑')).toBe('低血压、凝血/堵管、滤器发黑')
  })

  it('other 只在「没有其它标签且没有描述」时单独显示为「其他」', () => {
    expect(abortText(['other'])).toBe('其他')
    expect(abortText(['other'], '')).toBe('其他')
    expect(abortText(['other'], '   ')).toBe('其他') // 描述只有空格视为空
    expect(abortText(['other'], null)).toBe('其他')
  })

  it('有描述时 other 不再重复出现', () => {
    expect(abortText(['other'], '穿刺失败')).toBe('穿刺失败')
  })

  it('other 与其它标签混选时被丢弃，只保留具名标签', () => {
    expect(abortText(['other', 'clotting'])).toBe('凝血/堵管')
    expect(abortText(['clotting', 'other'], '滤器凝血')).toBe('凝血/堵管、滤器凝血')
  })

  it('tags 为空 + 描述为空 → 空串', () => {
    expect(abortText([], '')).toBe('')
    expect(abortText([], null)).toBe('')
    expect(abortText([], undefined)).toBe('')
    expect(abortText(null, null)).toBe('')
    expect(abortText(undefined, undefined)).toBe('')
    expect(abortText()).toBe('')
  })

  it('tags 传 [] / null / undefined 都不抛错', () => {
    expect(() => abortText([], 'x')).not.toThrow()
    expect(() => abortText(null, 'x')).not.toThrow()
    expect(() => abortText(undefined, 'x')).not.toThrow()
  })

  it('描述首尾空格被去掉', () => {
    expect(abortText([], '  机器报警  ')).toBe('机器报警')
    expect(abortText(['hypotension'], '  血压低  ')).toBe('低血压、血压低')
  })

  it('未知 key 原样出现在结果里（不丢信息）', () => {
    expect(abortText(['legacyKey'])).toBe('legacyKey')
    expect(abortText(['hypotension', 'legacyKey'], '补充')).toBe('低血压、legacyKey、补充')
  })
})

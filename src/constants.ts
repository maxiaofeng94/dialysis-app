import type { SessionStatus } from './types'

export const DEFAULT_PATIENT_ID = 'patient-default'
export const DEFAULT_RINSE_BACK_ML = 300

export interface OptionItem {
  key: string
  label: string
}

export type ReactionType = OptionItem

export const REACTION_TYPES: OptionItem[] = [
  { key: 'vomit', label: '呕吐' },
  { key: 'legWeakness', label: '腿脚无力' },
  { key: 'dizziness', label: '头晕' },
  { key: 'hypotension', label: '低血压' },
  { key: 'cramp', label: '抽筋' },
  { key: 'headache', label: '头痛' },
  { key: 'other', label: '其他' },
]

/** 中止透析的常用原因（可多选，另可补充文字描述） */
export const ABORT_REASONS: OptionItem[] = [
  { key: 'vascularAccess', label: '血管条件差/穿刺失败' },
  { key: 'hypotension', label: '低血压' },
  { key: 'patientRequest', label: '患者要求下机' },
  { key: 'machineFault', label: '机器故障' },
  { key: 'clotting', label: '凝血/堵管' },
  { key: 'other', label: '其他' },
]

export function reactionLabel(key: string): string {
  return REACTION_TYPES.find((r) => r.key === key)?.label ?? key
}

export function abortReasonLabel(key: string): string {
  return ABORT_REASONS.find((r) => r.key === key)?.label ?? key
}

/** 透析状态中文名 */
export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  ongoing: '进行中',
  completed: '已完成',
  aborted: '已中止',
}

/** 透析状态对应的 Vant Tag 类型 */
export const SESSION_STATUS_TAG: Record<SessionStatus, 'warning' | 'success' | 'danger'> = {
  ongoing: 'warning',
  completed: 'success',
  aborted: 'danger',
}

/** 组合中止原因文本：快捷标签 + 补充描述；两者皆空时返回空串 */
export function abortText(tags?: string[] | null, reason?: string | null): string {
  const keys = (tags ?? []).filter((k) => k !== 'other')
  const parts = keys.map(abortReasonLabel)
  const detail = (reason ?? '').trim()
  if (detail) parts.push(detail)
  if (!parts.length && (tags ?? []).includes('other')) parts.push('其他')
  return parts.join('、')
}

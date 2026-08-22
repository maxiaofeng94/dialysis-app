export const DEFAULT_PATIENT_ID = 'patient-default'
export const DEFAULT_RINSE_BACK_ML = 300

export interface ReactionType {
  key: string
  label: string
}

export const REACTION_TYPES: ReactionType[] = [
  { key: 'vomit', label: '呕吐' },
  { key: 'legWeakness', label: '腿脚无力' },
  { key: 'dizziness', label: '头晕' },
  { key: 'hypotension', label: '低血压' },
  { key: 'cramp', label: '抽筋' },
  { key: 'headache', label: '头痛' },
  { key: 'other', label: '其他' },
]

export function reactionLabel(key: string): string {
  return REACTION_TYPES.find((r) => r.key === key)?.label ?? key
}

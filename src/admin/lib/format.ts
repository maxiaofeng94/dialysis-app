/** 展示格式化与角色文案 */

export const ROLE_LABELS: Record<string, string> = {
  owner: '创建者',
  caregiver: '家属/护工',
  doctor: '医生',
  viewer: '只读',
}

export const ROLE_OPTIONS = [
  { value: 'caregiver', label: '家属/护工' },
  { value: 'doctor', label: '医生（只读）' },
  { value: 'viewer', label: '只读' },
]

export const ROLE_OPTIONS_WITH_OWNER = [
  { value: 'owner', label: '创建者' },
  ...ROLE_OPTIONS,
]

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role
}

export type TagType = 'primary' | 'success' | 'warning' | 'danger' | 'info'

export function roleTagType(role: string): TagType {
  switch (role) {
    case 'owner':
      return 'success'
    case 'caregiver':
      return 'primary'
    case 'doctor':
      return 'warning'
    default:
      return 'info'
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function fmtDateTime(v?: string | null): string {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fmtDate(v?: string | null): string {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 相对时间：今天 / 昨天 / N 天前 / N 个月前 / N 年前 */
export function sinceText(v?: string | null): string {
  if (!v) return '从未'
  const t = Date.parse(v)
  if (!Number.isFinite(t)) return '—'
  const days = Math.floor((Date.now() - t) / 864e5)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} 个月前`
  return `${Math.floor(months / 12)} 年前`
}

/** 审计日志展示用的动作名 */
export const ACTION_LABELS: Record<string, string> = {
  'user.rename': '修改用户姓名',
  'user.ban': '禁用账号',
  'user.unban': '解禁账号',
  'user.resetPassword': '重置密码',
  'user.create': '代建账号',
  'user.delete': '删除用户',
  'admin.grant': '授予管理员',
  'admin.revoke': '撤销管理员',
  'member.add': '添加成员',
  'member.setRole': '修改成员角色',
  'member.remove': '移除成员',
  'patient.update': '修改病人配置',
  'patient.transferOwner': '转移创建者',
  'patient.delete': '删除病人',
}

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action
}

export type ActionTagType = TagType

export function actionTagType(action: string): ActionTagType {
  if (action.endsWith('.delete') || action === 'user.ban' || action === 'admin.revoke') return 'danger'
  if (action === 'user.create' || action === 'admin.grant' || action === 'user.unban') return 'success'
  return 'primary'
}

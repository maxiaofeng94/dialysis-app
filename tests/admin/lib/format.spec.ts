/**
 * src/admin/lib/format.ts 测试
 *
 * 全是展示层的纯函数，但错一处就会在后台页面上显示成「—」或英文键名，
 * 所以逐档钉死：角色文案 / 标签色、时间格式化补零、相对时间的每一档、动作名与标签色。
 *
 * 时间相关的断言全部用「本地时间字符串」（不带 Z）并固定系统时间，
 * 这样在任何时区跑都得到同一个结果。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  ACTION_LABELS,
  ROLE_LABELS,
  ROLE_OPTIONS,
  actionLabel,
  actionTagType,
  fmtDate,
  fmtDateTime,
  maskName,
  maskPhone,
  roleLabel,
  roleTagType,
  sinceText,
} from '../../../src/admin/lib/format'

/** 固定「现在」= 2024-06-15 12:00（本地时间） */
const NOW = new Date('2024-06-15T12:00:00')
/**
 * 相对 NOW 偏移 n 天（可小数），返回**本地时间**字符串。
 * 注意不能用 toISOString()（会转成 UTC，在非 UTC 时区下整体偏移几小时）。
 */
const daysAgoStr = (n: number): string => {
  const d = new Date(NOW.getTime() - n * 864e5)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

describe('format · roleLabel / roleTagType', () => {
  it.each([
    ['owner', '创建者', 'success'],
    ['caregiver', '家属/护工', 'primary'],
    ['doctor', '医生', 'warning'],
    ['viewer', '只读', 'info'],
  ] as const)('%s → 文案「%s」、标签色 %s', (role, label, tag) => {
    expect(roleLabel(role)).toBe(label)
    expect(roleTagType(role)).toBe(tag)
  })

  it('未知角色原样返回文案、标签色兜底为 info', () => {
    expect(roleLabel('patient')).toBe('patient')
    expect(roleLabel('')).toBe('')
    expect(roleTagType('patient')).toBe('info')
    expect(roleTagType('')).toBe('info')
    expect(roleTagType('OWNER')).toBe('info') // 大小写敏感
  })

  it('ROLE_LABELS 覆盖四种角色', () => {
    expect(Object.keys(ROLE_LABELS).sort()).toEqual(['caregiver', 'doctor', 'owner', 'viewer'])
  })
})

describe('format · ROLE_OPTIONS', () => {
  it('ROLE_OPTIONS 只有三种非创建者角色（下拉里绝不能出现 owner）', () => {
    expect(ROLE_OPTIONS).toEqual([
      { value: 'caregiver', label: '家属/护工' },
      { value: 'doctor', label: '医生（只读）' },
      { value: 'viewer', label: '只读' },
    ])
    // 中-1 的根因就是这份列表里带了 owner：一点即静默多出一个创建者
    expect(ROLE_OPTIONS.map((o) => o.value)).not.toContain('owner')
    expect(ROLE_OPTIONS).toHaveLength(3)
  })

  it('选项都带 value/label 字符串，且 value 与 ROLE_LABELS 对得上', () => {
    for (const opt of ROLE_OPTIONS) {
      expect(typeof opt.value).toBe('string')
      expect(typeof opt.label).toBe('string')
      expect(roleLabel(opt.value)).toBe(ROLE_LABELS[opt.value])
    }
  })

  it('owner 只能靠 ROLE_LABELS 展示（「创建者」文案仍在，用于角色标签）', () => {
    expect(ROLE_LABELS.owner).toBe('创建者')
  })
})

describe('format · maskPhone / maskName（删除确认框打码显示）', () => {
  it('手机号：前 3 位 + **** + 后 4 位', () => {
    expect(maskPhone('13800000001')).toBe('138****0001')
    expect(maskPhone('13800000001')).not.toContain('0000000') // 中间段被遮住，不能照抄
    expect(maskPhone(' 13912345678 ')).toBe('139****5678')
  })

  it('手机号：空值 → 「—」；不足 7 位只留首位（无法可靠打码）', () => {
    expect(maskPhone(undefined)).toBe('—')
    expect(maskPhone(null)).toBe('—')
    expect(maskPhone('')).toBe('—')
    expect(maskPhone('123456')).toBe('1****')
  })

  it('姓名：保留首字，其余每位一个星号', () => {
    expect(maskName('张三')).toBe('张*')
    expect(maskName('张三丰')).toBe('张**')
    expect(maskName('欧阳锋')).toBe('欧**')
  })

  it('姓名：空值 → 「—」；单字姓名也至少打一个星号', () => {
    expect(maskName(undefined)).toBe('—')
    expect(maskName(null)).toBe('—')
    expect(maskName('')).toBe('—')
    expect(maskName('   ')).toBe('—')
    expect(maskName('张')).toBe('张*')
  })
})

describe('format · fmtDateTime / fmtDate', () => {  it('空值（undefined / null / 空串）→ 占位符「—」', () => {
    expect(fmtDateTime(undefined)).toBe('—')
    expect(fmtDateTime(null)).toBe('—')
    expect(fmtDateTime('')).toBe('—')
    expect(fmtDate(undefined)).toBe('—')
    expect(fmtDate(null)).toBe('—')
    expect(fmtDate('')).toBe('—')
  })

  it('非法时间字符串 → 「—」（不抛异常、不显示 Invalid Date）', () => {
    expect(fmtDateTime('不是时间')).toBe('—')
    expect(fmtDateTime('2024-13-45')).toBe('—')
    expect(fmtDate('abc')).toBe('—')
  })

  it('正常值：日期 + 时分，月/日/时/分都补零', () => {
    expect(fmtDateTime('2024-06-15T09:05:00')).toBe('2024-06-15 09:05')
    expect(fmtDateTime('2024-01-02T03:04:00')).toBe('2024-01-02 03:04')
    expect(fmtDate('2024-01-02T03:04:00')).toBe('2024-01-02')
  })

  it('秒与毫秒被丢弃（页面只显示到分钟）', () => {
    expect(fmtDateTime('2024-06-15T23:59:59.999')).toBe('2024-06-15 23:59')
  })

  it('fmtDate 只取日期部分', () => {
    expect(fmtDate('2024-12-31T23:00:00')).toBe('2024-12-31')
  })
})

describe('format · sinceText', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => vi.useRealTimers())

  it('空值 → 「从未」；非法值 → 「—」', () => {
    expect(sinceText(undefined)).toBe('从未')
    expect(sinceText(null)).toBe('从未')
    expect(sinceText('')).toBe('从未')
    expect(sinceText('不是时间')).toBe('—')
  })

  it('刚发生 / 几小时前 / 未来时间 → 「今天」', () => {
    expect(sinceText(daysAgoStr(0))).toBe('今天')
    expect(sinceText(daysAgoStr(0.5))).toBe('今天')
    expect(sinceText(new Date(NOW.getTime() + 864e5).toISOString())).toBe('今天') // 时钟偏差导致的未来时间
  })

  it('满 24 小时 → 「昨天」；不足 24 小时仍算「今天」', () => {
    expect(sinceText(daysAgoStr(1))).toBe('昨天')
    expect(sinceText(daysAgoStr(1.2))).toBe('昨天')
    expect(sinceText(daysAgoStr(2.5))).toBe('2 天前')
    // 23 小时前 < 1 天
    expect(sinceText(daysAgoStr(0.95))).toBe('今天')
  })

  it('1~29 天 → N 天前', () => {
    expect(sinceText(daysAgoStr(3))).toBe('3 天前')
    expect(sinceText(daysAgoStr(29))).toBe('29 天前')
  })

  it('30 天~不满 12 个月 → N 个月前（按 30 天折算）', () => {
    expect(sinceText(daysAgoStr(30))).toBe('1 个月前')
    expect(sinceText(daysAgoStr(59))).toBe('1 个月前')
    expect(sinceText(daysAgoStr(60))).toBe('2 个月前')
    expect(sinceText(daysAgoStr(359))).toBe('11 个月前')
  })

  it('满 12 个月 → N 年前', () => {
    expect(sinceText(daysAgoStr(360))).toBe('1 年前')
    expect(sinceText(daysAgoStr(365))).toBe('1 年前')
    expect(sinceText(daysAgoStr(800))).toBe('2 年前')
  })
})

describe('format · actionLabel / actionTagType', () => {
  it.each([
    ['user.rename', '修改用户姓名'],
    ['user.ban', '禁用账号'],
    ['user.unban', '解禁账号'],
    ['user.resetPassword', '重置密码'],
    ['user.create', '代建账号'],
    ['user.delete', '删除用户'],
    ['admin.grant', '授予管理员'],
    ['admin.revoke', '撤销管理员'],
    ['member.add', '添加成员'],
    ['member.setRole', '修改成员角色'],
    ['member.remove', '移除成员'],
    ['patient.update', '修改病人配置'],
    ['patient.transferOwner', '转移创建者'],
    ['patient.delete', '删除病人'],
  ])('actionLabel(%s) = %s', (action, label) => {
    expect(actionLabel(action)).toBe(label)
    expect(ACTION_LABELS[action]).toBe(label)
  })

  it('未知动作原样返回（后端新增动作时前端不至于显示空白）', () => {
    expect(actionLabel('user.explode')).toBe('user.explode')
    expect(actionLabel('')).toBe('')
  })

  it('危险动作 → danger：删除类（.delete 结尾）、禁用、撤销管理员', () => {
    expect(actionTagType('user.delete')).toBe('danger')
    expect(actionTagType('patient.delete')).toBe('danger')
    expect(actionTagType('member.delete')).toBe('danger') // 按后缀判定
    expect(actionTagType('user.ban')).toBe('danger')
    expect(actionTagType('admin.revoke')).toBe('danger')
  })

  it('正向动作 → success：代建账号、授予管理员、解禁', () => {
    expect(actionTagType('user.create')).toBe('success')
    expect(actionTagType('admin.grant')).toBe('success')
    expect(actionTagType('user.unban')).toBe('success')
  })

  it('其余动作 → primary；「user.banned」不等于「user.ban」', () => {
    expect(actionTagType('user.rename')).toBe('primary')
    expect(actionTagType('user.resetPassword')).toBe('primary')
    expect(actionTagType('member.add')).toBe('primary')
    expect(actionTagType('member.setRole')).toBe('primary')
    expect(actionTagType('patient.update')).toBe('primary')
    expect(actionTagType('patient.transferOwner')).toBe('primary')
    expect(actionTagType('user.banned')).toBe('primary')
    expect(actionTagType('user.deleteAll')).toBe('primary')
    expect(actionTagType('')).toBe('primary')
  })
})

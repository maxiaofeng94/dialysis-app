/**
 * 后台 8 个页面 + AdminLayout 的挂载测试（jsdom + @vue/test-utils + Element Plus）
 *
 * 与 scripts/smoke-admin.mjs（SSR 只渲染一次）互补：这里真的挂载、跑 onMounted 里的
 * 接口调用，断言「数据 → 渲染」的结果，以及每条接口报错/空数据时页面有兜底、不白屏。
 *
 * src/admin/lib/{api,auth,supabase} 全部换成替身：
 *   · api  —— 每个方法返回构造好的数据（或按用例抛错）；
 *   · auth —— me / login / logout 等由用例控制；
 *   · supabase —— 控制 isConfigured 与 MeView 的改密码调用。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createRouter, createMemoryHistory, type RouteRecordRaw, type Router } from 'vue-router'
import ElementPlus, { ElDialog, ElMessage, ElMessageBox, ElPagination } from 'element-plus'

// ---------------------------------------------------------------- 替身

const m = vi.hoisted(() => ({
  // api.ts
  whoami: vi.fn(),
  overview: vi.fn(),
  users: vi.fn(),
  user: vi.fn(),
  patients: vi.fn(),
  patient: vi.fn(),
  audit: vi.fn(),
  renameUser: vi.fn(),
  setBanned: vi.fn(),
  resetPassword: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  grantAdmin: vi.fn(),
  revokeAdmin: vi.fn(),
  addMember: vi.fn(),
  setMemberRole: vi.fn(),
  removeMember: vi.fn(),
  updatePatient: vi.fn(),
  transferOwner: vi.fn(),
  deletePatient: vi.fn(),
  // auth.ts
  login: vi.fn(),
  logout: vi.fn(),
  initAuth: vi.fn(),
  refreshWhoami: vi.fn(),
  consumeSignOutReason: vi.fn(),
  // supabase.ts
  configured: true,
  updateUser: vi.fn(),
}))

vi.mock('../../src/admin/lib/api', async () => {
  const { ref } = await import('vue')
  return {
    AdminApiError: class AdminApiError extends Error {
      status: number
      constructor(message: string, status: number) {
        super(message)
        this.name = 'AdminApiError'
        this.status = status
      }
    },
    lastWarning: ref<string | null>(null),
    setUnauthorizedHandler: vi.fn(),
    messageOf: (err: unknown) => (err instanceof Error ? err.message : '操作失败'),
    api: {
      whoami: m.whoami,
      overview: m.overview,
      users: m.users,
      user: m.user,
      patients: m.patients,
      patient: m.patient,
      audit: m.audit,
      renameUser: m.renameUser,
      setBanned: m.setBanned,
      resetPassword: m.resetPassword,
      createUser: m.createUser,
      deleteUser: m.deleteUser,
      grantAdmin: m.grantAdmin,
      revokeAdmin: m.revokeAdmin,
      addMember: m.addMember,
      setMemberRole: m.setMemberRole,
      removeMember: m.removeMember,
      updatePatient: m.updatePatient,
      transferOwner: m.transferOwner,
      deletePatient: m.deletePatient,
    },
  }
})

vi.mock('../../src/admin/lib/auth', async () => {
  const { ref } = await import('vue')
  return {
    me: ref(null),
    adminUser: ref(null),
    ready: ref(true),
    login: m.login,
    logout: m.logout,
    initAuth: m.initAuth,
    refreshWhoami: m.refreshWhoami,
    consumeSignOutReason: m.consumeSignOutReason,
  }
})

vi.mock('../../src/admin/lib/supabase', () => ({
  get isConfigured() {
    return m.configured
  },
  get supabase() {
    return m.configured ? { auth: { updateUser: m.updateUser } } : null
  },
  get SUPABASE_URL() {
    return 'https://test-project.supabase.co'
  },
  get SUPABASE_ANON_KEY() {
    return 'test-anon-key'
  },
}))

import { api, lastWarning } from '../../src/admin/lib/api'
import { me } from '../../src/admin/lib/auth'
import LoginView from '../../src/admin/views/LoginView.vue'
import DashboardView from '../../src/admin/views/DashboardView.vue'
import UserListView from '../../src/admin/views/UserListView.vue'
import UserDetailView from '../../src/admin/views/UserDetailView.vue'
import PatientListView from '../../src/admin/views/PatientListView.vue'
import PatientDetailView from '../../src/admin/views/PatientDetailView.vue'
import AuditView from '../../src/admin/views/AuditView.vue'
import MeView from '../../src/admin/views/MeView.vue'
import AdminLayout from '../../src/admin/layout/AdminLayout.vue'

// ---------------------------------------------------------------- 工具与数据

/** 本地时间字符串（不带 Z），避免时区漂移 */
const AT = '2024-06-15T09:05:00'

const STUB = { template: '<div class="stub-page" />' }

/** 与 src/admin/router.ts 对齐的路由表（页面里会 router.push 到这些地址） */
function makeRoutes(): RouteRecordRaw[] {
  return [
    { path: '/login', name: 'login', component: STUB, meta: { public: true, title: '登录' } },
    { path: '/', name: 'dashboard', component: STUB, meta: { title: '概览' } },
    { path: '/users', name: 'users', component: STUB, meta: { title: '用户管理' } },
    { path: '/users/:id', name: 'user-detail', component: STUB, meta: { title: '用户详情' } },
    { path: '/patients', name: 'patients', component: STUB, meta: { title: '病人管理' } },
    { path: '/patients/:id', name: 'patient-detail', component: STUB, meta: { title: '病人详情' } },
    { path: '/audit', name: 'audit', component: STUB, meta: { title: '操作日志' } },
    { path: '/me', name: 'me', component: STUB, meta: { title: '我的账号' } },
  ]
}

/** 挂载页面：需要路由（useRoute/useRouter）+ Element Plus */
async function mountView(component: unknown, path = '/'): Promise<{ wrapper: VueWrapper; router: Router }> {
  const router = createRouter({ history: createMemoryHistory(), routes: makeRoutes() })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(component as never, { global: { plugins: [ElementPlus, router] } })
  await flushPromises()
  await nextTick()
  return { wrapper, router }
}

/** 按文字找按钮（找不到就报错，避免静默通过） */
function buttonByText(wrapper: VueWrapper, text: string) {
  const btn = wrapper.findAll('button').find((b) => b.text().includes(text))
  if (!btn) throw new Error(`页面上找不到按钮：${text}`)
  return btn
}

/** 表格渲染出的数据行（Element Plus 给数据行加 el-table__row） */
const tableRows = (wrapper: VueWrapper) => wrapper.findAll('.el-table__row')

/** 页面里的删除/危险对话框（Element Plus 默认 append-to-body=false，仍渲染在组件树内） */
const dialogByTitle = (wrapper: VueWrapper, title: string) =>
  wrapper.findAllComponents(ElDialog).find((d) => d.props('title') === title)

/**
 * 捕获 ElMessageBox.confirm 的调用（危险操作确认框）。
 * 'cancel' = 用户点取消（Promise reject），'ok' = 点确定。
 */
function spyConfirm(impl: 'cancel' | 'ok' = 'cancel') {
  return vi
    .spyOn(ElMessageBox, 'confirm')
    .mockImplementation(
      () => (impl === 'cancel' ? Promise.reject('cancel') : Promise.resolve('confirm')) as never,
    )
}

/** 打开页面里第一个 el-select 的下拉，返回选项文字（选项渲染在 body 上的 popper 里） */
async function openSelectOptions(wrapper: VueWrapper): Promise<string[]> {
  const trigger = wrapper.find('.el-select__wrapper')
  await (trigger.exists() ? trigger : wrapper.find('.el-select')).trigger('click')
  await flushPromises()
  await nextTick()
  // 只认当前可见的那个下拉：用例之间不卸载组件，body 上会残留之前打开的 popper
  const open = Array.from(document.querySelectorAll('.el-popper')).filter(
    (p) => (p as HTMLElement).style.display !== 'none',
  )
  const last = open[open.length - 1]
  return Array.from(last?.querySelectorAll('.el-select-dropdown__item') ?? []).map(
    (el) => el.textContent?.trim() ?? '',
  )
}

/** 手动控制 resolve 的 Promise：用来构造「先发的请求后到」 */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function userRow(over: Record<string, unknown> = {}) {
  return {
    id: 'u-1',
    phone: '13800000001',
    name: '张三',
    createdAt: AT,
    lastSignInAt: AT,
    banned: false,
    bannedUntil: null,
    isAdmin: false,
    profileMissing: false,
    patientCount: 1,
    roles: [{ patientId: 'p-1', patientName: '病人一', role: 'owner' }],
    ...over,
  }
}

function patientRow(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    name: '病人一',
    birthday: '1950-03-02',
    wheelchairWeight: 20000,
    rinseBackVolume: 400,
    createdAt: AT,
    updatedAt: AT,
    memberCount: 1,
    ownerCount: 1,
    owners: ['张三'],
    members: [{ userId: 'u-1', name: '张三', phone: '13800000001', role: 'owner', roleLabel: '创建者', joinedAt: AT }],
    sessionCount: 3,
    firstSessionDate: '2024-05-01',
    lastSessionDate: '2024-06-14',
    ...over,
  }
}

const OVERVIEW = {
  userCount: 12,
  patientCount: 5,
  sessionCount: 340,
  newUsers7d: 3,
  newSessions7d: 21,
  adminCount: 2,
  usersWithoutPatient: 4,
  patientsWithoutMember: 1,
  activePatients7d: 3,
  missingProfile: 2,
}

const USER_DETAIL = {
  user: {
    id: 'u-1',
    phone: '13800000001',
    name: '张三',
    createdAt: AT,
    lastSignInAt: AT,
    banned: false,
    bannedUntil: null,
    isAdmin: false,
    profileMissing: false,
    authEmail: '13800000001@phone.local',
  },
  patients: [
    {
      patientId: 'p-1',
      patientName: '病人一',
      role: 'owner',
      roleLabel: '创建者',
      joinedAt: AT,
      patientCreatedAt: AT,
      sessionCount: 3,
      lastSessionDate: '2024-06-14',
      ownerCount: 1,
    },
  ],
}

const PATIENT_DETAIL = {
  patient: {
    id: 'p-1',
    name: '病人一',
    birthday: '1950-03-02',
    wheelchairWeight: 20000,
    rinseBackVolume: 400,
    createdAt: AT,
    updatedAt: AT,
  },
  members: [
    { userId: 'u-1', name: '张三', phone: '13800000001', role: 'owner', roleLabel: '创建者', joinedAt: AT, profileMissing: false },
    { userId: 'u-2', name: '护工乙', phone: '13800000002', role: 'caregiver', roleLabel: '家属/护工', joinedAt: AT, profileMissing: false },
  ],
  stats: { sessionCount: 3, firstSessionDate: '2024-05-01', lastSessionDate: '2024-06-14' },
}

const AUDIT_ROWS = {
  total: 1,
  page: 1,
  size: 30,
  rows: [
    {
      id: 1,
      adminId: 'u-admin',
      adminName: '管理员甲',
      adminPhone: '13800000001',
      action: 'user.ban',
      targetType: 'user',
      targetId: 'u-1',
      detail: { phone: '13800000001', nested: { a: 1 } },
      createdAt: AT,
    },
  ],
}

/** 让所有读接口都返回「有数据」的默认实现（各用例可覆盖） */
function stubAllApis() {
  vi.mocked(api.overview).mockResolvedValue(OVERVIEW as never)
  vi.mocked(api.users).mockResolvedValue({ total: 1, page: 1, size: 20, rows: [userRow()] } as never)
  vi.mocked(api.user).mockResolvedValue(USER_DETAIL as never)
  vi.mocked(api.patients).mockResolvedValue({ total: 1, page: 1, size: 20, rows: [patientRow()] } as never)
  vi.mocked(api.patient).mockResolvedValue(PATIENT_DETAIL as never)
  vi.mocked(api.audit).mockResolvedValue(AUDIT_ROWS as never)
  vi.mocked(api.renameUser).mockResolvedValue({ userId: 'u-1' } as never)
  vi.mocked(api.createUser).mockResolvedValue({ userId: 'u-new' } as never)
  vi.mocked(api.updatePatient).mockResolvedValue(undefined as never)
}

beforeEach(() => {
  m.configured = true
  me.value = { userId: 'u-admin', isAdmin: true, name: '管理员甲', phone: '13800000001' }
  lastWarning.value = null
  vi.mocked(m.login).mockReset().mockResolvedValue({ ok: true, message: '登录成功' })
  vi.mocked(m.logout).mockReset().mockResolvedValue(undefined)
  vi.mocked(m.consumeSignOutReason).mockReset().mockReturnValue(null)
  vi.mocked(m.updateUser).mockReset().mockResolvedValue({ error: null })
  stubAllApis()
})

afterEach(() => {
  // 页面里可能出现 hash 跳转（例如 401 统一登出），用例之间复位，避免互相影响
  window.location.hash = ''
  vi.restoreAllMocks()
})

// ================================================================ LoginView

describe('后台页面 · LoginView', () => {
  it('未配置 Supabase 时提示，且登录表单仍在（不白屏）', async () => {
    m.configured = false
    const { wrapper } = await mountView(LoginView, '/login')

    expect(wrapper.text()).toContain('未配置 Supabase 连接')
    expect(wrapper.text()).toContain('请使用管理员手机号登录')
    expect(wrapper.findAll('input').length).toBeGreaterThanOrEqual(2)
  })

  it('手机号格式不对 → 就地报错，不调用登录', async () => {
    const { wrapper } = await mountView(LoginView, '/login')

    await wrapper.findAll('input')[0].setValue('12345')
    await wrapper.findAll('input')[1].setValue('secret1')
    await buttonByText(wrapper, '登录').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('请输入正确的手机号')
    expect(m.login).not.toHaveBeenCalled()
  })

  it('密码不足 6 位 → 就地报错，不调用登录', async () => {
    const { wrapper } = await mountView(LoginView, '/login')

    await wrapper.findAll('input')[0].setValue('13800000000')
    await wrapper.findAll('input')[1].setValue('123')
    await buttonByText(wrapper, '登录').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('密码至少 6 位')
    expect(m.login).not.toHaveBeenCalled()
  })

  it('登录成功 → 调 login 并跳到 redirect 指定的页面', async () => {
    const { wrapper, router } = await mountView(LoginView, '/login?redirect=/users')

    await wrapper.findAll('input')[0].setValue('13800000000')
    await wrapper.findAll('input')[1].setValue('secret1')
    await buttonByText(wrapper, '登录').trigger('click')
    await flushPromises()

    expect(m.login).toHaveBeenCalledWith('13800000000', 'secret1')
    expect(router.currentRoute.value.fullPath).toBe('/users')
  })

  it('登录失败（没有后台权限）→ 把服务端文案渲染在页面上', async () => {
    m.login.mockResolvedValue({ ok: false, message: '该账号没有后台权限' })
    const { wrapper, router } = await mountView(LoginView, '/login')

    await wrapper.findAll('input')[0].setValue('13800000000')
    await wrapper.findAll('input')[1].setValue('secret1')
    await buttonByText(wrapper, '登录').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('该账号没有后台权限')
    expect(router.currentRoute.value.fullPath).toBe('/login')
  })

  it('onMounted 取出上次登出原因并提示', async () => {
    m.consumeSignOutReason.mockReturnValue('长时间未操作，已自动退出')
    const { wrapper } = await mountView(LoginView, '/login')

    expect(m.consumeSignOutReason).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('长时间未操作，已自动退出')
  })
})

// ================================================================ DashboardView

describe('后台页面 · DashboardView', () => {
  it('概览数字渲染成 7 张卡片，关注项按条件列出', async () => {
    const { wrapper } = await mountView(DashboardView, '/')

    expect(api.overview).toHaveBeenCalledOnce()
    expect(wrapper.findAll('.stat-card')).toHaveLength(7)
    expect(wrapper.findAll('.stat-value').map((v) => v.text())).toEqual([
      '12',
      '5',
      '340',
      '2',
      '3',
      '21',
      '3',
    ])
    const text = wrapper.text()
    expect(text).toContain('注册用户')
    expect(text).toContain('近 7 天有记录的病人')
    expect(text).toContain('1 个病人没有任何成员')
    expect(text).toContain('4 个用户还没有绑定病人')
    expect(text).toContain('2 个账号缺少资料行')
    // 说明区固定文案：后台看不到病历明细
    expect(text).toContain('看不到任何透析记录明细')
  })

  it('全部为 0 时不显示「需要关注」卡片', async () => {
    vi.mocked(api.overview).mockResolvedValue({
      ...OVERVIEW,
      usersWithoutPatient: 0,
      patientsWithoutMember: 0,
      missingProfile: 0,
    } as never)
    const { wrapper } = await mountView(DashboardView, '/')

    expect(wrapper.findAll('.stat-card')).toHaveLength(7)
    expect(wrapper.text()).not.toContain('需要关注')
  })

  it('接口报错 → 显示错误提示且不崩（卡片为空）', async () => {
    vi.mocked(api.overview).mockRejectedValue(new Error('无后台权限'))
    const { wrapper } = await mountView(DashboardView, '/')

    expect(wrapper.text()).toContain('无后台权限')
    expect(wrapper.findAll('.stat-card')).toHaveLength(0)
    expect(wrapper.text()).toContain('说明') // 静态说明卡仍在
  })
})

// ================================================================ UserListView

describe('后台页面 · UserListView', () => {
  it('表格渲染出手机号/姓名/角色标签/状态标记，并显示总数', async () => {
    vi.mocked(api.users).mockResolvedValue({
      total: 2,
      page: 1,
      size: 20,
      rows: [
        userRow(),
        userRow({
          id: 'u-2',
          phone: null,
          name: '',
          banned: true,
          isAdmin: true,
          profileMissing: true,
          roles: [],
        }),
      ],
    } as never)
    const { wrapper } = await mountView(UserListView, '/users')

    expect(api.users).toHaveBeenCalledWith({
      search: '',
      page: 1,
      size: 20,
      sort: 'createdAt',
      order: 'desc',
    })
    expect(wrapper.text()).toContain('共 2 个用户')
    expect(tableRows(wrapper)).toHaveLength(2)

    const text = wrapper.text()
    expect(text).toContain('13800000001')
    expect(text).toContain('张三')
    expect(text).toContain('病人一 · 创建者')
    expect(text).toContain('未设置') // 姓名为空
    expect(text).toContain('—') // 手机号为空
    expect(text).toContain('已禁用')
    expect(text).toContain('管理员')
    expect(text).toContain('缺资料')
    expect(text).toContain('无') // 无角色
  })

  it('查询按钮把关键字带进请求（并重置到第 1 页）', async () => {
    const { wrapper } = await mountView(UserListView, '/users')
    expect(api.users).toHaveBeenCalledTimes(1)

    await wrapper.find('input').setValue('张三')
    await buttonByText(wrapper, '查询').trigger('click')
    await flushPromises()

    expect(api.users).toHaveBeenLastCalledWith({
      search: '张三',
      page: 1,
      size: 20,
      sort: 'createdAt',
      order: 'desc',
    })
  })

  it('空结果 → 显示兜底文案而不是空白', async () => {
    vi.mocked(api.users).mockResolvedValue({ total: 0, page: 1, size: 20, rows: [] } as never)
    const { wrapper } = await mountView(UserListView, '/users')

    expect(tableRows(wrapper)).toHaveLength(0)
    expect(wrapper.text()).toContain('没有符合条件的用户')
    expect(wrapper.text()).toContain('共 0 个用户')
  })

  it('接口报错 → 顶部错误提示 + 空表兜底，不崩', async () => {
    vi.mocked(api.users).mockRejectedValue(new Error('登录已过期，请重新登录'))
    const { wrapper } = await mountView(UserListView, '/users')

    expect(wrapper.text()).toContain('登录已过期，请重新登录')
    expect(tableRows(wrapper)).toHaveLength(0)
    expect(wrapper.text()).toContain('没有符合条件的用户')
  })

  // ---- 中-7：代建账号入口 ----

  it('「代建账号」：提交手机号/密码/姓名 → 调 api.createUser 并刷新列表', async () => {
    const success = vi.spyOn(ElMessage, 'success').mockImplementation(() => ({}) as never)
    const { wrapper } = await mountView(UserListView, '/users')
    expect(api.users).toHaveBeenCalledTimes(1)

    await buttonByText(wrapper, '代建账号').trigger('click')
    await nextTick()

    const inputs = wrapper.find('.el-dialog').findAll('input')
    expect(inputs).toHaveLength(3)
    await inputs[0].setValue('13800000009')
    await inputs[1].setValue('secret1')
    await inputs[2].setValue('新用户')

    await buttonByText(wrapper, '创建').trigger('click')
    await flushPromises()

    expect(api.createUser).toHaveBeenCalledWith('13800000009', 'secret1', '新用户')
    expect(api.users).toHaveBeenCalledTimes(2) // 创建成功后刷新列表
    expect(success).toHaveBeenCalledWith('账号已创建，请把手机号与密码线下告知本人')
  })

  it('「代建账号」：手机号格式不对 / 密码太短 → 就地报错，不发请求', async () => {
    const { wrapper } = await mountView(UserListView, '/users')
    await buttonByText(wrapper, '代建账号').trigger('click')
    await nextTick()

    const inputs = wrapper.find('.el-dialog').findAll('input')
    await inputs[0].setValue('12345')
    await inputs[1].setValue('secret1')
    await buttonByText(wrapper, '创建').trigger('click')
    await flushPromises()
    expect(wrapper.find('.el-dialog').text()).toContain('请输入正确的手机号')
    expect(api.createUser).not.toHaveBeenCalled()

    await inputs[0].setValue('13800000009')
    await inputs[1].setValue('123')
    await buttonByText(wrapper, '创建').trigger('click')
    await flushPromises()
    expect(wrapper.find('.el-dialog').text()).toContain('密码至少 6 位')
    expect(api.createUser).not.toHaveBeenCalled()
  })

  it('「代建账号」：服务端报错（手机号已注册）→ 弹窗内提示且不关闭、不刷新', async () => {
    vi.mocked(api.createUser).mockRejectedValue(new Error('该手机号已注册'))
    const { wrapper } = await mountView(UserListView, '/users')
    await buttonByText(wrapper, '代建账号').trigger('click')
    await nextTick()

    const inputs = wrapper.find('.el-dialog').findAll('input')
    await inputs[0].setValue('13800000009')
    await inputs[1].setValue('secret1')
    await buttonByText(wrapper, '创建').trigger('click')
    await flushPromises()

    expect(wrapper.find('.el-dialog').text()).toContain('该手机号已注册')
    expect(api.users).toHaveBeenCalledTimes(1) // 没刷新列表
  })

  // ---- 中-8：请求竞态 ----

  it('翻页竞态：先发的第 1 页请求后到，不覆盖第 2 页结果', async () => {
    const slow = deferred<never>()
    vi.mocked(api.users)
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValueOnce({
        total: 40,
        page: 2,
        size: 20,
        rows: [userRow({ id: 'u-2', name: '第二页用户' })],
      } as never)
    const { wrapper } = await mountView(UserListView, '/users')

    await wrapper.findComponent(ElPagination).vm.$emit('current-change', 2)
    await flushPromises()
    expect(wrapper.text()).toContain('第二页用户')

    slow.resolve({ total: 40, page: 1, size: 20, rows: [userRow({ name: '第一页用户' })] } as never)
    await flushPromises()

    expect(wrapper.text()).toContain('第二页用户')
    expect(wrapper.text()).not.toContain('第一页用户')
  })
})

// ================================================================ UserDetailView

describe('后台页面 · UserDetailView', () => {
  it('渲染账号信息与名下病人（角色文案、记录数）', async () => {
    const { wrapper } = await mountView(UserDetailView, '/users/u-1')

    expect(api.user).toHaveBeenCalledWith('u-1')
    const text = wrapper.text()
    expect(text).toContain('账号信息')
    expect(text).toContain('13800000001')
    expect(text).toContain('张三')
    expect(text).toContain('病人一')
    expect(text).toContain('创建者')
    expect(text).toContain('名下病人')
    expect(tableRows(wrapper)).toHaveLength(1)
    // 不是自己 → 显示禁用/删除等危险操作
    expect(text).toContain('禁用账号')
    expect(text).toContain('删除用户')
    expect(text).not.toContain('这是你自己')
  })

  it('查看自己的账号 → 标记「这是你自己」并隐藏危险操作', async () => {
    const { wrapper } = await mountView(UserDetailView, '/users/u-admin')

    expect(api.user).toHaveBeenCalledWith('u-admin')
    const text = wrapper.text()
    expect(text).toContain('这是你自己')
    expect(text).not.toContain('禁用账号')
    expect(text).not.toContain('删除用户')
    expect(text).toContain('为了保护你自己')
  })

  it('接口报错（用户不存在）→ 提示错误且不渲染账号信息卡', async () => {
    vi.mocked(api.user).mockRejectedValue(new Error('用户不存在'))
    const { wrapper } = await mountView(UserDetailView, '/users/u-404')

    expect(wrapper.text()).toContain('用户不存在')
    expect(wrapper.text()).not.toContain('账号信息')
    // 空表的兜底文案仍在
    expect(wrapper.text()).toContain('该用户还不是任何病人的成员')
  })

  it('名下病人为空 → 表格显示兜底文案', async () => {
    vi.mocked(api.user).mockResolvedValue({ user: USER_DETAIL.user, patients: [] } as never)
    const { wrapper } = await mountView(UserDetailView, '/users/u-1')

    expect(tableRows(wrapper)).toHaveLength(0)
    expect(wrapper.text()).toContain('该用户还不是任何病人的成员')
  })

  // ---- 高-1：purge 前必须看到「要删哪几个病人、共多少条记录」 ----

  /** 三个病人：p-1 唯一创建者（会被 purge 删）、p-2 共同创建者、p-3 只是成员 */
  function threePatients() {
    return {
      user: USER_DETAIL.user,
      patients: [
        { ...USER_DETAIL.patients[0] },
        {
          patientId: 'p-2',
          patientName: '病人二',
          role: 'owner',
          roleLabel: '创建者',
          joinedAt: AT,
          patientCreatedAt: AT,
          sessionCount: 9,
          lastSessionDate: null,
          ownerCount: 2,
        },
        {
          patientId: 'p-3',
          patientName: '病人三',
          role: 'caregiver',
          roleLabel: '家属/护工',
          joinedAt: AT,
          patientCreatedAt: AT,
          sessionCount: 4,
          lastSessionDate: null,
          ownerCount: 1,
        },
      ],
    }
  }

  it('删除用户对话框列出「他是唯一创建者」的病人与各自记录数、合计与不可恢复', async () => {
    vi.mocked(api.user).mockResolvedValue(threePatients() as never)
    const { wrapper } = await mountView(UserDetailView, '/users/u-1')

    await buttonByText(wrapper, '删除用户').trigger('click')
    await nextTick()

    const dialog = wrapper.find('.el-dialog')
    expect(dialog.exists()).toBe(true)
    const text = dialog.text()

    expect(text).toContain('病人一') // 唯一创建者 → 必须列出
    expect(text).toContain('3 条记录') // 该病人的记录条数
    expect(text).toMatch(/合计\s*1\s*个病人/) // 只有 p-1 会被级联删除
    expect(text).toMatch(/3\s*条记录/)
    expect(text).toContain('不可恢复')
    // 共有的（p-2）与只是成员的（p-3）不在删除范围内，不能吓唬管理员
    expect(text).not.toContain('病人二')
    expect(text).not.toContain('病人三')
  })

  it('purge 选中且清单非空 → 确认按钮写明「确认删除 N 个病人及全部记录」', async () => {
    vi.mocked(api.user).mockResolvedValue(threePatients() as never)
    const { wrapper } = await mountView(UserDetailView, '/users/u-1')

    await buttonByText(wrapper, '删除用户').trigger('click')
    await nextTick()

    // 默认 detach：按钮是普通文案
    expect(buttonByText(wrapper, '确认删除').text()).toBe('确认删除')

    const radios = wrapper.find('.el-dialog').findAll('input[type="radio"]')
    expect(radios).toHaveLength(2)
    await radios[1].setValue() // purge
    await nextTick()

    expect(buttonByText(wrapper, '确认删除').text()).toBe('确认删除 1 个病人及全部记录')
  })

  it('没有「唯一创建者」的病人时，purge 按钮与说明都不出现清单', async () => {
    vi.mocked(api.user).mockResolvedValue({ user: USER_DETAIL.user, patients: [threePatients().patients[1]] } as never)
    const { wrapper } = await mountView(UserDetailView, '/users/u-1')

    await buttonByText(wrapper, '删除用户').trigger('click')
    await nextTick()
    const dialog = wrapper.find('.el-dialog')
    await dialog.findAll('input[type="radio"]')[1].setValue()
    await nextTick()

    expect(dialog.text()).not.toContain('会被一起删除（不可恢复）')
    expect(buttonByText(wrapper, '确认删除').text()).toBe('确认删除')
  })

  it('删除说明写明会抹掉「记录人」与审计「操作人」，并标出 detach 会被拒的情况', async () => {
    const { wrapper } = await mountView(UserDetailView, '/users/u-1')
    await buttonByText(wrapper, '删除用户').trigger('click')
    await nextTick()

    const text = wrapper.find('.el-dialog').text()
    expect(text).toContain('记录人') // sessions.operator_id: on delete set null
    expect(text).toContain('操作日志') // admin_audit_logs.admin_id: on delete set null
    expect(text).toContain('选「仅删除账号」也一样') // 中-3：detach 也躲不掉
    expect(text).toContain('本选项会被拒绝') // 低-5：不再描述服务端禁止的状态
  })

  it('删除对话框里手机号打码显示，仍要求输入完整值（低-1）', async () => {
    const { wrapper } = await mountView(UserDetailView, '/users/u-1')
    await buttonByText(wrapper, '删除用户').trigger('click')
    await nextTick()

    const text = wrapper.find('.el-dialog').text()
    expect(text).toContain('138****0001')
    expect(text).not.toContain('13800000001')
    expect(text).toContain('完整手机号') // 输入框仍是完整值校验
  })

  it('删除对话框不会被误关：关掉点遮罩与 ESC（低-2）', async () => {
    const { wrapper } = await mountView(UserDetailView, '/users/u-1')
    await buttonByText(wrapper, '删除用户').trigger('click')
    await nextTick()

    const del = dialogByTitle(wrapper, '删除用户')
    expect(del, '找不到删除用户对话框').toBeTruthy()
    expect(del!.props('closeOnClickModal')).toBe(false)
    expect(del!.props('closeOnPressEscape')).toBe(false)
  })

  // ---- 中-1 / 低-4：改角色下拉 ----

  it('改角色下拉不含「创建者」（避免静默产生第二个 owner）', async () => {
    vi.mocked(api.user).mockResolvedValue(threePatients() as never)
    const { wrapper } = await mountView(UserDetailView, '/users/u-1')

    const options = await openSelectOptions(wrapper)

    expect(options).toEqual(['家属/护工', '医生（只读）', '只读'])
    expect(options).not.toContain('创建者')
  })

  it('改角色失败 → 用服务端真值回填（下拉不能停在没生效的新值上）', async () => {
    vi.mocked(api.user).mockResolvedValue({
      user: USER_DETAIL.user,
      patients: [{ ...USER_DETAIL.patients[0], role: 'caregiver', roleLabel: '家属/护工' }],
    } as never)
    vi.mocked(api.setMemberRole).mockRejectedValue(new Error('无后台权限'))
    const error = vi.spyOn(ElMessage, 'error').mockImplementation(() => ({}) as never)
    const { wrapper } = await mountView(UserDetailView, '/users/u-1')

    await wrapper.findComponent({ name: 'ElSelect' }).vm.$emit('change', 'viewer')
    await flushPromises()

    expect(api.setMemberRole).toHaveBeenCalledWith('p-1', 'u-1', 'viewer')
    expect(api.user).toHaveBeenCalledTimes(2) // 失败后重新拉了服务端真值
    expect(error).toHaveBeenCalledWith('无后台权限')
    expect(wrapper.find('.el-select').text()).toContain('家属/护工')
  })

  // ---- 中-2：危险确认框的初始焦点 ----

  it('危险确认框一律 autofocus:false（回车不会直接执行）', async () => {
    vi.mocked(api.user).mockResolvedValue({
      user: USER_DETAIL.user,
      patients: [{ ...USER_DETAIL.patients[0], role: 'caregiver', roleLabel: '家属/护工' }],
    } as never)
    const { wrapper } = await mountView(UserDetailView, '/users/u-1')
    const spy = spyConfirm('cancel')

    for (const text of ['禁用账号', '授予管理员', '移除', '设为创建者']) {
      await buttonByText(wrapper, text).trigger('click')
      await flushPromises()
    }

    expect(spy).toHaveBeenCalledTimes(4)
    for (const call of spy.mock.calls) {
      expect(call[2]).toMatchObject({ autofocus: false })
    }
  })
})

// ================================================================ PatientListView

describe('后台页面 · PatientListView', () => {
  it('渲染病人姓名/创建者/成员标签/记录数', async () => {
    vi.mocked(api.patients).mockResolvedValue({
      total: 2,
      page: 1,
      size: 20,
      rows: [
        patientRow(),
        patientRow({ id: 'p-2', name: '病人二', owners: [], members: [], sessionCount: 0, lastSessionDate: null, firstSessionDate: null }),
      ],
    } as never)
    const { wrapper } = await mountView(PatientListView, '/patients')

    expect(api.patients).toHaveBeenCalledWith({ search: '', page: 1, size: 20 })
    expect(wrapper.text()).toContain('共 2 个病人')
    expect(tableRows(wrapper)).toHaveLength(2)

    const text = wrapper.text()
    expect(text).toContain('病人一')
    expect(text).toContain('张三')
    expect(text).toContain('张三 · 创建者')
    expect(text).toContain('无创建者')
    expect(text).toContain('无') // 无成员
    expect(text).toContain('—') // 无首次记录 → fmtDate 兜底
  })

  it('空结果 → 兜底文案；接口报错 → 错误提示', async () => {
    vi.mocked(api.patients).mockResolvedValue({ total: 0, page: 1, size: 20, rows: [] } as never)
    const empty = await mountView(PatientListView, '/patients')
    expect(empty.wrapper.text()).toContain('没有符合条件的病人')

    vi.mocked(api.patients).mockRejectedValue(new Error('读取 patient_members 失败'))
    const failed = await mountView(PatientListView, '/patients')
    expect(failed.wrapper.text()).toContain('读取 patient_members 失败')
    expect(tableRows(failed.wrapper)).toHaveLength(0)
  })

  it('翻页竞态：先发的第 1 页请求后到，不覆盖第 2 页结果', async () => {
    const slow = deferred<never>()
    vi.mocked(api.patients)
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValueOnce({
        total: 40,
        page: 2,
        size: 20,
        rows: [patientRow({ id: 'p-2', name: '第二页病人' })],
      } as never)
    const { wrapper } = await mountView(PatientListView, '/patients')

    await wrapper.findComponent(ElPagination).vm.$emit('current-change', 2)
    await flushPromises()
    expect(wrapper.text()).toContain('第二页病人')

    slow.resolve({ total: 40, page: 1, size: 20, rows: [patientRow({ name: '第一页病人' })] } as never)
    await flushPromises()

    expect(wrapper.text()).toContain('第二页病人')
    expect(wrapper.text()).not.toContain('第一页病人')
  })
})

// ================================================================ PatientDetailView

describe('后台页面 · PatientDetailView', () => {
  it('渲染基础配置表单、成员表与记录概览', async () => {
    const { wrapper } = await mountView(PatientDetailView, '/patients/p-1')

    expect(api.patient).toHaveBeenCalledWith('p-1')
    const text = wrapper.text()
    expect(text).toContain('基础配置')
    expect(text).toContain('病人姓名')
    expect(text).toContain('成员（2）')
    expect(text).toContain('护工乙')
    expect(text).toContain('家属/护工')
    expect(text).toContain('记录概览（不含病历明细）')
    expect(text).toContain('记录条数')
    expect(text).toContain('危险操作')
    expect(tableRows(wrapper)).toHaveLength(2)

    // 表单被详情数据填充
    const nameInput = wrapper.findAll('input')[0]
    expect((nameInput.element as HTMLInputElement).value).toBe('病人一')
  })

  it('点击「保存配置」把表单值提交给 updatePatient', async () => {
    const { wrapper } = await mountView(PatientDetailView, '/patients/p-1')

    await buttonByText(wrapper, '保存配置').trigger('click')
    await flushPromises()

    expect(api.updatePatient).toHaveBeenCalledWith('p-1', {
      name: '病人一',
      birthday: '1950-03-02',
      wheelchairWeight: 20000,
      rinseBackVolume: 400,
    })
  })

  it('空成员列表 → 表格兜底文案', async () => {
    vi.mocked(api.patient).mockResolvedValue({
      ...PATIENT_DETAIL,
      members: [],
      stats: { sessionCount: 0, firstSessionDate: null, lastSessionDate: null },
    } as never)
    const { wrapper } = await mountView(PatientDetailView, '/patients/p-1')

    expect(wrapper.text()).toContain('成员（0）')
    expect(wrapper.text()).toContain('该病人还没有任何成员（无人能看到它）')
  })

  it('接口报错（病人不存在）→ 错误提示且所有 v-if=detail 的卡片都不渲染', async () => {
    vi.mocked(api.patient).mockRejectedValue(new Error('病人不存在'))
    const { wrapper } = await mountView(PatientDetailView, '/patients/p-404')

    const text = wrapper.text()
    expect(text).toContain('病人不存在')
    expect(text).not.toContain('基础配置')
    expect(text).not.toContain('危险操作')
    expect(tableRows(wrapper)).toHaveLength(0)
  })

  // ---- 中-1 / 低-4 ----

  it('改角色下拉不含「创建者」（创建者只能用「设为创建者」按钮转移）', async () => {
    const { wrapper } = await mountView(PatientDetailView, '/patients/p-1')

    const options = await openSelectOptions(wrapper)

    expect(options).toEqual(['家属/护工', '医生（只读）', '只读'])
    expect(options).not.toContain('创建者')
  })

  it('改角色失败 → 用服务端真值回填（下拉不能停在没生效的新值上）', async () => {
    vi.mocked(api.patient).mockResolvedValue({
      ...PATIENT_DETAIL,
      members: [PATIENT_DETAIL.members[1]], // 护工乙（非创建者才有下拉）
    } as never)
    vi.mocked(api.setMemberRole).mockRejectedValue(new Error('修改成员角色失败'))
    const error = vi.spyOn(ElMessage, 'error').mockImplementation(() => ({}) as never)
    const { wrapper } = await mountView(PatientDetailView, '/patients/p-1')

    await wrapper.findComponent({ name: 'ElSelect' }).vm.$emit('change', 'viewer')
    await flushPromises()

    expect(api.setMemberRole).toHaveBeenCalledWith('p-1', 'u-2', 'viewer')
    expect(api.patient).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledWith('修改成员角色失败')
    expect(wrapper.find('.el-select').text()).toContain('家属/护工')
  })

  it('创建者行不给改角色下拉，而是提示用「设为创建者」转移', async () => {
    const { wrapper } = await mountView(PatientDetailView, '/patients/p-1')

    // 两个成员里只有非创建者那行有下拉（创建者行显示提示文案）
    expect(wrapper.findAll('.el-select')).toHaveLength(1)
    expect(wrapper.text()).toContain('创建者（用「设为创建者」转移）')
  })

  it('danger：改角色即使传了 owner 也不发请求（下拉已无该选项，双保险）', async () => {
    const { wrapper } = await mountView(PatientDetailView, '/patients/p-1')

    await wrapper.findComponent({ name: 'ElSelect' }).vm.$emit('change', 'owner')
    await flushPromises()

    expect(api.setMemberRole).not.toHaveBeenCalled()
    expect(api.transferOwner).not.toHaveBeenCalled()
  })

  // ---- 中-2 ----

  it('危险确认框一律 autofocus:false（移除成员 / 转移创建者）', async () => {
    const { wrapper } = await mountView(PatientDetailView, '/patients/p-1')
    const spy = spyConfirm('cancel')

    await buttonByText(wrapper, '设为创建者').trigger('click')
    await flushPromises()
    await buttonByText(wrapper, '移除').trigger('click')
    await flushPromises()

    expect(spy).toHaveBeenCalledTimes(2)
    for (const call of spy.mock.calls) {
      expect(call[2]).toMatchObject({ autofocus: false })
    }
  })

  // ---- 低-1 / 低-2 ----

  it('删除对话框里病人姓名打码显示，且不会被误关（低-1/低-2）', async () => {
    const { wrapper } = await mountView(PatientDetailView, '/patients/p-1')
    await buttonByText(wrapper, '删除该病人及其全部数据').trigger('click')
    await nextTick()

    const del = dialogByTitle(wrapper, '删除病人')
    expect(del, '找不到删除病人对话框').toBeTruthy()
    expect(del!.props('closeOnClickModal')).toBe(false)
    expect(del!.props('closeOnPressEscape')).toBe(false)

    const text = del!.text()
    expect(text).toContain('病**') // 病人一 → 病**
    expect(text).not.toContain('病人一')
    // 输入框仍然要求完整姓名
    expect(del!.find('input[placeholder="完整姓名"]').exists()).toBe(true)
  })
})

// ================================================================ AuditView

describe('后台页面 · AuditView', () => {
  it('渲染操作日志：动作中文名、操作人、对象与变更摘要', async () => {
    const { wrapper } = await mountView(AuditView, '/audit')

    expect(api.audit).toHaveBeenCalledWith({ page: 1, size: 30 })
    expect(wrapper.text()).toContain('共 1 条')
    expect(tableRows(wrapper)).toHaveLength(1)

    const text = wrapper.text()
    expect(text).toContain('禁用账号') // user.ban → actionLabel
    expect(text).toContain('管理员甲')
    expect(text).toContain('user') // targetType
    expect(text).toContain('phone=13800000001')
    expect(text).toContain('nested={"a":1}') // 对象值走 JSON.stringify
  })

  it('detail 为空对象 → 摘要显示「—」', async () => {
    vi.mocked(api.audit).mockResolvedValue({
      total: 1,
      page: 1,
      size: 30,
      rows: [{ ...AUDIT_ROWS.rows[0], adminName: null, adminPhone: null, detail: { empty: '', nil: null } }],
    } as never)
    const { wrapper } = await mountView(AuditView, '/audit')

    expect(wrapper.text()).toContain('—')
    expect(wrapper.text()).toContain('u-admin'.slice(0, 8)) // 操作人回落到 id 前 8 位
  })

  it('空列表 → 兜底文案「暂无操作记录」；接口报错 → 提示且不崩', async () => {
    vi.mocked(api.audit).mockResolvedValue({ total: 0, page: 1, size: 30, rows: [] } as never)
    const empty = await mountView(AuditView, '/audit')
    expect(empty.wrapper.text()).toContain('暂无操作记录')
    expect(empty.wrapper.text()).toContain('共 0 条')

    vi.mocked(api.audit).mockRejectedValue(new Error('读取日志失败：relation does not exist'))
    const failed = await mountView(AuditView, '/audit')
    expect(failed.wrapper.text()).toContain('读取日志失败')
    expect(tableRows(failed.wrapper)).toHaveLength(0)
  })

  it('翻页竞态：先发的第 1 页请求后到，不覆盖第 2 页结果', async () => {
    const slow = deferred<never>()
    vi.mocked(api.audit)
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValueOnce({
        total: 60,
        page: 2,
        size: 30,
        rows: [{ ...AUDIT_ROWS.rows[0], id: 2, adminName: '第二页操作人' }],
      } as never)
    const { wrapper } = await mountView(AuditView, '/audit')

    await wrapper.findComponent(ElPagination).vm.$emit('current-change', 2)
    await flushPromises()
    expect(wrapper.text()).toContain('第二页操作人')

    slow.resolve({ ...AUDIT_ROWS, rows: [{ ...AUDIT_ROWS.rows[0], adminName: '第一页操作人' }] } as never)
    await flushPromises()

    expect(wrapper.text()).toContain('第二页操作人')
    expect(wrapper.text()).not.toContain('第一页操作人')
  })
})

// ================================================================ MeView

describe('后台页面 · MeView', () => {
  it('展示当前管理员的姓名/手机号/用户 ID', async () => {
    const { wrapper } = await mountView(MeView, '/me')

    const text = wrapper.text()
    expect(text).toContain('当前账号')
    expect(text).toContain('管理员甲')
    expect(text).toContain('13800000001')
    expect(text).toContain('u-admin')
    expect(text).toContain('管理员')
  })

  it('me 为空（whoami 失败）→ 用「未设置 / —」兜底，不崩', async () => {
    me.value = null
    const { wrapper } = await mountView(MeView, '/me')

    const text = wrapper.text()
    expect(text).toContain('未设置')
    expect(text).toContain('—')
  })

  it('新密码不足 6 位 / 两次不一致 → 就地警告，不调 supabase', async () => {
    const warn = vi.spyOn(ElMessage, 'warning').mockImplementation(() => ({}) as never)
    const { wrapper } = await mountView(MeView, '/me')
    const inputs = wrapper.findAll('input')
    expect(inputs).toHaveLength(2)

    await inputs[0].setValue('123')
    await buttonByText(wrapper, '保存').trigger('click')
    expect(warn).toHaveBeenCalledWith('新密码至少 6 位')
    expect(m.updateUser).not.toHaveBeenCalled()

    await inputs[0].setValue('secret1')
    await inputs[1].setValue('secret2')
    await buttonByText(wrapper, '保存').trigger('click')
    expect(warn).toHaveBeenCalledWith('两次输入的密码不一致')
    expect(m.updateUser).not.toHaveBeenCalled()
  })

  it('两次一致且不短 → 二次确认后调用 supabase.auth.updateUser 并成功提示', async () => {
    const success = vi.spyOn(ElMessage, 'success').mockImplementation(() => ({}) as never)
    const warn = vi.spyOn(ElMessage, 'warning').mockImplementation(() => ({}) as never)
    const confirm = spyConfirm('ok')
    m.updateUser.mockResolvedValue({ error: null })
    const { wrapper } = await mountView(MeView, '/me')

    const inputs = wrapper.findAll('input')
    await inputs[0].setValue('secret1')
    await inputs[1].setValue('secret1')
    await buttonByText(wrapper, '保存').trigger('click')
    await flushPromises()

    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0][2]).toMatchObject({ autofocus: false })
    expect(m.updateUser).toHaveBeenCalledWith({ password: 'secret1' })
    expect(success).toHaveBeenCalledWith('密码已修改，下次登录请使用新密码')
    expect(warn).not.toHaveBeenCalled()
  })

  it('二次确认点「取消」→ 不改密码', async () => {
    spyConfirm('cancel')
    const { wrapper } = await mountView(MeView, '/me')

    const inputs = wrapper.findAll('input')
    await inputs[0].setValue('secret1')
    await inputs[1].setValue('secret1')
    await buttonByText(wrapper, '保存').trigger('click')
    await flushPromises()

    expect(m.updateUser).not.toHaveBeenCalled()
  })

  it('表单下方写明「后台没有找回密码入口」', async () => {
    const { wrapper } = await mountView(MeView, '/me')
    expect(wrapper.text()).toContain('后台没有找回密码入口')
    expect(wrapper.text()).toContain('可先请另一位管理员重置')
  })

  it('唯一管理员（adminCount<=1）→ 显示更强的警告，确认文案点明无人能重置', async () => {
    vi.mocked(api.overview).mockResolvedValue({ ...OVERVIEW, adminCount: 1 } as never)
    const confirm = spyConfirm('ok')
    const { wrapper } = await mountView(MeView, '/me')

    expect(wrapper.text()).toContain('你是当前唯一的管理员')

    const inputs = wrapper.findAll('input')
    await inputs[0].setValue('secret1')
    await inputs[1].setValue('secret1')
    await buttonByText(wrapper, '保存').trigger('click')
    await flushPromises()

    expect(String(confirm.mock.calls[0][0])).toContain('没有人能帮你重置')
  })

  it('不是唯一管理员（adminCount>1）→ 不显示强警告，确认文案仍是通用说明', async () => {
    const confirm = spyConfirm('ok')
    const { wrapper } = await mountView(MeView, '/me')

    expect(wrapper.text()).not.toContain('你是当前唯一的管理员')

    const inputs = wrapper.findAll('input')
    await inputs[0].setValue('secret1')
    await inputs[1].setValue('secret1')
    await buttonByText(wrapper, '保存').trigger('click')
    await flushPromises()

    expect(confirm).toHaveBeenCalledOnce()
    expect(String(confirm.mock.calls[0][0])).toContain('后台没有找回密码入口')
  })

  it('取管理员总数失败（接口异常）→ 不显示强警告，也不挡住改密码', async () => {
    vi.mocked(api.overview).mockRejectedValue(new Error('无后台权限'))
    spyConfirm('ok')
    m.updateUser.mockResolvedValue({ error: null })
    const { wrapper } = await mountView(MeView, '/me')

    expect(wrapper.text()).not.toContain('你是当前唯一的管理员')

    const inputs = wrapper.findAll('input')
    await inputs[0].setValue('secret1')
    await inputs[1].setValue('secret1')
    await buttonByText(wrapper, '保存').trigger('click')
    await flushPromises()

    expect(m.updateUser).toHaveBeenCalledWith({ password: 'secret1' })
  })

  it('改密码失败 → 用 messageOf 的错误文案提示', async () => {
    const error = vi.spyOn(ElMessage, 'error').mockImplementation(() => ({}) as never)
    spyConfirm('ok')
    m.updateUser.mockResolvedValue({ error: new Error('New password should be different') })
    const { wrapper } = await mountView(MeView, '/me')

    const inputs = wrapper.findAll('input')
    await inputs[0].setValue('secret1')
    await inputs[1].setValue('secret1')
    await buttonByText(wrapper, '保存').trigger('click')
    await flushPromises()

    expect(error).toHaveBeenCalledWith('New password should be different')
  })
})

// ================================================================ AdminLayout

describe('后台布局 · AdminLayout', () => {
  it('渲染菜单、路由标题与当前管理员，并托管子路由', async () => {
    const { wrapper } = await mountView(AdminLayout, '/users')

    const text = wrapper.text()
    expect(text).toContain('透析记录 · 后台')
    for (const item of ['概览', '用户管理', '病人管理', '操作日志', '我的账号']) {
      expect(text).toContain(item)
    }
    expect(text).toContain('用户管理') // route.meta.title
    expect(text).toContain('管理员甲') // me.name
    expect(text).toContain('管理员')
    expect(wrapper.find('.stub-page').exists()).toBe(true) // router-view 渲染出子页面

    wrapper.unmount() // 清掉 30 分钟空闲定时器
  })

  it('me 为空 → 用「管理员」兜底', async () => {
    me.value = null
    const { wrapper } = await mountView(AdminLayout, '/')

    expect(wrapper.find('.admin-who').text()).toContain('管理员')
    wrapper.unmount()
  })

  it('路由 meta.title 变化时标题跟着变（概览 / 操作日志）', async () => {
    const { wrapper, router } = await mountView(AdminLayout, '/')

    expect(wrapper.find('.admin-title').text()).toBe('概览')
    await router.push('/audit')
    await flushPromises()
    expect(wrapper.find('.admin-title').text()).toBe('操作日志')
    expect(wrapper.find('.admin-title').text()).not.toBe('概览')

    wrapper.unmount()
  })

  it('lastWarning 变化 → 弹出 warning 提示并清空（审计写入失败可见）', async () => {
    const warn = vi.spyOn(ElMessage, 'warning').mockImplementation(() => ({}) as never)
    const { wrapper } = await mountView(AdminLayout, '/')

    lastWarning.value = '操作已执行，但审计日志写入失败：boom'
    await nextTick()

    expect(warn).toHaveBeenCalledWith('操作已执行，但审计日志写入失败：boom')
    expect(lastWarning.value).toBeNull() // 提示一次后清空，避免重复弹

    wrapper.unmount()
  })

  it('点击「退出登录」→ 调 logout 并回到登录页', async () => {
    const { wrapper, router } = await mountView(AdminLayout, '/')

    await buttonByText(wrapper, '退出登录').trigger('click')
    await flushPromises()

    expect(m.logout).toHaveBeenCalled()
    expect(router.currentRoute.value.fullPath).toBe('/login')
    wrapper.unmount()
  })
})

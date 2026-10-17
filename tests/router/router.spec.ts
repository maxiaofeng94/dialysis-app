/**
 * src/router/index.ts 单元测试
 *
 * 三个难点：
 * 1. router 是模块级单例，`patientContextUid` 也是模块级变量 —— 每个用例都必须
 *    vi.resetModules() + 动态 import 才能拿到「上下文为空」的新实例；
 * 2. 视图组件全部 vi.doMock 成空组件，避免真渲染拉进 ECharts / Vant / 仓储；
 * 3. 守卫里的 useAuth() 被替换成可控的假 store（ref + spy），用来驱动
 *    「未初始化 / 未登录 / 已登录 / 换账号 / 登出」各种状态。
 */
import { describe, it, expect, vi } from 'vitest'
import { ref, computed } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fakeSupabaseModule } from '../helpers/cloud'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

/** 等一轮宏任务：Vue 的 watch 是异步 flush 的，改完登录态要让它跑完 */
const flushWatch = () => new Promise((r) => setTimeout(r, 0))

/** 需要打桩的视图（避免 import 真组件） */
const VIEW_NAMES = [
  'HomeView',
  'SessionView',
  'ReportView',
  'TrendView',
  'SettingsView',
  'LoginView',
  'MembersView',
]

interface Scenario {
  /** 是否配置云端（本地模式为 false） */
  configured?: boolean
  /** 初始登录用户（null = 未登录） */
  user?: { id: string } | null
  /** initialized 初值；true 表示「已经初始化过」，守卫不会再调 init() */
  initialized?: boolean
  /** 初始的当前病人 id（默认是本地默认 id，代表「还没校准」） */
  patientId?: string
}

/** 校准成功后当前病人会变成的真实 uuid（真实实现里 ensureCloudPatient 负责设置） */
const REAL_PATIENT_ID = 'p-real'

/** 装载一份全新的 router（含守卫依赖的间谍） */
async function loadRouter(scenario: Scenario = {}) {
  const configured = scenario.configured ?? true

  const user = ref<{ id: string } | null>(scenario.user ?? null)
  const initialized = ref(scenario.initialized ?? false)
  const isLoggedIn = computed(() => configured && !!user.value)
  const init = vi.fn(async () => {
    initialized.value = true
  })

  const restorePatientId = vi.fn(async () => {})
  const currentPatientId = ref(scenario.patientId ?? 'patient-default')
  const ensureCloudPatient = vi.fn(async () => {
    // 真实实现：校准成功后 currentPatientId 会被设成真实 uuid（不是本地默认 id）
    currentPatientId.value = REAL_PATIENT_ID
  })

  vi.doMock('../../src/stores/auth', () => ({
    useAuth: () => ({ user, initialized, isLoggedIn, init, register: vi.fn(), login: vi.fn(), logout: vi.fn() }),
    user,
    initialized,
    isLoggedIn,
  }))
  vi.doMock('../../src/stores/patient', () => ({
    restorePatientId,
    ensureCloudPatient,
    currentPatientId,
    setCurrentPatientId: vi.fn(),
    clearCurrentPatient: vi.fn(),
    hasNoCloudPatient: vi.fn(),
  }))
  vi.doMock('../../src/lib/supabase', () => fakeSupabaseModule({ configure: configured }))
  vi.doMock('../../src/lib/cloudCache', () => ({ cacheClear: vi.fn(async () => {}), cacheVersion: ref(0) }))
  for (const name of VIEW_NAMES) {
    vi.doMock(`../../src/views/${name}.vue`, () => ({ default: { name, template: '<div/>' } }))
  }

  vi.resetModules()
  const mod = await import('../../src/router/index')

  return {
    router: mod.default,
    init,
    restorePatientId,
    ensureCloudPatient,
    user,
    initialized,
    isLoggedIn,
    currentPatientId,
  }
}

/** 导航到某路径并返回最终落在的路由 */
async function go(router: { push: (p: string) => Promise<unknown>; isReady: () => Promise<void>; currentRoute: { value: { path: string } } }, path: string) {
  await router.push(path)
  await router.isReady()
  return router.currentRoute.value.path
}

describe('路由表', () => {
  it('七个页面路由都存在且路径正确', async () => {
    const { router } = await loadRouter({ configured: false })
    const byName = Object.fromEntries(router.getRoutes().map((r) => [r.name, r]))

    expect(Object.keys(byName).sort()).toEqual(
      ['home', 'login', 'members', 'report', 'session', 'settings', 'trend'].sort(),
    )
    expect(byName.home.path).toBe('/')
    expect(byName.session.path).toBe('/session/:id')
    expect(byName.report.path).toBe('/report/:id')
    expect(byName.trend.path).toBe('/trend')
    expect(byName.settings.path).toBe('/settings')
    expect(byName.login.path).toBe('/login')
    expect(byName.members.path).toBe('/members')
  })

  it('home / trend / settings 带 meta.tabbar，其余页面不带', async () => {
    const { router } = await loadRouter({ configured: false })
    const byName = Object.fromEntries(router.getRoutes().map((r) => [r.name, r]))

    expect(byName.home.meta.tabbar).toBe(true)
    expect(byName.trend.meta.tabbar).toBe(true)
    expect(byName.settings.meta.tabbar).toBe(true)

    expect(byName.session.meta.tabbar).toBeUndefined()
    expect(byName.report.meta.tabbar).toBeUndefined()
    expect(byName.login.meta.tabbar).toBeUndefined()
    expect(byName.members.meta.tabbar).toBeUndefined()
  })

  it('每条路由都挂了组件', async () => {
    const { router } = await loadRouter({ configured: false })
    expect(router.getRoutes().every((r) => r.components?.default)).toBe(true)
  })
})

describe('本地模式（未配置 Supabase）', () => {
  it.each(['/', '/trend', '/settings', '/session/s-1', '/report/s-1', '/members', '/login'])(
    '访问 %s 不做登录跳转',
    async (path) => {
      const { router } = await loadRouter({ configured: false })
      expect(await go(router, path)).toBe(path)
    },
  )

  it('本地模式不受 patientContextUid 影响，也不去校准病人', async () => {
    const { router, restorePatientId, ensureCloudPatient } = await loadRouter({ configured: false })
    await go(router, '/')
    await go(router, '/settings')
    expect(restorePatientId).not.toHaveBeenCalled()
    expect(ensureCloudPatient).not.toHaveBeenCalled()
  })

  it('守卫仍会调用一次 init()（与是否配置云端无关；初始化后不再重复调用）', async () => {
    const { router, init } = await loadRouter({ configured: false })

    await go(router, '/settings')
    await go(router, '/')

    // 实现里 `if (!initialized.value) await init()` 在云端判断之前，因此本地模式也会调用；
    // 代价只是把 initialized 置 true（真实 store 在本地模式下的 init() 是空操作）。
    expect(init).toHaveBeenCalledTimes(1)
  })
})

describe('云端模式 · 未初始化', () => {
  it('首次导航调用 init()，之后不再重复调用', async () => {
    const { router, init, initialized } = await loadRouter({ configured: true, initialized: false })

    await go(router, '/trend')

    expect(init).toHaveBeenCalledTimes(1)
    expect(initialized.value).toBe(true)

    await go(router, '/settings')
    expect(init).toHaveBeenCalledTimes(1)
  })

  it('未登录时即使重定向到 /login，init() 也只调用一次', async () => {
    const { router, init } = await loadRouter({ configured: true, initialized: false, user: null })
    expect(await go(router, '/')).toBe('/login')
    expect(init).toHaveBeenCalledTimes(1)
  })
})

describe('云端模式 · 未登录', () => {
  it.each(['/', '/trend', '/settings', '/session/s-1', '/report/s-1', '/members'])(
    '访问 %s 重定向到 /login',
    async (path) => {
      const { router } = await loadRouter({ configured: true, initialized: true, user: null })
      expect(await go(router, path)).toBe('/login')
    },
  )

  it('未登录时不做病人上下文校准', async () => {
    const { router, restorePatientId, ensureCloudPatient } = await loadRouter({
      configured: true,
      initialized: true,
      user: null,
    })
    await go(router, '/settings')
    expect(restorePatientId).not.toHaveBeenCalled()
    expect(ensureCloudPatient).not.toHaveBeenCalled()
  })

  it('/login 本身可以进（不会自我重定向成死循环）', async () => {
    const { router } = await loadRouter({ configured: true, initialized: true, user: null })
    expect(await go(router, '/login')).toBe('/login')
  })
})

describe('云端模式 · 已登录', () => {
  it('访问 /login 会重定向到首页', async () => {
    const { router } = await loadRouter({ configured: true, initialized: true, user: { id: 'u1' } })
    expect(await go(router, '/login')).toBe('/')
  })

  it('首次导航建立病人上下文：restorePatientId + ensureCloudPatient 各一次', async () => {
    const { router, restorePatientId, ensureCloudPatient } = await loadRouter({
      configured: true,
      initialized: true,
      user: { id: 'u1' },
    })

    expect(await go(router, '/')).toBe('/')

    expect(restorePatientId).toHaveBeenCalledTimes(1)
    expect(ensureCloudPatient).toHaveBeenCalledTimes(1)
  })

  it('同一个账号第二次导航不重复校准（patientContextUid 命中缓存）', async () => {
    const { router, restorePatientId, ensureCloudPatient } = await loadRouter({
      configured: true,
      initialized: true,
      user: { id: 'u1' },
    })

    await go(router, '/')
    await go(router, '/trend')
    await go(router, '/settings')

    expect(restorePatientId).toHaveBeenCalledTimes(1)
    expect(ensureCloudPatient).toHaveBeenCalledTimes(1)
  })

  it('账号变化（换账号登录）会重新建立上下文', async () => {
    const { router, restorePatientId, ensureCloudPatient, user } = await loadRouter({
      configured: true,
      initialized: true,
      user: { id: 'u1' },
    })

    await go(router, '/')
    expect(restorePatientId).toHaveBeenCalledTimes(1)

    user.value = { id: 'u2' }
    await go(router, '/trend')

    expect(restorePatientId).toHaveBeenCalledTimes(2)
    expect(ensureCloudPatient).toHaveBeenCalledTimes(2)
  })

  it('登出会重置上下文，重新登录后再次建立（不会沿用上一个账号的病人）', async () => {
    const { router, restorePatientId, ensureCloudPatient, user } = await loadRouter({
      configured: true,
      initialized: true,
      user: { id: 'u1' },
    })

    await go(router, '/')
    expect(restorePatientId).toHaveBeenCalledTimes(1)

    // 登出：未登录访问任意页面 → 跳登录页并把 patientContextUid 置回 undefined
    user.value = null
    expect(await go(router, '/settings')).toBe('/login')

    // 同一账号重新登录：上下文已被重置，必须重新校准
    user.value = { id: 'u1' }
    expect(await go(router, '/')).toBe('/')
    expect(restorePatientId).toHaveBeenCalledTimes(2)
    expect(ensureCloudPatient).toHaveBeenCalledTimes(2)
  })

  /**
   * 回归：手机上「退出登录 → 重新登录」后首页一个病人都没有、也看不到任何记录。
   *
   * 真实路径和上面那条**不一样**：设置页的退出登录是 `await logout()` 之后**直接**
   * `router.replace('/login')`，守卫走的是 `to.path === '/login'` 那条分支并直接 return ——
   * 从前那里不重置 `patientContextUid`，于是重新登录同一账号时被判定为「上下文已建好」，
   * 跳过了 `ensureCloudPatient()`；而登出时 `clearCurrentPatient()` 已把当前病人抹成
   * `patient-default`（不是 uuid），首页拿它查云端只会短路成空。
   * Web 端一直登录着（冷启动路径 patientContextUid 为 undefined）所以看不出来。
   */
  it('登出后「直接」回 /login（设置页的真实路径）：重新登录同一账号必须重新校准病人', async () => {
    const { router, ensureCloudPatient, user, currentPatientId } = await loadRouter({
      configured: true,
      initialized: true,
      user: { id: 'u1' },
    })

    await go(router, '/')
    expect(ensureCloudPatient).toHaveBeenCalledTimes(1)
    expect(currentPatientId.value).toBe(REAL_PATIENT_ID)

    // 主动登出：清掉登录态 + 当前病人（clearCurrentPatient 的效果），随后直接 replace('/login')
    user.value = null
    currentPatientId.value = 'patient-default'
    expect(await go(router, '/login')).toBe('/login')

    // 同一账号重新登录 → 必须重新校准，否则首页会拿 patient-default 查云端、什么都查不到
    user.value = { id: 'u1' }
    expect(await go(router, '/')).toBe('/')

    expect(ensureCloudPatient).toHaveBeenCalledTimes(2)
    expect(currentPatientId.value).toBe(REAL_PATIENT_ID)
  })

  it('即使当前病人没被重置，只要回过登录页就作废上下文（第二道防线）', async () => {
    const { router, ensureCloudPatient, user } = await loadRouter({
      configured: true,
      initialized: true,
      user: { id: 'u1' },
    })

    await go(router, '/')
    expect(ensureCloudPatient).toHaveBeenCalledTimes(1)

    // 登出，但当前病人 id 没有回到默认值（例如某条路径漏了 clearCurrentPatient）
    user.value = null
    expect(await go(router, '/login')).toBe('/login')

    user.value = { id: 'u1' }
    await go(router, '/')

    expect(ensureCloudPatient).toHaveBeenCalledTimes(2)
  })

  /**
   * 回归（本轮评审发现）：**账号确实一个病人都没有**时，`currentPatientId` 会一直是默认值。
   * 如果「当前病人是默认值」被当成「没校准过」，那每次导航都会重新拉一次病人列表
   * （评审实测：4 次导航打出 2 次 `patient_members`，只是被 FRESH_MS 闸门压住了）。
   * 现在用「本次是否真的校准成功」来区分。
   */
  it('账号一个病人都没有时，不会每次导航都重新拉病人列表', async () => {
    const { router, ensureCloudPatient, currentPatientId, user } = await loadRouter({
      configured: true,
      initialized: true,
      user: { id: 'u1' },
    })
    // 模拟「这个账号没有病人」：校准跑完但当前病人仍是默认值
    ensureCloudPatient.mockImplementation(async () => {})
    currentPatientId.value = 'patient-default'

    await go(router, '/')
    await go(router, '/trend')
    await go(router, '/settings')

    expect(ensureCloudPatient).toHaveBeenCalledTimes(1)
    expect(user.value).toEqual({ id: 'u1' })
  })

  /**
   * 回归：作废病人上下文**绑在登录态上**，而不是依赖「有没有导航到 /login」。
   *
   * 守卫里那两处重置只在确实发生过一次导航时才执行。将来若有人加了新的登出入口
   * 却忘了 `router.replace('/login')`，`patientContextUid` 会停在上一个账号上 ——
   * 「重新登录后没有任何记录」就会原样复现。这条用例只改登录态、**不做任何导航**。
   */
  it('登出立即作废病人上下文（即使一次导航都没发生）', async () => {
    const { router, ensureCloudPatient, user } = await loadRouter({
      configured: true,
      initialized: true,
      user: { id: 'u1' },
    })
    await go(router, '/')
    expect(ensureCloudPatient).toHaveBeenCalledTimes(1)

    // 只把登录态置空，不导航（模拟「某个登出入口忘了跳 /login」）
    user.value = null
    await flushWatch() // 等 watch 触发

    // 同一账号重新登录 → 必须重新校准。
    // 注意：这里必须导航到**不同**路径 —— push 到与当前相同的路由时
    // Vue Router 会忽略这次导航，守卫根本不会执行（这条用例第一版就踩了）
    user.value = { id: 'u1' }
    await go(router, '/trend')

    expect(ensureCloudPatient).toHaveBeenCalledTimes(2)
  })

  /**
   * 守卫超时（`withTimeout` 兜底）时不能把「没跑完」当成「校准成功」——
   * 否则再也不会重试，用户会一直停在「没有病人 / 没有记录」的假象上。
   * 这里做静态断言而不是真等 10 秒超时（那会让整个套件慢十几秒）。
   */
  it('守卫把「成功」与「超时」区分开（超时不算校准成功）', () => {
    expect(read('src/router/index.ts')).toMatch(/ensureCloudPatient\(\)\.then\(\(\) => true\)/)
    expect(read('src/router/index.ts')).toMatch(/patientContextSynced = synced/)
  })
})

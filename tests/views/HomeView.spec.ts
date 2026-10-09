/**
 * HomeView（首页）组件测试
 *
 * 覆盖：加载骨架、病人档案卡片、体重输入清洗（纯前端关键逻辑）、快速创建预览与落库、
 * 无病人/云端无病人的空状态、记录列表分组与状态展示、cacheVersion 触发的重读。
 *
 * 约定：
 * - 数据层整体 mock，测试不碰 IndexedDB / 网络；
 * - 时间用 fake Date 冻结点（只 fake Date，不 fake 定时器，flushPromises 才不会被卡住）；
 * - Vant 弹层默认 teleport 到 body，这里用 `stubs: { teleport: true }` 渲染回组件树内，
 *   否则断言不到弹窗里的按钮（jsdom 下这是最稳的做法）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { defineComponent, h, type Ref } from 'vue'
import Vant from 'vant'
import HomeView from '../../src/views/HomeView.vue'
import { repository } from '../../src/repo'
import { cacheVersion } from '../../src/lib/cloudCache'
import { makePatient, makeDryWeight, makeSession, resetIdSeq } from '../helpers/factories'

// vi.hoisted：mock 工厂先于 import 执行，桩必须在这里创建
const mocks = vi.hoisted(() => ({
  currentPatientId: { value: 'patient-default' },
  hasNoCloudPatient: vi.fn(async () => false),
  isLoggedIn: { value: false },
  uuid: vi.fn(() => 'uuid-fixed-1'),
  showToast: vi.fn(),
  showConfirmDialog: vi.fn(async () => undefined),
  refreshCurrentRole: vi.fn(async () => undefined),
  /** 由下面的 vi.mock 工厂填入真实 ref（模板里要自动解包，必须是 ref 而不是普通对象） */
  patientStore: { isReadOnly: null as unknown as Ref<boolean> },
}))

vi.mock('../../src/repo', () => ({
  repository: {
    getPatient: vi.fn(),
    listDryWeights: vi.fn(),
    listSessions: vi.fn(),
    saveSession: vi.fn(async () => undefined),
  },
}))

// 病人上下文与登录态：本地单机模式下 isLoggedIn 恒为 false，云端分支由用例自行改写
vi.mock('../../src/stores/patient', async () => {
  const { ref } = await import('vue')
  // 真实实现里 isReadOnly 是 computed(() => currentRole === 'doctor' || 'viewer')，
  // 视图测试只关心「只读时首页长什么样」，这里给一个可写 ref
  const isReadOnly = ref(false)
  mocks.patientStore.isReadOnly = isReadOnly
  return {
    currentPatientId: mocks.currentPatientId,
    hasNoCloudPatient: mocks.hasNoCloudPatient,
    currentRole: ref<string | null>(null),
    isReadOnly,
    refreshCurrentRole: mocks.refreshCurrentRole,
  }
})
vi.mock('../../src/stores/auth', () => ({ isLoggedIn: mocks.isLoggedIn }))

// 固定 uuid，便于断言跳转地址
vi.mock('../../src/utils/id', () => ({ uuid: mocks.uuid }))

// 只替换命令式弹层 API，其余（组件、指令）保持真实，供 app.use(Vant) 注册
vi.mock('vant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vant')>()
  return { ...actual, showToast: mocks.showToast, showConfirmDialog: mocks.showConfirmDialog }
})

const Blank = defineComponent({ render: () => h('div') })

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Blank },
      { path: '/session/:id', component: Blank },
      { path: '/settings', component: Blank },
    ],
  })
}

let wrapper: VueWrapper | null = null
let router: Router

/** 固定「今天」，让 todayStr()/calcAge() 的断言与运行日期无关 */
function freezeToday(): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2024-06-01T10:00:00'))
}

async function mountHome(path = '/'): Promise<VueWrapper> {
  router = makeRouter()
  await router.push(path)
  await router.isReady()
  wrapper = mount(HomeView, {
    global: { plugins: [Vant, router], stubs: { teleport: true } },
  })
  return wrapper
}

function stubData(opts: {
  patient?: ReturnType<typeof makePatient> | null
  dryWeights?: ReturnType<typeof makeDryWeight>[]
  sessions?: ReturnType<typeof makeSession>[]
} = {}) {
  vi.mocked(repository.getPatient).mockResolvedValue(opts.patient ?? undefined)
  vi.mocked(repository.listDryWeights).mockResolvedValue(opts.dryWeights ?? [])
  vi.mocked(repository.listSessions).mockResolvedValue(opts.sessions ?? [])
}

/** 切换当前账号是否只读（doctor / viewer → true） */
function setReadOnly(readOnly: boolean): void {
  mocks.patientStore.isReadOnly.value = readOnly
}

/** 按文案找按钮（找不到就抛错，避免断言在 undefined 上静默通过） */
function buttonByText(w: VueWrapper, text: string) {
  const btn = w.findAll('button').find((b) => b.text().includes(text))
  if (!btn) throw new Error(`未找到文案包含「${text}」的按钮`)
  return btn
}

beforeEach(() => {
  resetIdSeq()
  freezeToday()
  vi.mocked(repository.getPatient).mockReset()
  vi.mocked(repository.listDryWeights).mockReset()
  vi.mocked(repository.listSessions).mockReset()
  vi.mocked(repository.saveSession).mockReset().mockResolvedValue(undefined)
  mocks.isLoggedIn.value = false
  mocks.hasNoCloudPatient.mockReset().mockResolvedValue(false)
  mocks.uuid.mockReset().mockReturnValue('uuid-fixed-1')
  mocks.showToast.mockReset()
  mocks.showConfirmDialog.mockReset().mockResolvedValue(undefined)
  setReadOnly(false)
  mocks.refreshCurrentRole.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
})

describe('HomeView · 加载状态', () => {
  it('加载中先显示骨架，数据返回后骨架消失并渲染档案卡', async () => {
    stubData({ patient: makePatient() })
    const w = await mountHome()

    expect(w.findComponent({ name: 'VanSkeleton' }).exists()).toBe(true)

    await flushPromises()
    expect(w.findComponent({ name: 'VanSkeleton' }).exists()).toBe(false)
    expect(w.find('.patient-card').exists()).toBe(true)
  })

  it('加载时就并行请求病人/干体重/记录（三个请求都发出）', async () => {
    stubData({ patient: makePatient() })
    await mountHome()
    await flushPromises()

    expect(repository.getPatient).toHaveBeenCalledWith('patient-default')
    expect(repository.listDryWeights).toHaveBeenCalledWith('patient-default')
    expect(repository.listSessions).toHaveBeenCalledWith('patient-default')
  })
})

describe('HomeView · 病人档案卡片', () => {
  it('显示姓名首字头像、姓名与年龄徽标', async () => {
    stubData({ patient: makePatient({ name: '张三', birthday: '1950-06-01' }) })
    const w = await mountHome()
    await flushPromises()

    expect(w.find('.avatar').text()).toBe('张')
    expect(w.find('.patient-name').text()).toBe('张三')
    // 冻结在 2024-06-01：1950-06-01 生日当天正好 74 岁
    expect(w.find('.age-badge').text()).toBe('74 岁')
  })

  it('干体重按「今天」取有效值（未来生效的那条不算数）', async () => {
    stubData({
      patient: makePatient({ wheelchairWeight: 20, rinseBackVolume: 300 }),
      dryWeights: [
        makeDryWeight({ id: 'd1', value: 60, effectiveDate: '2024-01-01' }),
        makeDryWeight({ id: 'd2', value: 62, effectiveDate: '2024-07-01' }),
      ],
    })
    const w = await mountHome()
    await flushPromises()

    const stats = w.findAll('.pstat-v').map((n) => n.text())
    expect(stats[0]).toBe('60.0kg') // 干体重
    expect(stats[1]).toBe('20.0kg') // 轮椅重量
    expect(stats[2]).toBe('300ml') // 回水量
  })

  it('没有干体重记录时干体重显示占位符 —', async () => {
    stubData({ patient: makePatient(), dryWeights: [] })
    const w = await mountHome()
    await flushPromises()

    expect(w.findAll('.pstat-v')[0].text()).toBe('—kg')
  })
})

describe('HomeView · 体重输入清洗（onWeightInput）', () => {
  /** 往快速创建输入框里打一段文本，返回清洗后实际留在输入框里的值 */
  async function typeWeight(text: string): Promise<string> {
    const input = wrapper!.find('input.quick-input')
    await input.setValue(text)
    return (input.element as HTMLInputElement).value
  }

  beforeEach(() => {
    stubData({ patient: makePatient() })
  })

  it('半角逗号被当成小数点', async () => {
    await mountHome()
    await flushPromises()

    expect(await typeWeight('70,5')).toBe('70.5')
  })

  it('剔除字母/符号等非数字字符', async () => {
    await mountHome()
    await flushPromises()

    expect(await typeWeight('12a3b4')).toBe('1234')
  })

  it('只保留第一个小数点，多余的被删掉', async () => {
    await mountHome()
    await flushPromises()

    expect(await typeWeight('1.2.3')).toBe('1.23')
    expect(await typeWeight('1..2')).toBe('1.2')
  })

  it('超过 8 位直接截断', async () => {
    await mountHome()
    await flushPromises()

    expect(await typeWeight('123456789')).toBe('12345678')
  })

  it('全角（中文输入法）逗号也当小数点：70，5 → 70.5（不能剔成 705）', async () => {
    await mountHome()
    await flushPromises()

    // 只认半角逗号时，「，」会被 [^\d.] 删掉 → 70，5 变成 705（10 倍体重误差）
    expect(await typeWeight('70，5')).toBe('70.5')
  })
})

describe('HomeView · 快速创建预览', () => {
  it('填 80.5 / 轮椅 20 / 干体重 60 → 实际体重 60.5、计划脱水 0.5', async () => {
    stubData({
      patient: makePatient({ wheelchairWeight: 20 }),
      dryWeights: [makeDryWeight({ value: 60, effectiveDate: '2024-01-01' })],
    })
    const w = await mountHome()
    await flushPromises()

    await w.find('input.quick-input').setValue('80.5')

    const vals = w.findAll('.stat-value').map((n) => n.text())
    expect(vals[0]).toBe('60.5 kg') // 80.5 - 20
    expect(vals[1]).toBe('0.5 L') // 60.5 - 60
  })

  it('未填体重时不计算，两栏都是占位符', async () => {
    stubData({ patient: makePatient(), dryWeights: [makeDryWeight({ value: 60 })] })
    const w = await mountHome()
    await flushPromises()

    const vals = w.findAll('.stat-value').map((n) => n.text())
    expect(vals[0]).toBe('— kg')
    expect(vals[1]).toBe('— L')
  })

  it('没有病人档案时不显示预览数字，改为提示去设置', async () => {
    stubData({ patient: null })
    const w = await mountHome()
    await flushPromises()

    expect(w.findAll('.stat-value')).toHaveLength(0)
    expect(w.find('.quick-hint').text()).toContain('请先到「设置」建立病人档案')
  })
})

describe('HomeView · 立即创建记录', () => {
  it('有病人：按输入体重写入 session（快照轮椅/回水）并跳转详情页', async () => {
    stubData({ patient: makePatient({ wheelchairWeight: 20, rinseBackVolume: 300 }) })
    const w = await mountHome()
    await flushPromises()

    await w.find('input.quick-input').setValue('80.5')
    await w.find('.quick-btn').trigger('click')
    await flushPromises()

    expect(repository.saveSession).toHaveBeenCalledTimes(1)
    const saved = vi.mocked(repository.saveSession).mock.calls[0][0]
    expect(saved).toMatchObject({
      id: 'uuid-fixed-1',
      patientId: 'patient-default',
      date: '2024-06-01', // 冻结的「今天」
      preWeightMeasured: 80.5, // 直接存输入值（含轮椅），不做减法
      postWeightMeasured: null,
      wheelchairWeightUsed: 20,
      rinseBackVolumeUsed: 300,
      operator: null,
      doctorUf: null,
      status: 'ongoing',
      abortedAt: null,
      abortTags: [],
      abortReason: null,
      notes: null,
    })
    expect(saved.createdAt).toBe(Date.now())
    expect(saved.updatedAt).toBe(Date.now())
    expect(router.currentRoute.value.path).toBe('/session/uuid-fixed-1')
  })

  it('未填体重：弹提示、不写库、不跳转', async () => {
    stubData({ patient: makePatient() })
    const w = await mountHome()
    await flushPromises()

    await w.find('.quick-btn').trigger('click')
    await flushPromises()

    expect(mocks.showConfirmDialog).toHaveBeenCalledTimes(1)
    expect(mocks.showConfirmDialog.mock.calls[0][0]).toMatchObject({
      title: '提示',
      showCancelButton: false,
    })
    expect(String(mocks.showConfirmDialog.mock.calls[0][0].message)).toContain('请先填写上机前体重')
    expect(repository.saveSession).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('没有病人档案时点「立即创建」直接引导去设置页，不写库', async () => {
    stubData({ patient: null })
    const w = await mountHome()
    await flushPromises()

    await w.find('.quick-btn').trigger('click')
    await flushPromises()

    expect(repository.saveSession).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/settings')
  })

  it('「＋ 新建」确认后创建一条空白记录（无上机前体重）', async () => {
    stubData({ patient: makePatient() })
    const w = await mountHome()
    await flushPromises()

    const newBtn = w.findAll('button').find((b) => b.text().includes('新建'))
    expect(newBtn).toBeTruthy()
    await newBtn!.trigger('click')
    await flushPromises()

    // 弹窗已渲染（teleport 被 stub 回组件树内）
    const confirmBtn = w.findAll('button').find((b) => b.text() === '创建')
    expect(confirmBtn).toBeTruthy()
    await confirmBtn!.trigger('click')
    await flushPromises()

    expect(repository.saveSession).toHaveBeenCalledTimes(1)
    expect(vi.mocked(repository.saveSession).mock.calls[0][0].preWeightMeasured).toBeNull()
    expect(router.currentRoute.value.path).toBe('/session/uuid-fixed-1')
  })
})

describe('HomeView · 无病人档案的空状态', () => {
  it('本地模式：显示「请先建立病人档案」与「去设置」按钮，点击跳设置页', async () => {
    stubData({ patient: null })
    const w = await mountHome()
    await flushPromises()

    expect(w.text()).toContain('请先建立病人档案')
    const goBtn = w.findAll('button').find((b) => b.text().includes('去设置'))
    expect(goBtn).toBeTruthy()

    await goBtn!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/settings')
  })

  it('云端已登录且一个病人都没有：文案切换为「新建或上传本地数据」', async () => {
    mocks.isLoggedIn.value = true
    mocks.hasNoCloudPatient.mockResolvedValue(true)
    stubData({ patient: null })
    const w = await mountHome()
    await flushPromises()

    expect(mocks.hasNoCloudPatient).toHaveBeenCalled()
    expect(w.text()).toContain('还没有病人档案，去「设置」新建或上传本地数据')
  })

  it('云端已登录但已有病人：不显示空状态', async () => {
    mocks.isLoggedIn.value = true
    mocks.hasNoCloudPatient.mockResolvedValue(false)
    stubData({ patient: makePatient() })
    const w = await mountHome()
    await flushPromises()

    expect(w.find('.patient-card').exists()).toBe(true)
    expect(w.findAll('.van-empty')).toHaveLength(1) // 只剩「暂无透析记录」那个
    expect(w.text()).toContain('暂无透析记录')
  })
})

describe('HomeView · 记录列表', () => {
  const dry = [makeDryWeight({ id: 'd1', value: 60, effectiveDate: '2024-01-01' })]

  it('按 YYYY-MM 分组，两个月份各有一个标题', async () => {
    stubData({
      patient: makePatient(),
      dryWeights: dry,
      sessions: [
        makeSession({ id: 's1', date: '2024-01-10' }),
        makeSession({ id: 's2', date: '2024-01-20' }),
        makeSession({ id: 's3', date: '2024-02-05' }),
      ],
    })
    const w = await mountHome()
    await flushPromises()

    const months = w.findAll('.card-title').map((n) => n.text())
    expect(months).toEqual(['2024-01', '2024-02'])
  })

  it('每条记录显示中文日期、状态标签、上机前实际体重与计划脱水', async () => {
    stubData({
      patient: makePatient(),
      dryWeights: dry,
      sessions: [
        makeSession({
          id: 's1',
          date: '2024-01-10',
          preWeightMeasured: 80,
          wheelchairWeightUsed: 20,
          status: 'completed',
        }),
      ],
    })
    const w = await mountHome()
    await flushPromises()

    const text = w.text()
    expect(text).toContain('1月10日 周三') // 2024-01-10 是周三
    expect(text).toContain('已完成')
    expect(text).toContain('上机前实际')
    expect(text).toContain('60.0') // 80 - 20
    expect(text).toContain('计划脱水')
    expect(text).toContain('0.0') // 60 - 60
  })

  it('三种状态分别显示「进行中 / 已完成 / 已中止」', async () => {
    stubData({
      patient: makePatient(),
      dryWeights: dry,
      sessions: [
        makeSession({ id: 's1', date: '2024-01-10', status: 'ongoing' }),
        makeSession({ id: 's2', date: '2024-01-11', status: 'completed' }),
        makeSession({ id: 's3', date: '2024-01-12', status: 'aborted' }),
      ],
    })
    const w = await mountHome()
    await flushPromises()

    const tags = w.findAll('.van-tag').map((n) => n.text())
    expect(tags).toEqual(['进行中', '已完成', '已中止'])
  })

  it('中止记录显示「中止：…」（标签 + 描述的组合结果）', async () => {
    stubData({
      patient: makePatient(),
      dryWeights: dry,
      sessions: [
        makeSession({
          id: 's1',
          date: '2024-01-10',
          status: 'aborted',
          abortTags: ['hypotension', 'other'],
          abortReason: '血压持续偏低',
        }),
        makeSession({ id: 's2', date: '2024-01-11', status: 'aborted', abortTags: [], abortReason: null }),
        makeSession({ id: 's3', date: '2024-01-12', status: 'aborted', abortTags: ['other'], abortReason: null }),
      ],
    })
    const w = await mountHome()
    await flushPromises()

    const lines = w.findAll('.abort-line').map((n) => n.text())
    expect(lines).toEqual(['中止：低血压、血压持续偏低', '中止：未填写原因', '中止：其他'])
  })

  it('有记录人时显示 operator', async () => {
    stubData({
      patient: makePatient(),
      dryWeights: dry,
      sessions: [makeSession({ id: 's1', date: '2024-01-10', operator: '李护士' })],
    })
    const w = await mountHome()
    await flushPromises()

    expect(w.text()).toContain('· 李护士')
  })

  it('没有任何记录时显示空状态文案', async () => {
    stubData({ patient: makePatient(), sessions: [] })
    const w = await mountHome()
    await flushPromises()

    expect(w.text()).toContain('暂无透析记录，点击上方快速创建')
  })

  it('点击某条记录跳转到该记录的详情页', async () => {
    stubData({
      patient: makePatient(),
      dryWeights: dry,
      sessions: [makeSession({ id: 's1', date: '2024-01-10', status: 'completed' })],
    })
    const w = await mountHome()
    await flushPromises()

    // 记录行是列表里唯一带 cursor:pointer 内联样式的 div
    const row = w
      .findAll('div')
      .find((d) => (d.attributes('style') ?? '').includes('cursor: pointer'))
    expect(row).toBeTruthy()
    await row!.trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/session/s1')
  })
})

describe('HomeView · 加载失败可以重试（H5）', () => {
  it('加载失败：骨架收起，显示错误态与「重试」按钮（不再永远停在骨架）', async () => {
    // 一次性 reject：stubData 里的 mockResolvedValue 是默认实现，不会盖掉 once
    vi.mocked(repository.listSessions).mockRejectedValueOnce(new Error('offline'))
    stubData({ patient: makePatient() })
    const w = await mountHome()
    await flushPromises()

    expect(w.findComponent({ name: 'VanSkeleton' }).exists()).toBe(false)
    expect(w.find('.load-error-text').text()).toContain('加载失败')
    expect(buttonByText(w, '重试').exists()).toBe(true)
    // 不能把「加载失败」伪装成「还没有档案」，否则用户会去重复建档
    expect(w.text()).not.toContain('请先建立病人档案')
    expect(w.find('.quick-btn').exists()).toBe(false)
  })

  it('重试成功后渲染档案卡与列表，错误态消失', async () => {
    vi.mocked(repository.listSessions).mockRejectedValueOnce(new Error('offline'))
    stubData({ patient: makePatient(), sessions: [makeSession({ id: 's1', date: '2024-01-10' })] })
    const w = await mountHome()
    await flushPromises()

    await buttonByText(w, '重试').trigger('click')
    await flushPromises()

    expect(w.find('.load-error').exists()).toBe(false)
    expect(w.find('.patient-card').exists()).toBe(true)
    expect(w.find('.quick-btn').exists()).toBe(true)
    expect(w.text()).toContain('1月10日 周三')
  })

  it('已有数据时后台静默刷新失败：继续显示旧数据，不打断用户', async () => {
    stubData({ patient: makePatient() })
    const w = await mountHome()
    await flushPromises()
    expect(w.find('.patient-card').exists()).toBe(true)

    vi.mocked(repository.getPatient).mockRejectedValue(new Error('offline'))
    cacheVersion.value += 1
    await flushPromises()

    expect(w.find('.patient-card').exists()).toBe(true)
    expect(w.find('.load-error').exists()).toBe(false)
  })
})

describe('HomeView · 立即创建防连点（H3）', () => {
  it('连点两次只创建一条记录，创建中按钮禁用并显示「创建中…」', async () => {
    let release!: () => void
    vi.mocked(repository.saveSession).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve()
        }),
    )
    stubData({ patient: makePatient() })
    const w = await mountHome()
    await flushPromises()

    await w.find('input.quick-input').setValue('80.5')
    const btn = w.find('.quick-btn')
    await btn.trigger('click')
    await flushPromises()

    expect(repository.saveSession).toHaveBeenCalledTimes(1)
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.text()).toBe('创建中…')

    await btn.trigger('click')
    await flushPromises()
    expect(repository.saveSession).toHaveBeenCalledTimes(1)

    release()
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/session/uuid-fixed-1')
  })

  it('创建失败：提示用户（不再「点了没反应」），按钮恢复可点', async () => {
    vi.mocked(repository.saveSession).mockRejectedValueOnce(new Error('offline'))
    stubData({ patient: makePatient() })
    const w = await mountHome()
    await flushPromises()

    await w.find('input.quick-input').setValue('80.5')
    await w.find('.quick-btn').trigger('click')
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('创建失败，请检查网络后重试')
    expect(router.currentRoute.value.path).toBe('/')
    expect(w.find('.quick-btn').attributes('disabled')).toBeUndefined()
    expect(w.find('.quick-btn').text()).toBe('立即创建')
  })
})

describe('HomeView · 只读角色看不到写入口（H4）', () => {
  it('挂载时会拉取当前角色（本地模式由 store 自己跳过）', async () => {
    stubData({ patient: makePatient() })
    await mountHome()
    await flushPromises()

    expect(mocks.refreshCurrentRole).toHaveBeenCalled()
  })

  it('只读角色：隐藏「＋新建」与快速创建，并给出提示', async () => {
    setReadOnly(true)
    stubData({ patient: makePatient() })
    const w = await mountHome()
    await flushPromises()

    expect(w.find('.readonly-banner').text()).toContain('只读成员')
    expect(w.find('.quick-card').exists()).toBe(false)
    expect(w.findAll('button').some((b) => b.text().includes('新建'))).toBe(false)
    // 仍能看记录列表
    expect(w.find('.patient-card').exists()).toBe(true)
  })

  it('只读角色且没有记录：空状态文案不再引导「点击上方快速创建」', async () => {
    setReadOnly(true)
    stubData({ patient: makePatient(), sessions: [] })
    const w = await mountHome()
    await flushPromises()

    expect(w.text()).toContain('暂无透析记录')
    expect(w.text()).not.toContain('点击上方快速创建')
  })
})

describe('HomeView · 体重量程（M6）', () => {
  it.each(['0', '5', '300'])('体重 %s 超范围：不写库、不跳转，只提示', async (weight) => {
    stubData({ patient: makePatient() })
    const w = await mountHome()
    await flushPromises()

    await w.find('input.quick-input').setValue(weight)
    await w.find('.quick-btn').trigger('click')
    await flushPromises()

    expect(repository.saveSession).not.toHaveBeenCalled()
    expect(mocks.showToast).toHaveBeenCalledWith('体重需在 20~200kg 之间，请检查输入')
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('边界值 200 属于合法范围，照常创建', async () => {
    stubData({ patient: makePatient() })
    const w = await mountHome()
    await flushPromises()

    await w.find('input.quick-input').setValue('200')
    await w.find('.quick-btn').trigger('click')
    await flushPromises()

    expect(repository.saveSession).toHaveBeenCalledTimes(1)
    expect(vi.mocked(repository.saveSession).mock.calls[0][0].preWeightMeasured).toBe(200)
  })
})

describe('HomeView · 缺日期的脏数据不白屏（L1）', () => {
  it('date 缺失/为空时归到「日期未知」分组，排在最后且照常渲染', async () => {
    stubData({
      patient: makePatient(),
      sessions: [
        makeSession({ id: 's1', date: '2024-01-10' }),
        makeSession({ id: 's2', date: '' }),
        makeSession({ id: 's3', date: undefined as unknown as string }),
      ],
    })
    const w = await mountHome()
    await flushPromises()

    expect(w.findAll('.card-title').map((n) => n.text())).toEqual(['2024-01', '日期未知'])
    // 三条都在，没有整页崩掉
    const rows = w.findAll('div').filter((d) => (d.attributes('style') ?? '').includes('cursor: pointer'))
    expect(rows).toHaveLength(3)
  })
})

describe('HomeView · 缓存刷新后自动重读', () => {
  it('cacheVersion 自增会再读一次病人（云端后台刷新写回缓存后的行为）', async () => {
    stubData({ patient: makePatient() })
    await mountHome()
    await flushPromises()
    expect(repository.getPatient).toHaveBeenCalledTimes(1)

    vi.mocked(repository.getPatient).mockClear()
    vi.mocked(repository.listSessions).mockClear()
    cacheVersion.value += 1
    await flushPromises()

    expect(repository.getPatient).toHaveBeenCalledTimes(1)
    expect(repository.getPatient).toHaveBeenCalledWith('patient-default')
    expect(repository.listSessions).toHaveBeenCalledTimes(1)
  })
})

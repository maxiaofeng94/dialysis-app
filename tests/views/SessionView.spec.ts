/**
 * SessionView（透析记录详情页）组件测试
 *
 * 覆盖：加载与兜底、状态与按钮、体重/脱水计算展示、血压/血糖/血流量列表与增删、
 * 不良反应替换入参、完成/中止流程、离开页面前的落库、删除整条记录。
 *
 * jsdom 限制说明（诚实交代）：
 * 1. Vant 的 popup/action-sheet 默认 teleport 到 body，`stubs: { teleport: true }` 把它们渲染回
 *    组件树内，才能对弹窗里的按钮/输入框做断言；
 * 2. 页面里的表单改动会触发 400ms 防抖保存（setTimeout），本文件不 fake 定时器，
 *    而是靠「每个用例结束 unmount（onBeforeUnmount 会 clearTimeout）」避免定时器跨用例串味；
 * 3. 序号排序（按 measuredAt 升序）由仓储层负责（localRepository 里 sort），
 *    本文件按仓储契约喂入已排序数据，断言组件按顺序渲染。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper, type DOMWrapper } from '@vue/test-utils'
import { createRouter, createMemoryHistory, RouterView, type Router } from 'vue-router'
import { defineComponent, h, type Ref } from 'vue'
import Vant from 'vant'
import SessionView from '../../src/views/SessionView.vue'
import { repository } from '../../src/repo'
import { cacheVersion } from '../../src/lib/cloudCache'
import { isLoggedIn } from '../../src/stores/auth' // 已被上面的 vi.mock 替换为受控 ref
import { dateStr } from '../../src/utils/format'
import {
  makePatient,
  makeDryWeight,
  makeSession,
  makeBp,
  makeBg,
  makeBf,
  makeReaction,
  resetIdSeq,
} from '../helpers/factories'

const mocks = vi.hoisted(() => ({
  currentPatientId: { value: 'patient-default' },
  uuid: vi.fn(() => 'uuid-fixed-1'),
  showToast: vi.fn(),
  showConfirmDialog: vi.fn(async () => undefined),
  refreshCurrentRole: vi.fn(async () => undefined),
  /** 由下面的 vi.mock 工厂填入真实 ref（模板里要自动解包，必须是 ref 而不是普通对象） */
  patientStore: { isReadOnly: null as unknown as Ref<boolean> },
}))

vi.mock('../../src/repo', () => ({
  repository: {
    getSession: vi.fn(),
    getPatient: vi.fn(),
    listDryWeights: vi.fn(),
    saveSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    listBloodPressures: vi.fn(),
    saveBloodPressure: vi.fn(async () => undefined),
    deleteBloodPressure: vi.fn(async () => undefined),
    listBloodGlucoses: vi.fn(),
    saveBloodGlucose: vi.fn(async () => undefined),
    deleteBloodGlucose: vi.fn(async () => undefined),
    listBloodFlows: vi.fn(),
    saveBloodFlow: vi.fn(async () => undefined),
    deleteBloodFlow: vi.fn(async () => undefined),
    listAdverseReactions: vi.fn(),
    replaceAdverseReactions: vi.fn(async () => undefined),
  },
}))

vi.mock('../../src/stores/patient', async () => {
  const { ref } = await import('vue')
  // 真实实现里 isReadOnly 是 computed(() => currentRole === 'doctor' || 'viewer')，
  // 这里直接给一个可写的 ref，视图测试只关心「只读时界面长什么样」
  const isReadOnly = ref(false)
  mocks.patientStore.isReadOnly = isReadOnly
  return {
    currentPatientId: mocks.currentPatientId,
    currentRole: ref<string | null>(null),
    isReadOnly,
    refreshCurrentRole: mocks.refreshCurrentRole,
  }
})
// 模板里直接写 `v-if="!isLoggedIn"`，必须是真 ref 才能被模板自动解包，故在工厂里造 ref
vi.mock('../../src/stores/auth', async () => {
  const { ref } = await import('vue')
  return { isLoggedIn: ref(false) }
})
vi.mock('../../src/utils/id', () => ({ uuid: mocks.uuid }))

vi.mock('vant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vant')>()
  return { ...actual, showToast: mocks.showToast, showConfirmDialog: mocks.showConfirmDialog }
})

const Blank = defineComponent({ render: () => h('div') })
/** 用 RouterView 承载页面：组件里的 onBeforeRouteLeave 只有在真正的路由记录下才注册得上 */
const Harness = defineComponent({ render: () => h(RouterView) })

let wrapper: VueWrapper | null = null
let router: Router

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Blank },
      { path: '/session/:id', component: SessionView },
      { path: '/report/:id', component: Blank },
    ],
  })
}

interface SessionData {
  session?: ReturnType<typeof makeSession> | null
  patient?: ReturnType<typeof makePatient> | null
  dryWeights?: ReturnType<typeof makeDryWeight>[]
  bps?: ReturnType<typeof makeBp>[]
  glucoses?: ReturnType<typeof makeBg>[]
  flows?: ReturnType<typeof makeBf>[]
  reactions?: ReturnType<typeof makeReaction>[]
}

function stubSessionData(data: SessionData = {}) {
  vi.mocked(repository.getSession).mockResolvedValue(
    data.session === undefined ? makeSession({ id: 'session-1' }) : (data.session ?? undefined),
  )
  vi.mocked(repository.getPatient).mockResolvedValue(
    data.patient === undefined ? makePatient() : (data.patient ?? undefined),
  )
  vi.mocked(repository.listDryWeights).mockResolvedValue(data.dryWeights ?? [])
  vi.mocked(repository.listBloodPressures).mockResolvedValue(data.bps ?? [])
  vi.mocked(repository.listBloodGlucoses).mockResolvedValue(data.glucoses ?? [])
  vi.mocked(repository.listBloodFlows).mockResolvedValue(data.flows ?? [])
  vi.mocked(repository.listAdverseReactions).mockResolvedValue(data.reactions ?? [])
}

/** 默认数据：2024-01-10，上机 80（实际 60.0）、下机 77（实际 57.0）、当日干体重 60 */
function defaultData(patch: Partial<SessionData> = {}): SessionData {
  return {
    session: makeSession({
      id: 'session-1',
      date: '2024-01-10',
      preWeightMeasured: 80,
      postWeightMeasured: 77,
      wheelchairWeightUsed: 20,
      rinseBackVolumeUsed: 300,
      status: 'ongoing',
    }),
    patient: makePatient(),
    dryWeights: [makeDryWeight({ id: 'd1', value: 60, effectiveDate: '2024-01-01' })],
    ...patch,
  }
}

async function mountSession(data: SessionData = defaultData()): Promise<VueWrapper> {
  stubSessionData(data)
  router = makeRouter()
  await router.push('/session/session-1')
  await router.isReady()
  wrapper = mount(Harness, {
    global: { plugins: [Vant, router], stubs: { teleport: true } },
  })
  await flushPromises()
  return wrapper
}

/** 在某个容器（整页或某个弹窗）里按 label 找 van-field 的输入控件 */
function fieldInput(
  scope: VueWrapper | DOMWrapper<Node>,
  label: string,
  tag: 'input' | 'textarea' = 'input',
): DOMWrapper<HTMLInputElement> {
  const field = scope.findAll('.van-field').find((f) => f.text().includes(label))
  if (!field) throw new Error(`未找到 label 为「${label}」的 van-field`)
  const el = field.find(tag)
  if (!el.exists()) throw new Error(`「${label}」里没有 ${tag}`)
  return el as DOMWrapper<HTMLInputElement>
}

/** 按标题定位卡片（血压/血糖/血流量卡片的按钮文案都叫「＋ 记录」，必须限定范围） */
function cardByTitle(w: VueWrapper, title: string): DOMWrapper<Node> {
  const card = w
    .findAll('.card')
    .find((c) => c.find('.card-title').exists() && c.find('.card-title').text().startsWith(title))
  if (!card) throw new Error(`未找到标题为「${title}」的卡片`)
  return card as DOMWrapper<Node>
}

/** 取卡片里的「一条记录」行：这些行才有 border-top 内联样式（外层 row 只是布局容器） */
function recordRows(scope: VueWrapper | DOMWrapper<Node>): DOMWrapper<Node>[] {
  return scope.findAll('div').filter((d) => (d.attributes('style') ?? '').includes('border-top'))
}

function buttonByText(scope: VueWrapper | DOMWrapper<Node>, text: string): DOMWrapper<HTMLButtonElement> {
  const btn = scope.findAll('button').find((b) => b.text().includes(text))
  if (!btn) throw new Error(`未找到文案包含「${text}」的按钮`)
  return btn as DOMWrapper<HTMLButtonElement>
}

/** 打开弹窗后取到对应弹窗容器（teleport 已被 stub 回组件树内） */
function popupByText(w: VueWrapper, text: string): DOMWrapper<Node> {
  const popup = w.findAll('.van-popup').find((p) => p.text().includes(text))
  if (!popup) throw new Error(`未找到包含「${text}」的弹窗`)
  return popup as DOMWrapper<Node>
}

/** 三个体重/脱水量输入框（上机前 / 下机后 / 医生设定脱水量） */
function weightInputs(w: VueWrapper): DOMWrapper<HTMLInputElement>[] {
  return w.findAll('input.weight-input') as unknown as DOMWrapper<HTMLInputElement>[]
}

/** 切换当前账号是否只读（doctor / viewer → true） */
function setReadOnly(readOnly: boolean): void {
  mocks.patientStore.isReadOnly.value = readOnly
}

beforeEach(() => {
  resetIdSeq()
  for (const fn of Object.values(repository) as unknown as ReturnType<typeof vi.fn>[]) {
    fn.mockReset()
  }
  vi.mocked(repository.saveSession).mockResolvedValue(undefined)
  vi.mocked(repository.deleteSession).mockResolvedValue(undefined)
  vi.mocked(repository.saveBloodPressure).mockResolvedValue(undefined)
  vi.mocked(repository.deleteBloodPressure).mockResolvedValue(undefined)
  vi.mocked(repository.saveBloodGlucose).mockResolvedValue(undefined)
  vi.mocked(repository.deleteBloodGlucose).mockResolvedValue(undefined)
  vi.mocked(repository.saveBloodFlow).mockResolvedValue(undefined)
  vi.mocked(repository.deleteBloodFlow).mockResolvedValue(undefined)
  vi.mocked(repository.replaceAdverseReactions).mockResolvedValue(undefined)
  ;(isLoggedIn as unknown as { value: boolean }).value = false
  // 视图测试默认是「可写角色」，只读场景由用例自己打开开关
  setReadOnly(false)
  mocks.refreshCurrentRole.mockClear()
  mocks.uuid.mockReset().mockReturnValue('uuid-fixed-1')
  mocks.showToast.mockReset()
  mocks.showConfirmDialog.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  // 必须卸载：否则 400ms 防抖保存的定时器会在后续用例里冒出来
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
})

describe('SessionView · 加载与兜底', () => {
  it('加载中显示骨架，数据到位后消失', async () => {
    stubSessionData(defaultData())
    router = makeRouter()
    await router.push('/session/session-1')
    await router.isReady()
    const w = mount(Harness, { global: { plugins: [Vant, router], stubs: { teleport: true } } })
    wrapper = w

    expect(w.findComponent({ name: 'VanSkeleton' }).exists()).toBe(true)
    await flushPromises()
    expect(w.findComponent({ name: 'VanSkeleton' }).exists()).toBe(false)
  })

  it('记录不存在时跳回首页，不渲染任何记录内容', async () => {
    const w = await mountSession(defaultData({ session: null }))

    expect(router.currentRoute.value.path).toBe('/')
    expect(w.find('.status-badge').exists()).toBe(false)
    expect(w.find('.weight-input').exists()).toBe(false)
  })

  it('并发请求会话/病人/干体重与四张子表', async () => {
    await mountSession()

    expect(repository.getSession).toHaveBeenCalledWith('session-1')
    expect(repository.getPatient).toHaveBeenCalledWith('patient-default')
    expect(repository.listDryWeights).toHaveBeenCalledWith('patient-default')
    expect(repository.listBloodPressures).toHaveBeenCalledWith('session-1')
    expect(repository.listBloodGlucoses).toHaveBeenCalledWith('session-1')
    expect(repository.listBloodFlows).toHaveBeenCalledWith('session-1')
    expect(repository.listAdverseReactions).toHaveBeenCalledWith('session-1')
  })
})

describe('SessionView · 状态展示与按钮', () => {
  it('进行中：徽标「进行中」+ 标记完成 / 中止透析', async () => {
    const w = await mountSession()

    const badge = w.find('.status-badge')
    expect(badge.text()).toBe('进行中')
    expect(badge.classes()).toContain('ongoing')
    expect(w.findAll('.status-actions button').map((b) => b.text())).toEqual(['标记完成', '中止透析'])
  })

  it('已完成：徽标「已完成」+ 改为进行中 / 标记中止', async () => {
    const w = await mountSession(defaultData({ session: makeSession({ id: 'session-1', status: 'completed' }) }))

    const badge = w.find('.status-badge')
    expect(badge.text()).toBe('已完成')
    expect(badge.classes()).toContain('completed')
    expect(w.findAll('.status-actions button').map((b) => b.text())).toEqual(['改为进行中', '标记中止'])
  })

  it('已中止：显示中止信息区（时间 + 原因组合文案）', async () => {
    const abortedAt = new Date('2024-01-10T09:30:00').getTime()
    const w = await mountSession(
      defaultData({
        session: makeSession({
          id: 'session-1',
          status: 'aborted',
          abortedAt,
          abortTags: ['hypotension'],
          abortReason: '血压持续偏低',
        }),
      }),
    )

    const box = w.find('.abort-box')
    expect(box.exists()).toBe(true)
    expect(box.text()).toContain('本次透析已中止')
    expect(box.text()).toContain('2024-01-10 09:30')
    // abortText(['hypotension'], '血压持续偏低') = 低血压、血压持续偏低
    expect(box.find('.abort-v').text()).toBe('低血压、血压持续偏低')
    // 有中止信息时按钮文案是「修改中止信息」
    expect(box.text()).toContain('修改中止信息')
    expect(w.findAll('.status-actions button').map((b) => b.text())).toEqual(['改为进行中'])
  })

  it('已中止但没填任何原因：显示「未填写」与「补充中止原因」', async () => {
    const w = await mountSession(
      defaultData({
        session: makeSession({ id: 'session-1', status: 'aborted', abortedAt: null, abortTags: [], abortReason: null }),
      }),
    )

    const box = w.find('.abort-box')
    expect(box.find('.abort-v').text()).toBe('未填写')
    expect(box.text()).toContain('未记录') // 未记录中止时间
    expect(box.text()).toContain('补充中止原因')
  })
})

describe('SessionView · 体重与脱水计算展示', () => {
  it('上机 80 / 下机 77 / 轮椅 20 / 干体重 60：各推导值与 calcWeights 一致', async () => {
    const w = await mountSession()

    const flowVals = w.findAll('.flow-val').map((n) => n.text())
    expect(flowVals[0]).toBe('60.0kg') // 80 - 20
    expect(flowVals[1]).toBe('57.0kg') // 77 - 20
    expect(w.find('.flow-diff').text()).toBe('脱 3.0L') // 60.0 - 57.0

    const ufVals = w.findAll('.uf-val').map((n) => n.text())
    expect(ufVals[0]).toBe('0.0L') // 计划：60.0 - 60
    expect(ufVals[1]).toBe('3.0L') // 实际

    // 当日干体重 60.0kg · 回水 300ml · 机器超滤 0.3L（计划 0 + 回水 0.3）
    expect(w.find('.uf-meta').text()).toBe('当日干体重 60.0kg · 回水 300ml · 机器超滤 0.3L')
  })

  it('没有下机后体重时，实际脱水与下机后实际都是占位符', async () => {
    const w = await mountSession(
      defaultData({ session: makeSession({ id: 'session-1', preWeightMeasured: 80, postWeightMeasured: null }) }),
    )

    expect(w.findAll('.flow-val')[1].text()).toBe('—kg')
    expect(w.findAll('.uf-val')[1].text()).toBe('—L')
    expect(w.find('.flow-diff').exists()).toBe(false)
  })

  it('没有干体重时计划脱水为占位符，但实际脱水仍可算', async () => {
    const w = await mountSession(defaultData({ dryWeights: [] }))

    expect(w.findAll('.uf-val')[0].text()).toBe('—L')
    expect(w.findAll('.uf-val')[1].text()).toBe('3.0L')
  })

  it('中止且未记录下机后体重时给出补录提示', async () => {
    const w = await mountSession(
      defaultData({
        session: makeSession({
          id: 'session-1',
          status: 'aborted',
          preWeightMeasured: 80,
          postWeightMeasured: null,
        }),
      }),
    )

    expect(w.find('.abort-hint').text()).toContain('补录称重后会自动算出实际脱水量')
  })

  it('记录人输入框在本地单机模式下显示，并回填已有的 operator', async () => {
    const w = await mountSession(defaultData({ session: makeSession({ id: 'session-1', operator: '李护士' }) }))

    expect(fieldInput(w, '记录人').element.value).toBe('李护士')
  })

  it('云端登录后隐藏记录人输入框（记录人取自账号）', async () => {
    ;(isLoggedIn as unknown as { value: boolean }).value = true
    const w = await mountSession(defaultData({ session: makeSession({ id: 'session-1', operator: '李护士' }) }))

    expect(w.findAll('.van-field').some((f) => f.text().includes('记录人'))).toBe(false)
  })
})

describe('SessionView · 血压列表与增删', () => {
  const twoBps = [
    makeBp({ id: 'bp1', measuredAt: new Date('2024-01-10T08:00:00').getTime(), systolic: 130, diastolic: 80 }),
    makeBp({ id: 'bp2', measuredAt: new Date('2024-01-10T09:00:00').getTime(), systolic: 150, diastolic: 95 }),
  ]

  it('按仓储返回顺序（measuredAt 升序）渲染，并显示评估标签与颜色', async () => {
    const w = await mountSession(defaultData({ bps: twoBps }))

    const card = cardByTitle(w, '血压')
    expect(card.find('.card-title').text()).toBe('血压 (2)')

    const rows = recordRows(card)
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('08:00')
    expect(rows[0].text()).toContain('130 / 80')
    expect(rows[1].text()).toContain('09:00')
    expect(rows[1].text()).toContain('150 / 95')

    const tags = card.findAll('.van-tag')
    expect(tags.map((t) => t.text())).toEqual(['正常', '偏高'])
    expect(tags[0].classes()).toContain('van-tag--success')
    expect(tags[1].classes()).toContain('van-tag--danger')
  })

  it('没有血压记录时显示空提示', async () => {
    const w = await mountSession()
    expect(cardByTitle(w, '血压').text()).toContain('暂无血压记录')
  })

  it('新增血压：写入 saveBloodPressure，sessionId 与测量日期正确', async () => {
    const w = await mountSession()

    await buttonByText(cardByTitle(w, '血压'), '记录').trigger('click')
    await flushPromises()

    const popup = popupByText(w, '记录血压')
    await fieldInput(popup, '高压').setValue('135')
    await fieldInput(popup, '低压').setValue('85')
    await buttonByText(popup, '保存').trigger('click')
    await flushPromises()

    expect(repository.saveBloodPressure).toHaveBeenCalledTimes(1)
    const bp = vi.mocked(repository.saveBloodPressure).mock.calls[0][0]
    expect(bp).toMatchObject({
      id: 'uuid-fixed-1',
      sessionId: 'session-1',
      systolic: 135,
      diastolic: 85,
      note: null,
    })
    // measuredAt 由「透析日期 + 弹窗时间」组合而来，落在本次透析当天
    expect(dateStr(bp.measuredAt)).toBe('2024-01-10')
    expect(mocks.showToast).toHaveBeenCalledWith('已保存：血压 135/85 正常')
    // 保存后重新拉了一次列表
    expect(repository.listBloodPressures).toHaveBeenCalledTimes(2)
  })

  it('新增血压：高压/低压为空时不写库并提示', async () => {
    const w = await mountSession()

    await buttonByText(cardByTitle(w, '血压'), '记录').trigger('click')
    await flushPromises()
    const popup = popupByText(w, '记录血压')
    await buttonByText(popup, '保存').trigger('click')
    await flushPromises()

    expect(repository.saveBloodPressure).not.toHaveBeenCalled()
    expect(mocks.showToast).toHaveBeenCalledWith('请填写高压和低压')
  })

  it('新增血压：小数会四舍五入成整数（当前实现不校验低压必须小于高压）', async () => {
    const w = await mountSession()

    await buttonByText(cardByTitle(w, '血压'), '记录').trigger('click')
    await flushPromises()
    const popup = popupByText(w, '记录血压')
    await fieldInput(popup, '高压').setValue('135.6')
    await fieldInput(popup, '低压').setValue('85.4')
    await buttonByText(popup, '保存').trigger('click')
    await flushPromises()

    const bp = vi.mocked(repository.saveBloodPressure).mock.calls[0][0]
    expect(bp.systolic).toBe(136)
    expect(bp.diastolic).toBe(85)
  })

  it('点编辑图标会用该条数据回填弹窗，并在保存时沿用同一条 id', async () => {
    const w = await mountSession(defaultData({ bps: [twoBps[0]] }))

    await cardByTitle(w, '血压').find('.van-icon-edit').trigger('click')
    await flushPromises()

    const popup = popupByText(w, '编辑血压')
    expect(fieldInput(popup, '高压').element.value).toBe('130')
    expect(fieldInput(popup, '低压').element.value).toBe('80')

    await fieldInput(popup, '高压').setValue('128')
    await buttonByText(popup, '保存').trigger('click')
    await flushPromises()

    const bp = vi.mocked(repository.saveBloodPressure).mock.calls[0][0]
    expect(bp.id).toBe('bp1')
    expect(bp.systolic).toBe(128)
  })

  it('删除血压：确认后调用 deleteBloodPressure 并刷新列表', async () => {
    const w = await mountSession(defaultData({ bps: [twoBps[0]] }))

    await cardByTitle(w, '血压').find('.van-icon-delete-o').trigger('click')
    await flushPromises()

    expect(mocks.showConfirmDialog).toHaveBeenCalledTimes(1)
    expect(repository.deleteBloodPressure).toHaveBeenCalledWith('bp1')
    expect(repository.listBloodPressures).toHaveBeenCalledTimes(2)
  })

  it('删除血压：用户取消（showConfirmDialog reject）时不删库', async () => {
    const w = await mountSession(defaultData({ bps: [twoBps[0]] }))
    mocks.showConfirmDialog.mockRejectedValueOnce(new Error('cancel'))

    await cardByTitle(w, '血压').find('.van-icon-delete-o').trigger('click')
    await flushPromises()

    expect(repository.deleteBloodPressure).not.toHaveBeenCalled()
  })
})

describe('SessionView · 血糖与血流量', () => {
  it('血糖按顺序渲染并显示评估标签', async () => {
    const w = await mountSession(
      defaultData({
        glucoses: [
          makeBg({ id: 'bg1', measuredAt: new Date('2024-01-10T08:00:00').getTime(), value: 6.5 }),
          makeBg({ id: 'bg2', measuredAt: new Date('2024-01-10T09:00:00').getTime(), value: 3 }),
        ],
      }),
    )

    const card = cardByTitle(w, '血糖')
    expect(card.find('.card-title').text()).toBe('血糖 (2)')
    expect(card.findAll('.van-tag').map((t) => t.text())).toEqual(['正常', '偏低'])
    expect(card.findAll('.van-tag')[1].classes()).toContain('van-tag--warning')
  })

  it('没有血糖记录时给出提示', async () => {
    const w = await mountSession()
    expect(cardByTitle(w, '血糖').text()).toContain('暂无血糖记录（每次透析 1 次）')
  })

  it('新增血糖：写入 saveBloodGlucose', async () => {
    const w = await mountSession()

    await buttonByText(cardByTitle(w, '血糖'), '记录').trigger('click')
    await flushPromises()
    const popup = popupByText(w, '记录血糖')
    await fieldInput(popup, '血糖值').setValue('7.2')
    await buttonByText(popup, '保存').trigger('click')
    await flushPromises()

    expect(repository.saveBloodGlucose).toHaveBeenCalledTimes(1)
    expect(vi.mocked(repository.saveBloodGlucose).mock.calls[0][0]).toMatchObject({
      id: 'uuid-fixed-1',
      sessionId: 'session-1',
      value: 7.2,
      note: null,
    })
    expect(mocks.showToast).toHaveBeenCalledWith('已保存：血糖 7.2 mmol/L 正常')
  })

  it('新增血糖：空值不写库并提示', async () => {
    const w = await mountSession()

    await buttonByText(cardByTitle(w, '血糖'), '记录').trigger('click')
    await flushPromises()
    await buttonByText(popupByText(w, '记录血糖'), '保存').trigger('click')
    await flushPromises()

    expect(repository.saveBloodGlucose).not.toHaveBeenCalled()
    expect(mocks.showToast).toHaveBeenCalledWith('请填写血糖值')
  })

  it('删除血糖：确认后调用 deleteBloodGlucose', async () => {
    const w = await mountSession(defaultData({ glucoses: [makeBg({ id: 'bg1' })] }))

    await cardByTitle(w, '血糖').find('.van-icon-delete-o').trigger('click')
    await flushPromises()

    expect(repository.deleteBloodGlucose).toHaveBeenCalledWith('bg1')
  })

  it('血流量：渲染数值与单位，新增时取整后写入', async () => {
    const w = await mountSession(defaultData({ flows: [makeBf({ id: 'bf1', value: 250 })] }))

    const card = cardByTitle(w, '血流量')
    expect(card.text()).toContain('250')
    expect(card.text()).toContain('ml/min')

    await buttonByText(card, '记录').trigger('click')
    await flushPromises()
    const popup = popupByText(w, '记录血流量')
    await fieldInput(popup, '血流量').setValue('255.6')
    await buttonByText(popup, '保存').trigger('click')
    await flushPromises()

    expect(vi.mocked(repository.saveBloodFlow).mock.calls[0][0]).toMatchObject({
      id: 'uuid-fixed-1',
      sessionId: 'session-1',
      value: 256,
    })
  })

  it('血流量：空值不写库并提示；删除时调用 deleteBloodFlow', async () => {
    const w = await mountSession(defaultData({ flows: [makeBf({ id: 'bf1' })] }))

    await buttonByText(cardByTitle(w, '血流量'), '记录').trigger('click')
    await flushPromises()
    await buttonByText(popupByText(w, '记录血流量'), '保存').trigger('click')
    await flushPromises()
    expect(repository.saveBloodFlow).not.toHaveBeenCalled()
    expect(mocks.showToast).toHaveBeenCalledWith('请填写血流量')

    await cardByTitle(w, '血流量').find('.van-icon-delete-o').trigger('click')
    await flushPromises()
    expect(repository.deleteBloodFlow).toHaveBeenCalledWith('bf1')
  })
})

describe('SessionView · 不良反应', () => {
  it('已有记录会回填为选中状态（含「其他」的描述）', async () => {
    const w = await mountSession(
      defaultData({
        reactions: [makeReaction({ id: 'ar1', type: 'cramp' }), makeReaction({ id: 'ar2', type: 'other', detail: '发热' })],
      }),
    )

    expect(w.findAll('.chip.active').map((c) => c.text())).toEqual(['抽筋', '其他'])
    const otherField = w.findAll('.van-field').find((f) => f.text().includes('其他'))
    expect(otherField!.find('input').element.value).toBe('发热')
  })

  it('勾选标签即整表替换，入参包含 type/detail/severity', async () => {
    const w = await mountSession()

    await w.findAll('.chip').find((c) => c.text() === '抽筋')!.trigger('click')
    await flushPromises()

    expect(repository.replaceAdverseReactions).toHaveBeenCalledTimes(1)
    const [sessionId, list] = vi.mocked(repository.replaceAdverseReactions).mock.calls[0]
    expect(sessionId).toBe('session-1')
    expect(list).toEqual([
      expect.objectContaining({
        id: 'uuid-fixed-1',
        sessionId: 'session-1',
        type: 'cramp',
        detail: null,
        severity: null,
      }),
    ])
  })

  it('再点一次取消勾选，列表回到空', async () => {
    const w = await mountSession()
    const chip = () => w.findAll('.chip').find((c) => c.text() === '抽筋')!

    await chip().trigger('click')
    await flushPromises()
    expect(vi.mocked(repository.replaceAdverseReactions).mock.calls[0][1]).toHaveLength(1)

    await chip().trigger('click')
    await flushPromises()
    expect(vi.mocked(repository.replaceAdverseReactions).mock.calls[1][1]).toEqual([])
  })

  it('「其他」没写描述时不入库；写了描述（blur 触发）才写入 detail', async () => {
    const w = await mountSession()

    await w.findAll('.chip').find((c) => c.text() === '其他')!.trigger('click')
    await flushPromises()
    expect(vi.mocked(repository.replaceAdverseReactions).mock.calls[0][1]).toEqual([])

    const otherField = w.findAll('.van-field').find((f) => f.text().includes('其他'))!
    await otherField.find('input').setValue('皮肤瘙痒')
    await otherField.find('input').trigger('blur')
    await flushPromises()

    const lastList = vi.mocked(repository.replaceAdverseReactions).mock.calls.at(-1)![1]
    expect(lastList).toHaveLength(1)
    expect(lastList[0]).toMatchObject({ type: 'other', detail: '皮肤瘙痒', severity: null })
  })
})

describe('SessionView · 完成与中止', () => {
  it('未填下机后体重点「标记完成」：只弹提示，不改状态、不写库', async () => {
    const w = await mountSession(
      defaultData({ session: makeSession({ id: 'session-1', postWeightMeasured: null }) }),
    )
    vi.mocked(repository.saveSession).mockClear()

    await buttonByText(w.find('.status-actions'), '标记完成').trigger('click')
    await flushPromises()

    expect(mocks.showConfirmDialog).toHaveBeenCalledTimes(1)
    expect(String(mocks.showConfirmDialog.mock.calls[0][0].message)).toContain('请先填写下机后体重')
    // 不该出现任何「标记完成」的写入（挂载时那次防抖回写不算）
    expect(vi.mocked(repository.saveSession).mock.calls.map((c) => c[0].status)).not.toContain('completed')
    expect(w.find('.status-badge').text()).toBe('进行中')
  })

  it('填了下机后体重点「标记完成」：status=completed 且 updatedAt 刷新', async () => {
    const w = await mountSession()
    vi.mocked(repository.saveSession).mockClear()

    await buttonByText(w.find('.status-actions'), '标记完成').trigger('click')
    await flushPromises()

    expect(repository.saveSession).toHaveBeenCalledTimes(1)
    const saved = vi.mocked(repository.saveSession).mock.calls[0][0]
    expect(saved.status).toBe('completed')
    expect(saved.updatedAt).toBeGreaterThan(1_700_000_000_000) // 工厂里的旧 updatedAt
    expect(mocks.showToast).toHaveBeenCalledWith('已标记完成')
    expect(w.find('.status-badge').text()).toBe('已完成')
  })

  it('已完成的记录可以「改为进行中」', async () => {
    const w = await mountSession(defaultData({ session: makeSession({ id: 'session-1', status: 'completed' }) }))
    vi.mocked(repository.saveSession).mockClear()

    await buttonByText(w.find('.status-actions'), '改为进行中').trigger('click')
    await flushPromises()

    expect(vi.mocked(repository.saveSession).mock.calls[0][0].status).toBe('ongoing')
    expect(mocks.showToast).toHaveBeenCalledWith('已改为进行中')
    expect(w.find('.status-badge').text()).toBe('进行中')
  })

  it('中止透析：勾选原因后确认，status/abortedAt/abortTags 一起落库', async () => {
    const w = await mountSession()
    vi.mocked(repository.saveSession).mockClear()

    await buttonByText(w.find('.status-actions'), '中止透析').trigger('click')
    await flushPromises()

    const popup = popupByText(w, '常用原因（可多选）')
    await popup.findAll('.chip').find((c) => c.text() === '低血压')!.trigger('click')
    // 中止时间由「中止日期 + 中止时间」两个输入框决定，先读出来再断言
    const expectedTs = new Date(
      `${fieldInput(popup, '中止日期').element.value}T${fieldInput(popup, '中止时间').element.value}:00`,
    ).getTime()

    await buttonByText(popup, '确认中止').trigger('click')
    await flushPromises()

    expect(repository.saveSession).toHaveBeenCalledTimes(1)
    const saved = vi.mocked(repository.saveSession).mock.calls[0][0]
    expect(saved.status).toBe('aborted')
    expect(saved.abortTags).toEqual(['hypotension'])
    expect(saved.abortedAt).toBe(expectedTs)
    expect(dateStr(saved.abortedAt!)).toBe('2024-01-10') // 历史记录默认落在该次透析当天
    expect(saved.abortReason).toBeNull()
    expect(mocks.showToast).toHaveBeenCalledWith('已标记中止')
    expect(w.find('.status-badge').text()).toBe('已中止')
  })

  it('中止时可补文字描述（首尾空格被去掉），并回填已有的中止信息', async () => {
    const abortedAt = new Date('2024-01-10T09:30:00').getTime()
    const w = await mountSession(
      defaultData({
        session: makeSession({
          id: 'session-1',
          status: 'aborted',
          abortedAt,
          abortTags: ['clotting'],
          abortReason: '管路凝血',
        }),
      }),
    )
    vi.mocked(repository.saveSession).mockClear()

    await w.find('.abort-box button').trigger('click')
    await flushPromises()

    const popup = popupByText(w, '常用原因（可多选）')
    // 回填：日期/时间来自 abortedAt，标签为已存的中止原因
    expect(fieldInput(popup, '中止日期').element.value).toBe('2024-01-10')
    expect(fieldInput(popup, '中止时间').element.value).toBe('09:30')
    expect(popup.findAll('.chip.active').map((c) => c.text())).toEqual(['凝血/堵管'])

    await fieldInput(popup, '补充描述', 'textarea').setValue('  管路凝血，提前下机  ')
    await buttonByText(popup, '确认中止').trigger('click')
    await flushPromises()

    const saved = vi.mocked(repository.saveSession).mock.calls[0][0]
    expect(saved.abortReason).toBe('管路凝血，提前下机')
    expect(saved.abortedAt).toBe(abortedAt) // 未改动时间则沿用原值
  })

  it('离开页面时先把表单改动落库（含 trim 与 updatedAt 刷新）', async () => {
    const w = await mountSession()
    vi.mocked(repository.saveSession).mockClear()

    await fieldInput(w, '记录人').setValue('  李护士  ')
    await router.push('/')
    await flushPromises()

    expect(repository.saveSession).toHaveBeenCalledTimes(1)
    const saved = vi.mocked(repository.saveSession).mock.calls[0][0]
    expect(saved.operator).toBe('李护士')
    expect(saved.status).toBe('ongoing')
    expect(saved.updatedAt).toBeGreaterThan(1_700_000_000_000)
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('删除整条记录：确认后 deleteSession 并回到首页', async () => {
    const w = await mountSession()
    vi.mocked(repository.saveSession).mockClear()

    // 删除入口在页面底部危险区（L3），不在右上角图标区
    await buttonByText(w, '删除本条记录').trigger('click')
    await flushPromises()

    expect(mocks.showConfirmDialog).toHaveBeenCalledTimes(1)
    expect(repository.deleteSession).toHaveBeenCalledWith('session-1')
    expect(router.currentRoute.value.path).toBe('/')
    // 记录已置空，离开守卫不会再写一次
    expect(repository.saveSession).not.toHaveBeenCalled()
  })

  it('删除整条记录：取消时不删库也不跳转', async () => {
    const w = await mountSession()
    mocks.showConfirmDialog.mockRejectedValueOnce(new Error('cancel'))

    await buttonByText(w, '删除本条记录').trigger('click')
    await flushPromises()

    expect(repository.deleteSession).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/session/session-1')
    expect(w.find('.status-badge').exists()).toBe(true)
  })

  it('点右上角报告图标跳到报告页', async () => {
    const w = await mountSession()

    await w.find('.van-nav-bar .van-icon-description').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/report/session-1')
  })

  it('打开详情页后不做任何修改：400ms 后绝不回写（H2，旧实现会整行 upsert 把另一端的修改抹掉）', async () => {
    // 只冻结定时器、不冻结 setImmediate，flushPromises 仍能正常把挂载期的微任务排空
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await mountSession()
    vi.mocked(repository.saveSession).mockClear()

    await vi.advanceTimersByTimeAsync(400)

    expect(repository.saveSession).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('只改了记录人：400ms 后仍然回写一次（新逻辑不能把正常保存也拦掉）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const w = await mountSession()
    vi.mocked(repository.saveSession).mockClear()

    await fieldInput(w, '记录人').setValue('李护士')
    await vi.advanceTimersByTimeAsync(400)

    expect(repository.saveSession).toHaveBeenCalledTimes(1)
    expect(vi.mocked(repository.saveSession).mock.calls[0][0].operator).toBe('李护士')
    vi.useRealTimers()
  })
})

describe('SessionView · H1 写失败必须让用户看见', () => {
  it('表单防抖保存失败：toast 提示，不再静默丢数据', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const w = await mountSession()
    vi.mocked(repository.saveSession).mockRejectedValueOnce(new Error('offline'))

    await fieldInput(w, '记录人').setValue('李护士')
    await vi.advanceTimersByTimeAsync(400)

    expect(mocks.showToast).toHaveBeenCalledWith('保存失败，请检查网络后重试')
    vi.useRealTimers()
  })

  it('离开页面时保存失败：toast 提示（原来只 console.error）', async () => {
    const w = await mountSession()
    vi.mocked(repository.saveSession).mockRejectedValueOnce(new Error('offline'))

    await fieldInput(w, '记录人').setValue('李护士')
    await router.push('/')
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('保存失败，请检查网络后重试')
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('新增血压保存失败：给出提示、不刷新列表、弹窗不关（内容还在，可直接重试）', async () => {
    const w = await mountSession()
    vi.mocked(repository.saveBloodPressure).mockRejectedValueOnce(new Error('offline'))

    await buttonByText(cardByTitle(w, '血压'), '记录').trigger('click')
    await flushPromises()
    const popup = popupByText(w, '记录血压')
    await fieldInput(popup, '高压').setValue('135')
    await fieldInput(popup, '低压').setValue('85')
    await buttonByText(popup, '保存').trigger('click')
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('保存失败，请检查网络后重试')
    expect(mocks.showToast).not.toHaveBeenCalledWith('已保存：血压 135/85 正常')
    expect(popup.isVisible()).toBe(true)
    expect(repository.listBloodPressures).toHaveBeenCalledTimes(1)

    // 再点一次保存：成功写入并关窗（id 仍是同一个）
    await buttonByText(popup, '保存').trigger('click')
    await flushPromises()
    expect(repository.saveBloodPressure).toHaveBeenCalledTimes(2)
    expect(vi.mocked(repository.saveBloodPressure).mock.calls[1][0].id).toBe('uuid-fixed-1')
    expect(repository.listBloodPressures).toHaveBeenCalledTimes(2)
  })

  it('删除血压失败：给出提示且不刷新列表（不再「点了没反应」）', async () => {
    const w = await mountSession(defaultData({ bps: [makeBp({ id: 'bp1', systolic: 145, diastolic: 92 })] }))
    vi.mocked(repository.deleteBloodPressure).mockRejectedValueOnce(new Error('offline'))

    await cardByTitle(w, '血压').find('.van-icon-delete-o').trigger('click')
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('删除失败，请检查网络后重试')
    expect(mocks.showToast).not.toHaveBeenCalledWith('已删除')
    expect(repository.listBloodPressures).toHaveBeenCalledTimes(1)
  })

  it('不良反应保存失败：给出提示（原来连 await 都没有）', async () => {
    const w = await mountSession()
    vi.mocked(repository.replaceAdverseReactions).mockRejectedValueOnce(new Error('offline'))

    await w.findAll('.chip').find((c) => c.text() === '抽筋')!.trigger('click')
    await flushPromises()

    expect(repository.replaceAdverseReactions).toHaveBeenCalledTimes(1)
    expect(mocks.showToast).toHaveBeenCalledWith('不良反应保存失败，请检查网络后重试')
  })

  it('删除整条记录失败：给出提示并留在详情页', async () => {
    const w = await mountSession()
    vi.mocked(repository.deleteSession).mockRejectedValueOnce(new Error('offline'))

    await buttonByText(w, '删除本条记录').trigger('click')
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('删除失败，请检查网络后重试')
    expect(router.currentRoute.value.path).toBe('/session/session-1')
    expect(w.find('.status-badge').exists()).toBe(true)
  })

  it('状态保存失败：提示并回滚界面状态（页面不能显示云端并不存在的状态）', async () => {
    const w = await mountSession()
    vi.mocked(repository.saveSession).mockRejectedValueOnce(new Error('offline'))

    await buttonByText(w.find('.status-actions'), '标记完成').trigger('click')
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('状态保存失败，请检查网络后重试')
    expect(w.find('.status-badge').text()).toBe('进行中')
  })
})

describe('SessionView · H2 多设备：只在未改动时合并远端新值', () => {
  it('另一端刚改了体重并标记完成：本机未改动时会合并显示新值', async () => {
    const w = await mountSession()
    expect(weightInputs(w)[1].element.value).toBe('77')

    vi.mocked(repository.getSession).mockResolvedValue(
      makeSession({
        id: 'session-1',
        date: '2024-01-10',
        preWeightMeasured: 80,
        postWeightMeasured: 55.5,
        wheelchairWeightUsed: 20,
        rinseBackVolumeUsed: 300,
        status: 'completed',
        updatedAt: 1_700_000_500_000,
      }),
    )
    cacheVersion.value += 1
    await flushPromises()

    expect(weightInputs(w)[1].element.value).toBe('55.5')
    expect(w.find('.status-badge').text()).toBe('已完成')
    // 合并本身不写库
    expect(repository.saveSession).not.toHaveBeenCalled()
  })

  it('用户正在输入时 cacheVersion 自增：绝不覆盖正在输入的内容（AGENTS.md 约定）', async () => {
    const w = await mountSession()
    await fieldInput(w, '记录人').setValue('李护士')

    vi.mocked(repository.getSession).mockResolvedValue(
      makeSession({ id: 'session-1', operator: '王医生', updatedAt: 1_700_000_500_000 }),
    )
    cacheVersion.value += 1
    await flushPromises()

    expect(fieldInput(w, '记录人').element.value).toBe('李护士')
  })

  it('远端数据并不更新（updatedAt 更旧）时不合并，避免把刚保存的值顶回去', async () => {
    const w = await mountSession()

    vi.mocked(repository.getSession).mockResolvedValue(
      makeSession({ id: 'session-1', postWeightMeasured: 66, updatedAt: 1 }),
    )
    cacheVersion.value += 1
    await flushPromises()

    expect(weightInputs(w)[1].element.value).toBe('77')
  })

  it('记录已被另一端删除：不复活、不回写，也不打断用户', async () => {
    const w = await mountSession()
    vi.mocked(repository.saveSession).mockClear()
    vi.mocked(repository.getSession).mockResolvedValue(undefined)

    cacheVersion.value += 1
    await flushPromises()

    expect(repository.saveSession).not.toHaveBeenCalled()
    expect(w.find('.status-badge').exists()).toBe(true)
  })
})

describe('SessionView · H4 只读角色看不到编辑入口', () => {
  it('挂载时会拉取当前角色（本地模式由 store 自己跳过）', async () => {
    await mountSession()
    expect(mocks.refreshCurrentRole).toHaveBeenCalled()
  })

  it('只读角色：隐藏状态切换、＋记录、编辑/删除图标与删除整条入口，并给出提示', async () => {
    setReadOnly(true)
    const w = await mountSession(
      defaultData({
        bps: [makeBp({ id: 'bp1', systolic: 130, diastolic: 80 })],
        glucoses: [makeBg({ id: 'bg1', value: 6.5 })],
        flows: [makeBf({ id: 'bf1', value: 250 })],
      }),
    )

    expect(w.find('.readonly-banner').text()).toContain('只读成员')
    expect(w.find('.status-actions').exists()).toBe(false)
    expect(w.find('.abort-box button').exists()).toBe(false)
    expect(w.findAll('button').some((b) => b.text().includes('＋ 记录'))).toBe(false)
    expect(w.find('.van-icon-edit').exists()).toBe(false)
    expect(w.find('.danger-zone').exists()).toBe(false)
    // 数据本身仍然看得到
    expect(w.text()).toContain('130 / 80')
    expect(w.text()).toContain('250')
  })

  it('只读角色：体重/日期/备注不可编辑，不良反应点不动（不会写库）', async () => {
    setReadOnly(true)
    const w = await mountSession()

    expect(weightInputs(w).every((i) => i.element.readOnly)).toBe(true)
    expect(fieldInput(w, '透析日期').element.readOnly).toBe(true)
    expect(fieldInput(w, '备注').element.readOnly).toBe(true)

    await w.findAll('.chip').find((c) => c.text() === '抽筋')!.trigger('click')
    await flushPromises()
    expect(repository.replaceAdverseReactions).not.toHaveBeenCalled()
    expect(w.findAll('.chip.active')).toHaveLength(0)
  })

  it('只读角色：「其他」不良反应只读展示，不再渲染可编辑输入框', async () => {
    setReadOnly(true)
    const w = await mountSession(
      defaultData({ reactions: [makeReaction({ id: 'ar1', type: 'other', detail: '发热' })] }),
    )

    expect(w.find('.readonly-other').text()).toContain('发热')
    expect(w.findAll('.van-field').some((f) => f.text().includes('其他'))).toBe(false)
  })
})

describe('SessionView · M1/M2 连点守卫', () => {
  it('连点「保存」只写一条血压（保存中按钮 loading、取消禁用）', async () => {
    let release!: () => void
    vi.mocked(repository.saveBloodPressure).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve()
        }),
    )
    const w = await mountSession()

    await buttonByText(cardByTitle(w, '血压'), '记录').trigger('click')
    await flushPromises()
    const popup = popupByText(w, '记录血压')
    await fieldInput(popup, '高压').setValue('135')
    await fieldInput(popup, '低压').setValue('85')

    await buttonByText(popup, '保存').trigger('click')
    await flushPromises()

    // 提交中：保存按钮进入 loading（loading 期间 Vant 直接吞掉点击，源码的 saving 守卫是第二道防线）
    const busyBtn = popup.find('.van-button--loading')
    expect(busyBtn.exists()).toBe(true)
    await busyBtn.trigger('click')
    await flushPromises()

    expect(repository.saveBloodPressure).toHaveBeenCalledTimes(1)
    expect(vi.mocked(repository.saveBloodPressure).mock.calls[0][0].id).toBe('uuid-fixed-1')

    release()
    await flushPromises()
    expect(repository.saveBloodPressure).toHaveBeenCalledTimes(1)
  })

  it('连点「标记完成」只写一次状态', async () => {
    let release!: () => void
    vi.mocked(repository.saveSession).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve()
        }),
    )
    const w = await mountSession()

    await buttonByText(w.find('.status-actions'), '标记完成').trigger('click')
    await flushPromises()

    // 提交中：原按钮变 loading，连点不会把状态又翻回去
    const busyBtn = w.find('.status-actions .van-button--loading')
    expect(busyBtn.exists()).toBe(true)
    await busyBtn.trigger('click')
    await flushPromises()

    expect(repository.saveSession).toHaveBeenCalledTimes(1)
    release()
    await flushPromises()
    expect(repository.saveSession).toHaveBeenCalledTimes(1)
    expect(mocks.showToast).toHaveBeenCalledWith('已标记完成')
    expect(w.find('.status-badge').text()).toBe('已完成')
  })
})

describe('SessionView · M5 切回进行中会清空中止信息', () => {
  it('改为进行中：abortedAt/abortTags/abortReason 一起清空', async () => {
    const w = await mountSession(
      defaultData({
        session: makeSession({
          id: 'session-1',
          status: 'aborted',
          abortedAt: new Date('2024-01-10T09:30:00').getTime(),
          abortTags: ['hypotension'],
          abortReason: '血压偏低',
        }),
      }),
    )
    vi.mocked(repository.saveSession).mockClear()

    await buttonByText(w.find('.status-actions'), '改为进行中').trigger('click')
    await flushPromises()

    const saved = vi.mocked(repository.saveSession).mock.calls[0][0]
    expect(saved.status).toBe('ongoing')
    expect(saved.abortedAt).toBeNull()
    expect(saved.abortTags).toEqual([])
    expect(saved.abortReason).toBeNull()
  })

  it('清空之后再「中止透析」：弹窗不会回填上一次的中止时间', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2024-01-10T14:20:00'))
    const w = await mountSession(
      defaultData({
        session: makeSession({
          id: 'session-1',
          status: 'aborted',
          abortedAt: new Date('2024-01-10T09:30:00').getTime(),
          abortTags: ['hypotension'],
          abortReason: '血压偏低',
        }),
      }),
    )

    await buttonByText(w.find('.status-actions'), '改为进行中').trigger('click')
    await flushPromises()
    await buttonByText(w.find('.status-actions'), '中止透析').trigger('click')
    await flushPromises()

    const popup = popupByText(w, '常用原因（可多选）')
    expect(fieldInput(popup, '中止日期').element.value).toBe('2024-01-10')
    expect(fieldInput(popup, '中止时间').element.value).toBe('14:20')
    expect(popup.findAll('.chip.active')).toHaveLength(0)
  })
})

describe('SessionView · M6 数值量程校验', () => {
  it('血糖 999 不写库，只提示', async () => {
    const w = await mountSession()

    await buttonByText(cardByTitle(w, '血糖'), '记录').trigger('click')
    await flushPromises()
    const popup = popupByText(w, '记录血糖')
    await fieldInput(popup, '血糖值').setValue('999')
    await buttonByText(popup, '保存').trigger('click')
    await flushPromises()

    expect(repository.saveBloodGlucose).not.toHaveBeenCalled()
    expect(mocks.showToast).toHaveBeenCalledWith('血糖应在 0.5~50 mmol/L 之间，请检查输入')
  })

  it('血流量 99999 与粘贴进来的 -5 都不写库', async () => {
    const w = await mountSession()

    await buttonByText(cardByTitle(w, '血流量'), '记录').trigger('click')
    await flushPromises()
    const popup = popupByText(w, '记录血流量')
    await fieldInput(popup, '血流量').setValue('99999')
    await buttonByText(popup, '保存').trigger('click')
    await flushPromises()
    await fieldInput(popup, '血流量').setValue('-5')
    await buttonByText(popup, '保存').trigger('click')
    await flushPromises()

    expect(repository.saveBloodFlow).not.toHaveBeenCalled()
    expect(mocks.showToast).toHaveBeenCalledWith('血流量应在 0~600 ml/min 之间，请检查输入')
  })

  it('血压 500/500 不写库，只提示', async () => {
    const w = await mountSession()

    await buttonByText(cardByTitle(w, '血压'), '记录').trigger('click')
    await flushPromises()
    const popup = popupByText(w, '记录血压')
    await fieldInput(popup, '高压').setValue('500')
    await fieldInput(popup, '低压').setValue('500')
    await buttonByText(popup, '保存').trigger('click')
    await flushPromises()

    expect(repository.saveBloodPressure).not.toHaveBeenCalled()
    expect(mocks.showToast).toHaveBeenCalledWith('血压应在 40~300/20~200 mmHg 之间，请检查输入')
  })

  it('详情页体重越界：不写库并提示（同一个提示不重复弹）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const w = await mountSession()
    vi.mocked(repository.saveSession).mockClear()

    await weightInputs(w)[1].setValue('5')
    await vi.advanceTimersByTimeAsync(400)
    await weightInputs(w)[1].setValue('5.5')
    await vi.advanceTimersByTimeAsync(400)

    expect(repository.saveSession).not.toHaveBeenCalled()
    expect(mocks.showToast).toHaveBeenCalledTimes(1)
    expect(mocks.showToast).toHaveBeenCalledWith('下机后体重需在 20~200kg 之间（未保存）')
    vi.useRealTimers()
  })

  it('量程内的体重照常保存（不能把正常输入也拦掉）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const w = await mountSession()
    vi.mocked(repository.saveSession).mockClear()

    await weightInputs(w)[1].setValue('55.5')
    await vi.advanceTimersByTimeAsync(400)

    expect(repository.saveSession).toHaveBeenCalledTimes(1)
    expect(vi.mocked(repository.saveSession).mock.calls[0][0].postWeightMeasured).toBe(55.5)
    vi.useRealTimers()
  })

  it('全角（中文输入法）逗号当小数点：70，5 → 70.5（不是 705）', async () => {
    const w = await mountSession()

    await weightInputs(w)[0].setValue('70，5')

    expect(weightInputs(w)[0].element.value).toBe('70.5')
  })
})

describe('SessionView · M8 删除文案与提示', () => {
  it('删除血压：确认文案带上时间与数值，删完提示「已删除」', async () => {
    const w = await mountSession(
      defaultData({
        bps: [makeBp({ id: 'bp1', measuredAt: new Date('2024-01-10T10:00:00').getTime(), systolic: 145, diastolic: 92 })],
      }),
    )

    await cardByTitle(w, '血压').find('.van-icon-delete-o').trigger('click')
    await flushPromises()

    expect(String(mocks.showConfirmDialog.mock.calls[0][0].message)).toBe('删除 10:00 的血压（145/92）？')
    expect(mocks.showToast).toHaveBeenCalledWith('已删除')
  })

  it('删除整条记录：文案写明日期并补齐「血流量」', async () => {
    const w = await mountSession()

    await buttonByText(w, '删除本条记录').trigger('click')
    await flushPromises()

    const msg = String(mocks.showConfirmDialog.mock.calls[0][0].message)
    expect(msg).toContain('1月10日 周三') // 2024-01-10 是周三
    expect(msg).toContain('血流量')
  })
})

describe('SessionView · 加载失败可重试 + L3 删除入口位置', () => {
  it('加载失败：骨架收起、显示错误态与「重试」；重试成功后渲染内容', async () => {
    vi.mocked(repository.getSession).mockRejectedValueOnce(new Error('offline'))
    const w = await mountSession()

    expect(w.findComponent({ name: 'VanSkeleton' }).exists()).toBe(false)
    expect(w.find('.load-error-text').text()).toContain('加载失败')
    expect(w.find('.weight-input').exists()).toBe(false)

    await buttonByText(w, '重试').trigger('click')
    await flushPromises()

    expect(w.find('.load-error').exists()).toBe(false)
    expect(w.find('.status-badge').text()).toBe('进行中')
    expect(weightInputs(w)[1].element.value).toBe('77')
  })

  it('删除入口在页面底部危险区，右上角只留「报告」（L3：两个图标原来只隔 16px）', async () => {
    const w = await mountSession()

    expect(w.find('.van-nav-bar .van-icon-description').exists()).toBe(true)
    expect(w.find('.van-nav-bar .van-icon-delete-o').exists()).toBe(false)
    expect(w.findAll('button').some((b) => b.text().includes('删除本条记录'))).toBe(true)
  })
})

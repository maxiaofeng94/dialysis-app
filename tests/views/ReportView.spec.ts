/**
 * ReportView（透析报告页）组件测试
 *
 * 覆盖：加载骨架、关键字段（日期/体重/脱水量/干体重/状态）、空数据兜底、中止区块、
 * 血压曲线与列表、分享按钮存在且点击不抛错（含失败兜底）。
 *
 * jsdom 限制说明：
 * - html2canvas 依赖真实 canvas，这里整体替换为返回假 canvas 的桩；
 * - `Capacitor.isNativePlatform()` 在 jsdom 下恒为 false，因此走的是浏览器分支
 *   （生成图片 → navigator.share 或 <a download> 兜底）；
 * - BaseChart 依赖 echarts，本文件把 echarts 模块桩掉即可真实渲染该子组件。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper, type DOMWrapper } from '@vue/test-utils'
import { createRouter, createMemoryHistory, RouterView, type Router } from 'vue-router'
import { defineComponent, h } from 'vue'
import Vant from 'vant'
import ReportView from '../../src/views/ReportView.vue'
import BaseChart from '../../src/components/BaseChart.vue'
import { repository } from '../../src/repo'
import { cacheVersion } from '../../src/lib/cloudCache'
import { makePatient, makeDryWeight, makeSession, makeBp, makeBg, makeBf, makeReaction } from '../helpers/factories'
import * as patientModule from '../../src/stores/patient'

const html2canvasMock = vi.hoisted(() => vi.fn())
const mocks = vi.hoisted(() => ({ showToast: vi.fn() }))
const echartsStub = vi.hoisted(() => ({
  init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })),
}))

vi.mock('html2canvas', () => ({ default: html2canvasMock }))
vi.mock('echarts', () => ({ init: echartsStub.init }))
vi.mock('vant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vant')>()
  return { ...actual, showToast: mocks.showToast }
})

vi.mock('../../src/repo', () => ({
  repository: {
    getSession: vi.fn(),
    getPatient: vi.fn(),
    listDryWeights: vi.fn(),
    listBloodPressures: vi.fn(),
    listBloodGlucoses: vi.fn(),
    listBloodFlows: vi.fn(),
    listAdverseReactions: vi.fn(),
  },
}))

// 用真 ref：跨病人拦截的用例需要能切病人（对象字面量改不动）
vi.mock('../../src/stores/patient', async () => {
  const { ref } = await import('vue')
  const currentPatientId = ref('patient-default')
  return { currentPatientId, __currentPatientId: currentPatientId }
})

const Blank = defineComponent({ render: () => h('div') })
const Harness = defineComponent({ render: () => h(RouterView) })

let wrapper: VueWrapper | null = null

/**
 * 当前病人 id 的真 ref。跨病人拦截的用例必须**直接改这个 ref** ——
 * 它同时被 `ReportView` 与测试共享。
 */
const currentPatientIdRef = (patientModule as unknown as { __currentPatientId: { value: string } })
  .__currentPatientId
let router: Router

function buttonByText(scope: VueWrapper, text: string): DOMWrapper<HTMLButtonElement> {
  const btn = scope.findAll('button').find((b) => b.text().includes(text))
  if (!btn) throw new Error(`未找到文案包含「${text}」的按钮`)
  return btn as DOMWrapper<HTMLButtonElement>
}

/** 把 showToast 的全部调用拼起来，便于断言「提示里包含某某文案」 */
function toastText(): string {
  return mocks.showToast.mock.calls.map((c) => String(c[0])).join('｜')
}

/** 截获 downloadDataUrl 创建的那个 <a download="…">（它没有插入文档，只能从 createElement 处截获） */
function captureAnchor(): () => HTMLAnchorElement | null {
  const original = document.createElement.bind(document)
  let anchor: HTMLAnchorElement | null = null
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) => {
    const el = original(tag, options)
    if (tag === 'a') anchor = el as HTMLAnchorElement
    return el
  }) as typeof document.createElement)
  return () => anchor
}

interface ReportData {
  session?: ReturnType<typeof makeSession> | null
  patient?: ReturnType<typeof makePatient> | null
  dryWeights?: ReturnType<typeof makeDryWeight>[]
  bps?: ReturnType<typeof makeBp>[]
  glucoses?: ReturnType<typeof makeBg>[]
  flows?: ReturnType<typeof makeBf>[]
  reactions?: ReturnType<typeof makeReaction>[]
}

function defaultData(patch: Partial<ReportData> = {}): ReportData {
  return {
    session: makeSession({
      id: 'session-1',
      date: '2024-01-10',
      preWeightMeasured: 80,
      postWeightMeasured: 77,
      wheelchairWeightUsed: 20,
      rinseBackVolumeUsed: 300,
      doctorUf: 2000, // 存储为 ml，报告里显示 2.0L
      status: 'completed',
    }),
    patient: makePatient({ name: '张三', birthday: '1950-06-01' }),
    dryWeights: [makeDryWeight({ id: 'd1', value: 60, effectiveDate: '2024-01-01' })],
    ...patch,
  }
}

function stubReportData(data: ReportData = defaultData()) {
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

async function mountReport(data: ReportData = defaultData()): Promise<VueWrapper> {
  stubReportData(data)
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Blank },
      { path: '/report/:id', component: ReportView },
    ],
  })
  await router.push('/report/session-1')
  await router.isReady()
  wrapper = mount(Harness, { global: { plugins: [Vant, router] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  // 冻结「今天」，让年龄展示与运行日期无关
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2024-06-01T10:00:00'))

  html2canvasMock.mockReset()
  html2canvasMock.mockResolvedValue({
    toDataURL: () => 'data:image/png;base64,AAAA',
    toBlob: (cb: (b: Blob) => void) => cb(new Blob(['fake'], { type: 'image/png' })),
  })
  mocks.showToast.mockReset()
  echartsStub.init.mockClear()
  // 每个用例从「记录与当前病人一致」的常态开始
  currentPatientIdRef.value = 'patient-default'
  for (const fn of Object.values(repository) as unknown as ReturnType<typeof vi.fn>[]) {
    fn.mockReset()
  }
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  delete (navigator as unknown as { share?: unknown }).share
  delete (navigator as unknown as { canShare?: unknown }).canShare
})

describe('ReportView · 加载', () => {
  it('加载中显示骨架，数据到位后消失', async () => {
    stubReportData()
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: Blank },
        { path: '/report/:id', component: ReportView },
      ],
    })
    await router.push('/report/session-1')
    await router.isReady()
    const w = mount(Harness, { global: { plugins: [Vant, router] } })
    wrapper = w

    expect(w.findComponent({ name: 'VanSkeleton' }).exists()).toBe(true)
    await flushPromises()
    expect(w.findComponent({ name: 'VanSkeleton' }).exists()).toBe(false)
  })

  it('记录不存在时跳回首页，不渲染报告内容', async () => {
    const w = await mountReport(defaultData({ session: null }))

    expect(router.currentRoute.value.path).toBe('/')
    expect(w.find('.report-flow').exists()).toBe(false)
  })

  /**
   * M-1（独立评审）：**跨病人拦截**的防线。
   *
   * 场景：用户在病人 A 的报告页 → 切到病人 B → 按返回键回到旧的 `/report/:id`。
   * 报告会按**B 的姓名/干体重/轮椅重量**去渲染 **A 的记录** —— 一份张冠李戴的报告。
   * `resolveEffectiveConfig` 的归属校验只能兜住重量，姓名与干体重仍会串。
   *
   * 独立评审实测：把 `ReportView.vue:73-77` 那段拦截整段删除，1728 条用例照样全绿 ——
   * 该拦截此前**零覆盖**（同模式在 SessionView 有覆盖，报告页漏了）。
   */
  it('记录属于其他病人：提示并跳回首页，绝不渲染对方的报告（跨病人拦截）', async () => {
    // 当前病人是 B，但这条记录属于 A
    currentPatientIdRef.value = 'patient-b'
    const w = await mountReport(
      defaultData({
        session: makeSession({ id: 'session-1', patientId: 'patient-a', date: '2024-01-10' }),
        patient: makePatient({ id: 'patient-b', name: '李四' }),
      }),
    )

    expect(router.currentRoute.value.path).toBe('/')
    expect(toastText()).toContain('其他病人')
    // 绝不能渲染出报告（尤其是 A 的数据配 B 的姓名）
    expect(w.find('.report-flow').exists()).toBe(false)
    expect(w.text()).not.toContain('李四')
  })

  it('加载失败：留在页面上给提示与重试按钮，不跳回首页、不留永久骨架（H4）', async () => {
    // 云端读接口查询失败会抛错（数据层保证）——这与「确实没有这条记录」必须区分开
    vi.mocked(repository.getSession).mockRejectedValueOnce(new Error('查询失败（sessions）：Failed to fetch'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const w = await mountReport()

    expect(router.currentRoute.value.path).toBe('/report/session-1') // 没有静默跳走
    expect(w.text()).toContain('报告加载失败')
    expect(w.findComponent({ name: 'VanSkeleton' }).exists()).toBe(false) // loading 在 finally 复位
    expect(w.find('.report-flow').exists()).toBe(false)
    expect(errSpy).toHaveBeenCalled()
  })

  it('加载失败后点「重试」能重新拉取并正常渲染（H4）', async () => {
    vi.mocked(repository.listBloodPressures).mockRejectedValueOnce(new Error('查询失败（血压）：Failed to fetch'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const w = await mountReport()
    expect(w.text()).toContain('报告加载失败')

    await buttonByText(w, '重试').trigger('click')
    await flushPromises()

    expect(w.text()).not.toContain('报告加载失败')
    expect(w.find('.report-flow').exists()).toBe(true)
    expect(w.text()).toContain('张三 · 2024-01-10')
  })

  it('刷新（cacheVersion 变化）时失败不会把已渲染的报告打回首页，只提示刷新失败', async () => {
    const w = await mountReport()
    expect(w.find('.report-flow').exists()).toBe(true)

    vi.mocked(repository.getSession).mockRejectedValueOnce(new Error('Failed to fetch'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    cacheVersion.value += 1
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/report/session-1')
    expect(w.find('.report-flow').exists()).toBe(true) // 旧报告留着，不闪回错误页
    expect(toastText()).toContain('报告刷新失败')
  })

  it('七个数据源都按当前病人/记录并行请求', async () => {
    await mountReport()

    expect(repository.getSession).toHaveBeenCalledWith('session-1')
    expect(repository.getPatient).toHaveBeenCalledWith('patient-default')
    expect(repository.listDryWeights).toHaveBeenCalledWith('patient-default')
    expect(repository.listBloodPressures).toHaveBeenCalledWith('session-1')
    expect(repository.listBloodGlucoses).toHaveBeenCalledWith('session-1')
    expect(repository.listBloodFlows).toHaveBeenCalledWith('session-1')
    expect(repository.listAdverseReactions).toHaveBeenCalledWith('session-1')
  })
})

describe('ReportView · 关键字段渲染', () => {
  it('页头显示姓名、透析日期、年龄与状态', async () => {
    const w = await mountReport()

    expect(w.text()).toContain('张三 · 2024-01-10')
    expect(w.text()).toContain('年龄约 74 岁') // 冻结在 2024-06-01
    expect(w.find('.report-status').text()).toBe('已完成')
    expect(w.find('.report-status').classes()).toContain('completed')
  })

  it('有记录人时页头显示记录人', async () => {
    const w = await mountReport(
      defaultData({ session: makeSession({ id: 'session-1', operator: '李护士', status: 'completed' }) }),
    )
    expect(w.text()).toContain('记录人 李护士')
  })

  it('体重与脱水量与 calcWeights 一致（含医生设定脱水 ml→L）', async () => {
    const w = await mountReport()

    const rvals = w.findAll('.rval').map((n) => n.text())
    expect(rvals[0]).toBe('60.0kg') // 上机前：80 - 20
    expect(rvals[1]).toBe('57.0kg') // 下机后：77 - 20
    expect(w.find('.rdiff').text()).toBe('脱 3.0L')

    const ufs = w.findAll('.ruf').map((n) => n.text())
    expect(ufs[0]).toBe('医生设定脱水量2.0 L') // 2000ml → 2.0L
    expect(ufs[1]).toBe('计划脱水量0.0 L') // 60.0 - 60
    expect(ufs[2]).toBe('实际脱水量3.0 L')

    expect(w.find('.report-meta').text()).toBe('干体重 60.0kg · 回水 300ml · 机器超滤 0.3L')
  })

  it('血压列表渲染评估标签，并挂载血压曲线图', async () => {
    const w = await mountReport(
      defaultData({
        bps: [
          makeBp({ id: 'bp1', measuredAt: new Date('2024-01-10T08:00:00').getTime(), systolic: 130, diastolic: 80 }),
          makeBp({ id: 'bp2', measuredAt: new Date('2024-01-10T09:00:00').getTime(), systolic: 150, diastolic: 95 }),
        ],
      }),
    )

    expect(w.text()).not.toContain('暂无血压记录')
    expect(w.findComponent(BaseChart).exists()).toBe(true)
    expect(echartsStub.init).toHaveBeenCalledTimes(1)

    const kvs = w.findAll('.kv').filter((k) => k.find('.k').text().includes(':'))
    expect(kvs[0].text()).toContain('08:00')
    expect(kvs[0].text()).toContain('130 / 80 mmHg')
    expect(kvs[0].find('.van-tag').text()).toBe('正常')
    expect(kvs[1].find('.van-tag').text()).toBe('偏高')
  })

  it('血糖取第一条并带上评估标签，血流量逐条列出', async () => {
    const w = await mountReport(
      defaultData({
        glucoses: [
          makeBg({ id: 'bg1', measuredAt: new Date('2024-01-10T08:10:00').getTime(), value: 12 }),
          makeBg({ id: 'bg2', measuredAt: new Date('2024-01-10T09:10:00').getTime(), value: 6 }),
        ],
        flows: [makeBf({ id: 'bf1', measuredAt: new Date('2024-01-10T08:20:00').getTime(), value: 250 })],
      }),
    )

    expect(w.text()).toContain('12.0 mmol/L') // 只展示第一条
    expect(w.text()).toContain('偏高')
    expect(w.text()).toContain('血流量')
    expect(w.text()).toContain('250 ml/min')
  })

  it('不良反应：有记录时按标签/描述拼接，无记录时显示「无」', async () => {
    const withReactions = await mountReport(
      defaultData({
        reactions: [
          makeReaction({ id: 'ar1', type: 'cramp' }),
          makeReaction({ id: 'ar2', type: 'other', detail: '皮肤瘙痒' }),
        ],
      }),
    )
    expect(withReactions.text()).toContain('抽筋、皮肤瘙痒')
    withReactions.unmount()

    const noReactions = await mountReport(defaultData({ reactions: [] }))
    const reactionRow = noReactions.findAll('.kv').find((k) => k.find('.k').text() === '不良反应')
    expect(reactionRow!.find('.v').text()).toBe('无')
  })

  it('有备注时显示备注内容', async () => {
    const w = await mountReport(
      defaultData({ session: makeSession({ id: 'session-1', notes: '透析顺利', status: 'completed' }) }),
    )
    expect(w.text()).toContain('备注：透析顺利')
  })

  it('中止记录显示中止时间与原因', async () => {
    const abortedAt = new Date('2024-01-10T09:30:00').getTime()
    const w = await mountReport(
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

    const box = w.find('.report-abort')
    expect(box.exists()).toBe(true)
    expect(box.text()).toContain('本次透析已中止')
    expect(box.text()).toContain('中止时间：2024-01-10 09:30')
    expect(box.text()).toContain('中止原因：低血压、血压持续偏低')
    expect(w.find('.report-status').text()).toBe('已中止')
  })
})

describe('ReportView · 空数据兜底', () => {
  it('没有血压/血糖/血流量/不良反应时不崩，各显示占位文案', async () => {
    const w = await mountReport()

    expect(w.text()).toContain('暂无血压记录')
    expect(w.findComponent(BaseChart).exists()).toBe(false) // 没有数据就不渲染图表
    expect(echartsStub.init).not.toHaveBeenCalled()

    const glucoseRow = w.findAll('.kv').find((k) => k.find('.k').text() === '血糖')
    expect(glucoseRow!.find('.v').text()).toBe('—')
    expect(w.text()).not.toContain('血流量')
    expect(w.text()).not.toContain('备注：')
  })

  it('没有干体重记录时计划脱水与干体重显示占位符', async () => {
    const w = await mountReport(defaultData({ dryWeights: [] }))

    expect(w.findAll('.ruf')[1].text()).toBe('计划脱水量— L')
    expect(w.find('.report-meta').text()).toContain('干体重 —kg')
  })
})

describe('ReportView · 分享', () => {
  it('没有 navigator.share 时走浏览器下载：生成图片、触发下载并提示已下载', async () => {
    const w = await mountReport()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const getAnchor = captureAnchor()

    const shareIcon = w.find('.van-nav-bar .van-icon-share-o')
    expect(shareIcon.exists()).toBe(true)

    await shareIcon.trigger('click')
    await flushPromises()

    expect(html2canvasMock).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(getAnchor()!.download).toBe('透析报告-2024-01-10.png')
    expect(getAnchor()!.href).toBe('data:image/png;base64,AAAA')
    expect(errSpy).not.toHaveBeenCalled()
    expect(toastText()).toContain('报告图片已下载')
  })

  it('支持分享文件时调系统分享，带上图片与报告摘要', async () => {
    const shareSpy = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'share', { value: shareSpy, configurable: true })
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true })
    const w = await mountReport()

    await w.find('.van-nav-bar .van-icon-share-o').trigger('click')
    await flushPromises()

    expect(shareSpy).toHaveBeenCalledTimes(1)
    const payload = shareSpy.mock.calls[0][0] as { title: string; text: string; files: File[] }
    expect(payload.title).toBe('透析报告')
    expect(payload.files).toHaveLength(1)
    expect(payload.files[0].name).toBe('透析报告-2024-01-10.png')
    expect(payload.text).toContain('透析报告 张三 2024-01-10（已完成）')
    expect(payload.text).toContain('上机前 60.0kg，下机后 57.0kg，干体重 60.0kg')
    expect(payload.text).toContain('医生设定脱水 2.0L，计划脱水 0.0L，实际脱水 3.0L，回水 300ml')
    expect(payload.text).toContain('不良反应：无')
  })

  it('不支持分享图片（canShare 为 false）时退化为下载图片并明确提示，不静默只发文字（M8）', async () => {
    const shareSpy = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'share', { value: shareSpy, configurable: true })
    Object.defineProperty(navigator, 'canShare', { value: () => false, configurable: true })
    const w = await mountReport()
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await w.find('.van-nav-bar .van-icon-share-o').trigger('click')
    await flushPromises()

    expect(shareSpy).not.toHaveBeenCalled() // 不能再偷偷降级成纯文字分享
    expect(clickSpy).toHaveBeenCalledTimes(1) // 图片已下载
    expect(toastText()).toContain('不支持分享图片')
  })

  it('截图失败（html2canvas reject）时给出提示，不静默失败（M7）', async () => {
    html2canvasMock.mockRejectedValueOnce(new Error('canvas 不可用'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = await mountReport()

    await w.find('.van-nav-bar .van-icon-share-o').trigger('click')
    await flushPromises()

    expect(errSpy).toHaveBeenCalled()
    expect(mocks.showToast).toHaveBeenCalledWith('分享失败，请检查网络后重试')
  })

  it('用户取消系统分享（AbortError）时给中性提示，不当成失败', async () => {
    const abort = Object.assign(new Error('canceled'), { name: 'AbortError' })
    Object.defineProperty(navigator, 'share', { value: vi.fn(async () => Promise.reject(abort)), configurable: true })
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = await mountReport()

    await w.find('.van-nav-bar .van-icon-share-o').trigger('click')
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('已取消分享')
    expect(errSpy).toHaveBeenCalled()
  })

  it('骨架还没就绪时分享按钮不可点（点了也不会去截图）（M7）', async () => {
    stubReportData()
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: Blank },
        { path: '/report/:id', component: ReportView },
      ],
    })
    await router.push('/report/session-1')
    await router.isReady()
    const w = mount(Harness, { global: { plugins: [Vant, router] } })
    wrapper = w

    const icon = w.find('.van-nav-bar .van-icon-share-o')
    expect(icon.exists()).toBe(true)
    await icon.trigger('click')
    await flushPromises()

    expect(html2canvasMock).not.toHaveBeenCalled()
  })

  it('加载失败时分享按钮不可点（避免分享一屏错误）', async () => {
    vi.mocked(repository.getSession).mockRejectedValueOnce(new Error('Failed to fetch'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = await mountReport()

    await w.find('.van-nav-bar .van-icon-share-o').trigger('click')
    await flushPromises()

    expect(html2canvasMock).not.toHaveBeenCalled()
  })

  it('连点分享只截图一次（sharing 防重）（M7）', async () => {
    let release!: (v: unknown) => void
    html2canvasMock.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const w = await mountReport()
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const icon = w.find('.van-nav-bar .van-icon-share-o')
    await icon.trigger('click')
    await icon.trigger('click')
    expect(html2canvasMock).toHaveBeenCalledTimes(1)

    release({
      toDataURL: () => 'data:image/png;base64,AAAA',
      toBlob: (cb: (b: Blob) => void) => cb(new Blob(['fake'], { type: 'image/png' })),
    })
    await flushPromises()

    expect(html2canvasMock).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalledTimes(1) // 只下载了一次
  })
})

/**
 * 需求③（报告页）：血压增加心率。
 *
 * 守的缺陷：
 * - 心率 60~100 与血压 40~200 不同量级，混用一根轴会把血压曲线压扁成一条直线；
 * - 老记录没有心率，若用 0 补点，心率曲线会贴地，医生会以为患者心动过缓到 0；
 * - 明细里没有心率却显示「心率 — bpm」是噪声，报告是给医生看的。
 */
describe('ReportView · 血压心率（需求③）', () => {
  /** 取 BaseChart 收到的 option（echarts.init 在这份测试里被打桩，setOption 是唯一出口） */
  function chartOption(): Record<string, unknown> {
    const instance = echartsStub.init.mock.results.at(-1)?.value as { setOption: ReturnType<typeof vi.fn> } | undefined
    if (!instance) throw new Error('echarts 从未初始化：图表没渲染')
    const last = instance.setOption.mock.calls.at(-1)
    if (!last) throw new Error('setOption 从未被调用')
    return last[0] as Record<string, unknown>
  }

  const bpsWithPulse = [
    makeBp({ id: 'bp1', measuredAt: new Date('2024-01-10T08:00:00').getTime(), systolic: 130, diastolic: 80, pulse: 78 }),
    makeBp({ id: 'bp2', measuredAt: new Date('2024-01-10T09:00:00').getTime(), systolic: 150, diastolic: 95, pulse: 92 }),
  ]

  it('有心率时 legend 出现「心率」，yAxis 变成两根轴的数组', async () => {
    const w = await mountReport(defaultData({ bps: bpsWithPulse }))

    expect(w.findComponent(BaseChart).exists()).toBe(true)
    const option = chartOption()

    expect((option.legend as { data: string[] }).data).toEqual(['高压', '低压', '心率'])
    expect(Array.isArray(option.yAxis)).toBe(true)
    const yAxis = option.yAxis as { name: string }[]
    expect(yAxis.map((y) => y.name)).toEqual(['mmHg', 'bpm'])
    // 副轴不画横向网格线：两条轴的网格会叠成一片，血压曲线更难读
    expect((yAxis[1] as { splitLine?: { show: boolean } }).splitLine?.show).toBe(false)
  })

  it('心率序列挂在副轴上（yAxisIndex: 1），否则 60~100 会被 mmHg 的量级压平', async () => {
    await mountReport(defaultData({ bps: bpsWithPulse }))

    const series = chartOption().series as { name: string; yAxisIndex?: number }[]
    expect(series.map((s) => s.name)).toEqual(['高压', '低压', '心率'])
    expect(series[2].yAxisIndex).toBe(1)
    expect(series[0].yAxisIndex ?? 0).toBe(0)
    expect(series[1].yAxisIndex ?? 0).toBe(0)
  })

  /**
   * L-3（独立评审）：报告页的双轴 tooltip 也必须有单位，且心率是 bpm。
   *
   * 原实现是裸的 `tooltip: { trigger: 'axis' }` —— 双轴图里心率与血压数字并列、
   * 都不带单位，只能靠轴名区分；医生读报告时容易把 76 当成血压值。
   * 修法与趋势页共用 `utils/chartTooltip.ts` 的 `dualAxisTooltip`。
   */
  it('双轴 tooltip：心率按 bpm、血压按 mmHg（运行时断言，不是源码正则）', async () => {
    await mountReport(defaultData({ bps: bpsWithPulse }))

    const tooltip = chartOption().tooltip as { formatter?: (p: unknown) => string }
    expect(typeof tooltip.formatter).toBe('function')
    const out = tooltip.formatter!([
      { seriesName: '高压', value: 130, marker: '', axisValueLabel: '08:00' },
      { seriesName: '低压', value: 80, marker: '', axisValueLabel: '08:00' },
      { seriesName: '心率', value: 76, marker: '', axisValueLabel: '08:00' },
    ])
    expect(out).toContain('130 mmHg')
    expect(out).toContain('80 mmHg')
    expect(out).toContain('76 bpm')
    expect(out).not.toContain('76 mmHg')
  })

  it('没有心率的历史数据：只画两条线，yAxis 是单对象而不是数组', async () => {
    await mountReport(
      defaultData({
        bps: [
          makeBp({ id: 'bp1', measuredAt: new Date('2024-01-10T08:00:00').getTime(), pulse: null }),
          makeBp({ id: 'bp2', measuredAt: new Date('2024-01-10T09:00:00').getTime(), pulse: null }),
        ],
      }),
    )

    const option = chartOption()
    expect(Array.isArray(option.yAxis)).toBe(false)
    expect((option.yAxis as { name: string }).name).toBe('mmHg')
    expect((option.legend as { data: string[] }).data).toEqual(['高压', '低压'])
    expect((option.series as unknown[]).map((s) => (s as { name: string }).name)).toEqual(['高压', '低压'])
    // 网格右侧不留副轴的位置，图更宽
    expect((option.grid as { right: number }).right).toBe(20)
  })

  it('部分有部分没有心率：仍启用双轴，缺失点是 null（断点）而不是 0', async () => {
    await mountReport(
      defaultData({
        bps: [
          makeBp({ id: 'bp1', measuredAt: new Date('2024-01-10T08:00:00').getTime(), pulse: 78 }),
          makeBp({ id: 'bp2', measuredAt: new Date('2024-01-10T09:00:00').getTime(), pulse: null }),
          makeBp({ id: 'bp3', measuredAt: new Date('2024-01-10T10:00:00').getTime(), pulse: 90 }),
        ],
      }),
    )

    const option = chartOption()
    expect(Array.isArray(option.yAxis)).toBe(true)
    const pulseSeries = (option.series as { name: string; data: (number | null)[] }[]).find((s) => s.name === '心率')!
    // 断点必须是 null：填 0 会把曲线拽到地板上，看起来像心率掉到 0
    expect(pulseSeries.data).toEqual([78, null, 90])
    expect(pulseSeries.data[1]).not.toBe(0)
  })

  it('明细里有心率时显示「心率 N bpm」，没有时不显示占位', async () => {
    const w = await mountReport(
      defaultData({
        bps: [
          makeBp({ id: 'bp1', measuredAt: new Date('2024-01-10T08:00:00').getTime(), pulse: 78 }),
          makeBp({ id: 'bp2', measuredAt: new Date('2024-01-10T09:00:00').getTime(), pulse: null }),
        ],
      }),
    )

    const kvs = w.findAll('.kv').filter((k) => k.find('.k').text().includes(':'))
    expect(kvs[0].find('.pulse-inline').text()).toBe('· 心率 78 bpm')
    // 老记录：不渲染占位（不是「心率 — bpm」）
    expect(kvs[1].find('.pulse-inline').exists()).toBe(false)
    expect(kvs[1].text()).not.toContain('bpm')
  })

  it('报告写明轮椅及衣物重量的口径：已完成的用快照，进行中的标注「按当前档案计算」', async () => {
    const completed = await mountReport(
      defaultData({
        session: makeSession({
          id: 'session-1',
          date: '2024-01-10',
          status: 'completed',
          preWeightMeasured: 80,
          postWeightMeasured: 77,
          wheelchairWeightUsed: 13.4,
        }),
        patient: makePatient({ wheelchairWeight: 10 }),
      }),
    )
    const metas = completed.findAll('.report-meta').map((m) => m.text())
    const wheelchairMeta = metas.find((t) => t.includes('轮椅及衣物'))
    expect(wheelchairMeta).toContain('13.4kg') // 快照，不是档案的 10
    expect(wheelchairMeta).not.toContain('按当前档案计算')
  })

  it('进行中的报告：轮椅及衣物跟着当前档案，并标注「（进行中，按当前档案计算）」', async () => {
    const w = await mountReport(
      defaultData({
        session: makeSession({
          id: 'session-1',
          date: '2024-01-10',
          status: 'ongoing',
          preWeightMeasured: 80,
          postWeightMeasured: 77,
          wheelchairWeightUsed: 13.4,
        }),
        patient: makePatient({ wheelchairWeight: 10 }),
      }),
    )

    // 上机前实际按当前档案算：80 - 10 = 70.0
    expect(w.findAll('.rval')[0].text()).toBe('70.0kg')
    const wheelchairMeta = w.findAll('.report-meta').map((m) => m.text()).find((t) => t.includes('轮椅及衣物'))
    expect(wheelchairMeta).toContain('10.0kg')
    expect(wheelchairMeta).toContain('按当前档案计算')
  })

  it('分享文本带上心率和轮椅及衣物重量（家属发给医生的那段文字）', async () => {
    const shareSpy = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'share', { value: shareSpy, configurable: true })
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true })
    const w = await mountReport(defaultData({ bps: bpsWithPulse }))

    await w.find('.van-nav-bar .van-icon-share-o').trigger('click')
    await flushPromises()

    const text = (shareSpy.mock.calls[0][0] as { text: string }).text
    expect(text).toContain('血压：08:00 130/80（心率 78）；09:00 150/95（心率 92）')
    expect(text).toContain('轮椅及衣物')
  })

  it('分享文本里没有心率的血压不写「（心率 …）」（不能凭空补 0）', async () => {
    const shareSpy = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'share', { value: shareSpy, configurable: true })
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true })
    const w = await mountReport(
      defaultData({
        bps: [makeBp({ id: 'bp1', measuredAt: new Date('2024-01-10T08:00:00').getTime(), pulse: null })],
      }),
    )

    await w.find('.van-nav-bar .van-icon-share-o').trigger('click')
    await flushPromises()

    const text = (shareSpy.mock.calls[0][0] as { text: string }).text
    expect(text).toContain('08:00 130/80')
    expect(text).not.toContain('心率')
  })

  /**
   * 评审 L1：分享文本也要写清「轮椅及衣物重量」的口径。
   *
   * 面板上已经写了「进行中，按当前档案计算」/「本次记录当时的值」，但分享文本是
   * 家属直接发给医生的那段字 —— 只发数字不说口径，医生无法判断这个重量是这次透析
   * 当时的、还是后来改档案改过的，进而无法复核实际体重。
   */
  it('分享文本标明口径：已完成的记录写「本次记录当时的值」', async () => {
    const shareSpy = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'share', { value: shareSpy, configurable: true })
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true })
    const w = await mountReport(
      defaultData({
        session: makeSession({
          id: 'session-1',
          status: 'completed',
          preWeightMeasured: 80,
          postWeightMeasured: 77,
          wheelchairWeightUsed: 13.4,
        }),
        patient: makePatient({ wheelchairWeight: 10 }),
      }),
    )

    await w.find('.van-nav-bar .van-icon-share-o').trigger('click')
    await flushPromises()

    const text = (shareSpy.mock.calls[0][0] as { text: string }).text
    // 快照值 13.4，不是档案的 10
    expect(text).toContain('轮椅及衣物 13.4kg')
    expect(text).toContain('本次记录当时的值')
    expect(text).not.toContain('按当前档案计算')
  })

  it('分享文本标明口径：进行中的记录写「进行中，按当前档案计算」', async () => {
    const shareSpy = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'share', { value: shareSpy, configurable: true })
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true })
    const w = await mountReport(
      defaultData({
        session: makeSession({
          id: 'session-1',
          status: 'ongoing',
          preWeightMeasured: 80,
          postWeightMeasured: 77,
          wheelchairWeightUsed: 13.4,
        }),
        patient: makePatient({ wheelchairWeight: 10 }),
      }),
    )

    await w.find('.van-nav-bar .van-icon-share-o').trigger('click')
    await flushPromises()

    const text = (shareSpy.mock.calls[0][0] as { text: string }).text
    expect(text).toContain('轮椅及衣物 10.0kg')
    expect(text).toContain('按当前档案计算')
  })
})

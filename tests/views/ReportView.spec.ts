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

vi.mock('../../src/stores/patient', () => ({ currentPatientId: { value: 'patient-default' } }))

const Blank = defineComponent({ render: () => h('div') })
const Harness = defineComponent({ render: () => h(RouterView) })

let wrapper: VueWrapper | null = null
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

/**
 * TrendView（趋势分析页）组件测试
 *
 * 该页没有「统计摘要」文案，它把统计结果全部喂给 ECharts 的 option（近 30 次、
 * 按日期升序、实际体重由 computeSession 推导、Y 轴自适应）。因此这里把 BaseChart
 * 换成「把 option 打印成 JSON」的桩，直接对图表数据做断言 —— 这比截图比对稳定得多。
 *
 * jsdom 限制说明：
 * - echarts 无法在 jsdom 里真实绘制，本文件把 echarts 模块整体桩掉（BaseChart 也被替换）；
 * - Vant Tabs 默认懒渲染，未激活的页签不会渲染内容，切页签即“按需渲染”，
 *   这也正是「切换只影响展示、不写库」的验证点。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper, type DOMWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import Vant from 'vant'
import TrendView from '../../src/views/TrendView.vue'
import { repository } from '../../src/repo'
import { cacheVersion } from '../../src/lib/cloudCache'
import { makeDryWeight, makeSession, makeBp, makeBg } from '../helpers/factories'

vi.mock('echarts', () => ({
  init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })),
}))

vi.mock('../../src/repo', () => ({
  repository: {
    listDryWeights: vi.fn(),
    listSessions: vi.fn(),
    listBloodPressures: vi.fn(),
    listBloodGlucoses: vi.fn(),
    // 趋势页是纯展示页：下面这些写方法存在只是为了断言「一次都没被调用」
    saveSession: vi.fn(),
    savePatient: vi.fn(),
    saveDryWeight: vi.fn(),
    saveBloodPressure: vi.fn(),
    saveBloodGlucose: vi.fn(),
  },
}))

vi.mock('../../src/stores/patient', () => ({ currentPatientId: { value: 'patient-default' } }))

/** 把图表 option 打印出来，便于对系列数据做断言 */
const BaseChartStub = defineComponent({
  name: 'BaseChart',
  props: { option: { type: Object, required: true } },
  setup(props) {
    return () => h('pre', { class: 'chart-option' }, JSON.stringify(props.option))
  },
})

let wrapper: VueWrapper | null = null

interface TrendData {
  dryWeights?: ReturnType<typeof makeDryWeight>[]
  sessions?: ReturnType<typeof makeSession>[]
  bpsBySession?: Record<string, ReturnType<typeof makeBp>[]>
  bgsBySession?: Record<string, ReturnType<typeof makeBg>[]>
}

function stubTrendData(data: TrendData = {}) {
  vi.mocked(repository.listDryWeights).mockResolvedValue(data.dryWeights ?? [])
  vi.mocked(repository.listSessions).mockResolvedValue(data.sessions ?? [])
  vi.mocked(repository.listBloodPressures).mockImplementation(async (sessionId: string) =>
    data.bpsBySession?.[sessionId] ?? [],
  )
  vi.mocked(repository.listBloodGlucoses).mockImplementation(async (sessionId: string) =>
    data.bgsBySession?.[sessionId] ?? [],
  )
}

async function mountTrend(data: TrendData = {}, flush = true): Promise<VueWrapper> {
  stubTrendData(data)
  wrapper = mount(TrendView, {
    global: { plugins: [Vant], stubs: { BaseChart: BaseChartStub } },
  })
  if (flush) await flushPromises()
  return wrapper
}

/** 按系列名从已渲染的图表里挑出对应的一张（体重/血压/血糖三张图的系列名互不重叠） */
function optionBySeries(w: VueWrapper, seriesName: string): any {
  const charts = w.findAll('.chart-option').map((n) => JSON.parse(n.text()))
  const found = charts.find((o) => o.series?.some((s: { name: string }) => s.name === seriesName))
  if (!found) throw new Error(`未找到含 series「${seriesName}」的图表`)
  return found
}

async function switchTab(w: VueWrapper, title: string): Promise<void> {
  const tab = w.findAll('.van-tab').find((t) => t.text() === title)
  if (!tab) throw new Error(`未找到页签「${title}」`)
  await tab.trigger('click')
  await flushPromises()
}

function buttonByText(scope: VueWrapper | DOMWrapper<Node>, text: string): DOMWrapper<HTMLButtonElement> {
  const btn = scope.findAll('button').find((b) => b.text().includes(text))
  if (!btn) throw new Error(`未找到文案包含「${text}」的按钮`)
  return btn as DOMWrapper<HTMLButtonElement>
}

beforeEach(() => {
  for (const fn of Object.values(repository) as unknown as ReturnType<typeof vi.fn>[]) {
    fn.mockReset()
  }
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('TrendView · 加载与空状态', () => {
  it('加载中显示骨架，数据到位后显示图表', async () => {
    const w = await mountTrend({ sessions: [] }, false)
    expect(w.findComponent({ name: 'VanSkeleton' }).exists()).toBe(true)

    await flushPromises()
    expect(w.findComponent({ name: 'VanSkeleton' }).exists()).toBe(false)
    expect(w.text()).toContain('体重趋势（近 30 次）')
  })

  it('没有任何记录时，体重页签显示「暂无数据」且不渲染图表', async () => {
    const w = await mountTrend({ sessions: [] })

    expect(w.find('.chart-option').exists()).toBe(false)
    expect(w.text()).toContain('暂无数据')
  })

  it('没有血压/血糖时，对应页签分别给出空状态', async () => {
    const w = await mountTrend({ sessions: [makeSession({ id: 's1', date: '2024-01-05' })] })

    await switchTab(w, '血压')
    expect(w.text()).toContain('暂无血压数据')
    expect(w.findAll('.chart-option')).toHaveLength(1) // 只有体重那张

    await switchTab(w, '血糖')
    expect(w.text()).toContain('暂无血糖数据')
    expect(w.findAll('.chart-option')).toHaveLength(1)
  })
})

describe('TrendView · 体重趋势数据', () => {
  it('按日期升序排列（与仓储返回顺序无关），并推算出上机前/下机后/干体重三条线', async () => {
    const w = await mountTrend({
      // 故意倒序喂入
      sessions: [
        makeSession({ id: 's2', date: '2024-02-06', preWeightMeasured: 81, postWeightMeasured: 78, wheelchairWeightUsed: 20 }),
        makeSession({ id: 's1', date: '2024-01-05', preWeightMeasured: 80, postWeightMeasured: 77, wheelchairWeightUsed: 20 }),
      ],
      dryWeights: [
        makeDryWeight({ id: 'd1', value: 60, effectiveDate: '2024-01-01' }),
        makeDryWeight({ id: 'd2', value: 59, effectiveDate: '2024-02-01' }),
      ],
    })

    const opt = optionBySeries(w, '上机前')
    expect(opt.xAxis.data).toEqual(['01-05', '02-06'])
    expect(opt.series[0].data).toEqual([60, 61]) // 80-20 / 81-20
    expect(opt.series[1].data).toEqual([57, 58]) // 77-20 / 78-20
    expect(opt.series[2].data).toEqual([60, 59]) // 按各次日期取当次有效干体重
  })

  it('只取最近 30 次', async () => {
    const sessions = Array.from({ length: 31 }, (_, i) =>
      makeSession({
        id: `s${i}`,
        date: `2024-01-${String(i + 1).padStart(2, '0')}`,
        preWeightMeasured: 80,
        wheelchairWeightUsed: 20,
      }),
    )
    const w = await mountTrend({ sessions })

    const opt = optionBySeries(w, '上机前')
    expect(opt.xAxis.data).toHaveLength(30)
    expect(opt.xAxis.data[0]).toBe('01-02') // 最早的那次被挤掉
    expect(opt.xAxis.data.at(-1)).toBe('01-31')
  })

  it('数据波动很小时 Y 轴改用固定视窗（避免把 0.5kg 放大成剧烈起伏）', async () => {
    const w = await mountTrend({
      sessions: [makeSession({ id: 's1', date: '2024-01-05', preWeightMeasured: 80.5, postWeightMeasured: null })],
      dryWeights: [makeDryWeight({ id: 'd1', value: 60, effectiveDate: '2024-01-01' })],
    })

    // 数值只有 60.5 与 60：hi-lo=0.5 < 3 → mid=60 → 视窗 [58, 62]，刻度间隔 1
    const opt = optionBySeries(w, '上机前')
    expect(opt.yAxis).toMatchObject({ type: 'value', name: 'kg', scale: true, min: 58, max: 62, interval: 1 })
  })

  it('没有干体重记录时，计划线全是 null 而不是 0（不能把缺失当 0 画）', async () => {
    const w = await mountTrend({
      sessions: [makeSession({ id: 's1', date: '2024-01-05', preWeightMeasured: 80, wheelchairWeightUsed: 20 })],
      dryWeights: [],
    })

    const opt = optionBySeries(w, '干体重')
    expect(opt.series[2].data).toEqual([null])
    expect(opt.series[0].data).toEqual([60])
  })

  it('未测上机前体重的记录在折线上是 null（断点），不会被算成 0', async () => {
    const w = await mountTrend({
      sessions: [makeSession({ id: 's1', date: '2024-01-05', preWeightMeasured: null, postWeightMeasured: 77 })],
      dryWeights: [],
    })

    const opt = optionBySeries(w, '上机前')
    expect(opt.series[0].data).toEqual([null])
    expect(opt.series[1].data).toEqual([57])
  })
})

describe('TrendView · 血压/血糖趋势数据', () => {
  it('血压按测量时间升序汇总，X 轴为「月-日 时:分」', async () => {
    const w = await mountTrend({
      sessions: [
        makeSession({ id: 's1', date: '2024-01-05' }),
        makeSession({ id: 's2', date: '2024-02-06' }),
      ],
      bpsBySession: {
        // s1 故意倒序给出，验证组件按 measuredAt 排序
        s1: [
          makeBp({ id: 'bp2', measuredAt: new Date('2024-01-05T10:00:00').getTime(), systolic: 150, diastolic: 95 }),
          makeBp({ id: 'bp1', measuredAt: new Date('2024-01-05T08:00:00').getTime(), systolic: 130, diastolic: 80 }),
        ],
        s2: [makeBp({ id: 'bp3', measuredAt: new Date('2024-02-06T09:00:00').getTime(), systolic: 140, diastolic: 90 })],
      },
    })

    await switchTab(w, '血压')

    const opt = optionBySeries(w, '高压')
    expect(opt.xAxis.data).toEqual(['01-05 08:00', '01-05 10:00', '02-06 09:00'])
    expect(opt.series[0].data).toEqual([130, 150, 140])
    expect(opt.series[1].data).toEqual([80, 95, 90])
    // 每条记录各拉一次血压，并且是并行发出的
    expect(repository.listBloodPressures).toHaveBeenCalledTimes(2)
  })

  it('血糖趋势同样按时间升序汇总', async () => {
    const w = await mountTrend({
      sessions: [makeSession({ id: 's1', date: '2024-01-05' })],
      bgsBySession: {
        s1: [
          makeBg({ id: 'bg1', measuredAt: new Date('2024-01-05T08:00:00').getTime(), value: 6.5 }),
          makeBg({ id: 'bg2', measuredAt: new Date('2024-01-05T12:00:00').getTime(), value: 11.8 }),
        ],
      },
    })

    await switchTab(w, '血糖')

    const opt = optionBySeries(w, '血糖')
    expect(opt.xAxis.data).toEqual(['01-05 08:00', '01-05 12:00'])
    expect(opt.series[0].data).toEqual([6.5, 11.8])
  })

  it('血压数值跨度不小（收缩压/舒张压同轴），Y 轴不锁死、交给数值轴自适应', async () => {
    const w = await mountTrend({
      sessions: [makeSession({ id: 's1', date: '2024-01-05' })],
      bpsBySession: {
        s1: [makeBp({ id: 'bp1', measuredAt: new Date('2024-01-05T08:00:00').getTime(), systolic: 130, diastolic: 82 })],
      },
    })

    await switchTab(w, '血压')

    // 数值 130/82：hi-lo=48 ≥ 20 → 不设上下限
    const opt = optionBySeries(w, '高压')
    expect(opt.yAxis.min).toBeUndefined()
    expect(opt.yAxis.max).toBeUndefined()
    expect(opt.yAxis.name).toBe('mmHg')
  })
})

describe('TrendView · 切换只影响展示', () => {
  it('切换页签不会触发任何写库操作，也不会重新拉全量数据', async () => {
    const w = await mountTrend({
      sessions: [makeSession({ id: 's1', date: '2024-01-05', preWeightMeasured: 80 })],
      dryWeights: [makeDryWeight({ id: 'd1', value: 60, effectiveDate: '2024-01-01' })],
      bpsBySession: { s1: [makeBp({ id: 'bp1' }) ] },
      bgsBySession: { s1: [makeBg({ id: 'bg1' })] },
    })

    expect(repository.listSessions).toHaveBeenCalledTimes(1)

    await switchTab(w, '血压')
    await switchTab(w, '血糖')
    await switchTab(w, '体重')

    expect(repository.listSessions).toHaveBeenCalledTimes(1)
    expect(repository.listDryWeights).toHaveBeenCalledTimes(1)
    expect(repository.saveSession).not.toHaveBeenCalled()
    expect(repository.savePatient).not.toHaveBeenCalled()
    expect(repository.saveDryWeight).not.toHaveBeenCalled()
    expect(repository.saveBloodPressure).not.toHaveBeenCalled()
    expect(repository.saveBloodGlucose).not.toHaveBeenCalled()
  })

  it('cacheVersion 变化（云端后台刷新写回缓存）会重新加载', async () => {
    await mountTrend({ sessions: [] })
    expect(repository.listSessions).toHaveBeenCalledTimes(1)

    vi.mocked(repository.listSessions).mockClear()
    cacheVersion.value += 1
    await flushPromises()

    expect(repository.listSessions).toHaveBeenCalledTimes(1)
    expect(repository.listSessions).toHaveBeenCalledWith('patient-default')
  })
})

describe('TrendView · 加载失败与「无数据」要分开（M9）', () => {
  it('主数据加载失败：显示失败态与重试按钮，不显示「暂无数据」，也不留永久骨架', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = await mountTrend({ sessions: [] })
    // 上面已经成功加载一次，这里让下一次（重试路径）失败来验证错误态
    vi.mocked(repository.listSessions).mockRejectedValueOnce(new Error('查询失败（sessions）：Failed to fetch'))
    cacheVersion.value += 1
    await flushPromises()

    expect(w.findComponent({ name: 'VanSkeleton' }).exists()).toBe(false)
    expect(w.text()).toContain('趋势数据加载失败')
    expect(w.text()).not.toContain('暂无数据')
    expect(buttonByText(w, '重试').exists()).toBe(true)
    expect(errSpy).toHaveBeenCalled()
  })

  it('首次加载就失败时也不崩：错误态 + 重试，点重试后正常出图', async () => {
    vi.mocked(repository.listSessions).mockRejectedValueOnce(new Error('查询失败（sessions）：Failed to fetch'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = await mountTrend({
      sessions: [makeSession({ id: 's1', date: '2024-01-05', preWeightMeasured: 80, wheelchairWeightUsed: 20 })],
    })

    expect(w.text()).toContain('趋势数据加载失败')
    expect(w.find('.chart-option').exists()).toBe(false)

    await buttonByText(w, '重试').trigger('click')
    await flushPromises()

    expect(w.text()).not.toContain('趋势数据加载失败')
    expect(optionBySeries(w, '上机前').xAxis.data).toEqual(['01-05'])
    expect(errSpy).toHaveBeenCalled()
  })

  it('血压趋势加载失败：对应页签显示失败态与重试，而不是「暂无血压数据」', async () => {
    vi.mocked(repository.listBloodPressures).mockRejectedValueOnce(new Error('查询失败（血压）：Failed to fetch'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = await mountTrend({ sessions: [makeSession({ id: 's1', date: '2024-01-05' })] })

    await switchTab(w, '血压')

    expect(w.text()).toContain('血压数据加载失败')
    expect(w.text()).not.toContain('暂无血压数据')
    expect(buttonByText(w, '重试').exists()).toBe(true)
    expect(errSpy).toHaveBeenCalled()
  })

  it('血糖趋势加载失败：对应页签显示失败态；体重页签不受影响', async () => {
    vi.mocked(repository.listBloodGlucoses).mockRejectedValueOnce(new Error('查询失败（血糖）：Failed to fetch'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = await mountTrend({
      sessions: [makeSession({ id: 's1', date: '2024-01-05', preWeightMeasured: 80, wheelchairWeightUsed: 20 })],
    })

    // 体重页签正常出图（主数据没失败）
    expect(optionBySeries(w, '上机前').xAxis.data).toEqual(['01-05'])

    await switchTab(w, '血糖')
    expect(w.text()).toContain('血糖数据加载失败')
    expect(w.text()).not.toContain('暂无血糖数据')
  })

  it('确实没有数据时仍然是「暂无数据」，不要误报成加载失败', async () => {
    const w = await mountTrend({ sessions: [] })

    expect(w.text()).toContain('暂无数据')
    expect(w.text()).not.toContain('加载失败')
  })

  it('一次打开仍是「每条记录各一次」并行请求（批量接口待做：需数据层支持按病人一次拉回子表）', async () => {
    const sessions = Array.from({ length: 30 }, (_, i) =>
      makeSession({ id: `s${i}`, date: `2024-01-${String(i + 1).padStart(2, '0')}` }),
    )
    await mountTrend({ sessions })

    // 血压 + 血糖各 30 次：目前没有批量查询接口，只能逐条并行
    expect(repository.listBloodPressures).toHaveBeenCalledTimes(30)
    expect(repository.listBloodGlucoses).toHaveBeenCalledTimes(30)
  })
})

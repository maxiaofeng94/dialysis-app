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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount, flushPromises, type VueWrapper, type DOMWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import Vant from 'vant'
import TrendView from '../../src/views/TrendView.vue'
import { repository } from '../../src/repo'
import { cacheVersion } from '../../src/lib/cloudCache'
import { makeDryWeight, makeSession, makeBp, makeBg, makePatient } from '../helpers/factories'

vi.mock('echarts', () => ({
  init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })),
}))

vi.mock('../../src/repo', () => ({
  repository: {
    // 趋势页要读病人档案：进行中的记录按「当前档案」的轮椅及衣物重量 / 回水量计算
    getPatient: vi.fn(),
    listDryWeights: vi.fn(),
    listSessions: vi.fn(),
    // 趋势页只用批量接口：一次请求取回最近 30 条记录的血压 / 血糖
    listBloodPressuresMany: vi.fn(),
    listBloodGlucosesMany: vi.fn(),
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

/**
 * 把图表 option 打印出来，便于对系列数据做断言。
 *
 * ⚠️ 同时把**原始 option 对象**（含函数属性）存进 `capturedOptions`：
 * `JSON.stringify` 会把 `formatter` / `valueFormatter` 这类函数直接丢掉，
 * 于是「tooltip 里心率单位是不是 bpm」这种运行时行为**无法**用序列化后的文本断言 ——
 * 之前的用例就退化成对源码做正则（断言「代码里写了 seriesName === '心率'」），
 * 属于假绿：`valueFormatter` 的第二个参数其实是 dataIndex（数字），运行时永远输出 mmHg。
 */
const capturedOptions: any[] = []

const BaseChartStub = defineComponent({
  name: 'BaseChart',
  props: { option: { type: Object, required: true } },
  setup(props) {
    return () => {
      capturedOptions.push(props.option)
      return h('pre', { class: 'chart-option' }, JSON.stringify(props.option))
    }
  },
})

let wrapper: VueWrapper | null = null

interface TrendData {
  /** 病人档案：进行中的记录按它的轮椅及衣物重量计算（不传就用 factories 默认的 20kg） */
  patient?: ReturnType<typeof makePatient> | null
  dryWeights?: ReturnType<typeof makeDryWeight>[]
  sessions?: ReturnType<typeof makeSession>[]
  bpsBySession?: Record<string, ReturnType<typeof makeBp>[]>
  bgsBySession?: Record<string, ReturnType<typeof makeBg>[]>
}

function stubTrendData(data: TrendData = {}) {
  // 默认给一份 20kg 的档案：用例里的 session 也按 20kg 建，两者一致时不改变原有断言
  vi.mocked(repository.getPatient).mockResolvedValue(
    data.patient === null ? undefined : (data.patient ?? makePatient({ wheelchairWeight: 20, rinseBackVolume: 300 })),
  )
  vi.mocked(repository.listDryWeights).mockResolvedValue(data.dryWeights ?? [])
  vi.mocked(repository.listSessions).mockResolvedValue(data.sessions ?? [])
  // 批量接口按传入的 session 顺序把各条记录的数据拍平，并补上 sessionId 归属
  //（真实数据层返回的每条都带 sessionId；用例里只写 bpsBySession 分组即可）
  vi.mocked(repository.listBloodPressuresMany).mockImplementation(async (sessionIds: string[]) =>
    sessionIds.flatMap((id) => (data.bpsBySession?.[id] ?? []).map((bp) => ({ ...bp, sessionId: id }))),
  )
  vi.mocked(repository.listBloodGlucosesMany).mockImplementation(async (sessionIds: string[]) =>
    sessionIds.flatMap((id) => (data.bgsBySession?.[id] ?? []).map((bg) => ({ ...bg, sessionId: id }))),
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

/** 去掉 JS / 行注释：源码级断言必须剥注释，否则把调用写进注释里也能骗过守卫 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

beforeEach(() => {
  for (const fn of Object.values(repository) as unknown as ReturnType<typeof vi.fn>[]) {
    fn.mockReset()
  }
  capturedOptions.length = 0 // 跨用例累积会让「取最后一次」取到别人的 option
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
    // 一次批量请求拿回两条记录的血压，而不是每条记录各发一次
    expect(repository.listBloodPressuresMany).toHaveBeenCalledTimes(1)
    expect(repository.listBloodPressuresMany).toHaveBeenCalledWith(['s1', 's2'])
    expect(repository.listBloodPressures).not.toHaveBeenCalled()
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
    vi.mocked(repository.listBloodPressuresMany).mockRejectedValueOnce(new Error('查询失败（血压）：Failed to fetch'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = await mountTrend({ sessions: [makeSession({ id: 's1', date: '2024-01-05' })] })

    await switchTab(w, '血压')

    expect(w.text()).toContain('血压数据加载失败')
    expect(w.text()).not.toContain('暂无血压数据')
    expect(buttonByText(w, '重试').exists()).toBe(true)
    expect(errSpy).toHaveBeenCalled()
  })

  it('血糖趋势加载失败：对应页签显示失败态；体重页签不受影响', async () => {
    vi.mocked(repository.listBloodGlucosesMany).mockRejectedValueOnce(new Error('查询失败（血糖）：Failed to fetch'))
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

  it('一次打开只有两次网络请求：血压 / 血糖各一次批量拉取（30 条记录不再逐条打 60 次）', async () => {
    const sessions = Array.from({ length: 30 }, (_, i) =>
      makeSession({ id: `s${i}`, date: `2024-01-${String(i + 1).padStart(2, '0')}` }),
    )
    await mountTrend({ sessions })

    const ids = sessions.map((s) => s.id)
    // 用户反馈的「手机发烫、耗电激增」正是这里：以前是 30 + 30 = 60 次请求，
    // 且每个缓存 key 各自后台刷新，弱网下会自激成停不下来的请求风暴。
    expect(repository.listBloodPressuresMany).toHaveBeenCalledTimes(1)
    expect(repository.listBloodGlucosesMany).toHaveBeenCalledTimes(1)
    expect(repository.listBloodPressuresMany).toHaveBeenCalledWith(ids)
    expect(repository.listBloodGlucosesMany).toHaveBeenCalledWith(ids)
    // 单条接口一次都不该被调用
    expect(repository.listBloodPressures).not.toHaveBeenCalled()
    expect(repository.listBloodGlucoses).not.toHaveBeenCalled()
  })
})

/**
 * 需求①：趋势页的体重曲线同样要「进行中按当前档案、已完成用快照」。
 * ⚠️ 这一组的存在理由：`stubTrendData` 的默认档案是 20kg，而 `makeSession` 的默认快照也是
 * `wheelchairWeightUsed: 20` —— 两者相等时，**传不传 patient 根本看不出来**。
 * 这里必须刻意让两者不等，否则就是假绿（评审指出过这一点）。
 */
describe('TrendView · 体重曲线按记录状态取轮椅及衣物重量（需求①）', () => {
  it('进行中的记录用当前档案：档案 25kg vs 快照 20kg，曲线取 25', async () => {
    const w = await mountTrend({
      patient: makePatient({ wheelchairWeight: 25, rinseBackVolume: 300 }),
      sessions: [
        makeSession({ id: 's1', date: '2024-01-05', preWeightMeasured: 85, status: 'ongoing', wheelchairWeightUsed: 20 }),
      ],
    })

    const opt = optionBySeries(w, '上机前')
    // 85 − 25（当前档案）= 60；若错误地用了快照 20 会得到 65
    expect(opt.series.find((s: { name: string }) => s.name === '上机前').data).toEqual([60])
  })

  it('已完成的记录用快照：档案改成 25kg 也不影响（历史不可变）', async () => {
    const w = await mountTrend({
      patient: makePatient({ wheelchairWeight: 25, rinseBackVolume: 300 }),
      sessions: [
        makeSession({ id: 's1', date: '2024-01-05', preWeightMeasured: 85, status: 'completed', wheelchairWeightUsed: 20 }),
      ],
    })

    const opt = optionBySeries(w, '上机前')
    // 85 − 20（当时的快照）= 65，绝不能跟着档案变成 60
    expect(opt.series.find((s: { name: string }) => s.name === '上机前').data).toEqual([65])
  })

  it('档案读不到（离线且无缓存）：回退快照，不能算成 0（否则体重凭空多一辆轮椅）', async () => {
    const w = await mountTrend({
      patient: null,
      sessions: [
        makeSession({ id: 's1', date: '2024-01-05', preWeightMeasured: 85, status: 'ongoing', wheelchairWeightUsed: 20 }),
      ],
    })

    const opt = optionBySeries(w, '上机前')
    expect(opt.series.find((s: { name: string }) => s.name === '上机前').data).toEqual([65])
  })
})

/**
 * 需求③：趋势页血压图的心率副轴。
 *
 * 原来零覆盖 —— 把 `pulse: bp.pulse ?? null` 改成 `pulse: null`、
 * 把 `hasBpPulse` 改成 `computed(() => false)`，19 条用例全部通过。
 */
describe('TrendView · 血压图心率副轴（需求③）', () => {
  const sess = makeSession({ id: 's1', date: '2024-01-05' })

  it('有心率：legend 出现「心率」，yAxis 变成双轴（mmHg / bpm）', async () => {
    const w = await mountTrend({
      sessions: [sess],
      bpsBySession: { s1: [makeBp({ id: 'bp1', sessionId: 's1', systolic: 130, diastolic: 80, pulse: 76 })] },
    })

    await switchTab(w, '血压')
    const opt = optionBySeries(w, '心率')

    expect(opt.legend.data).toEqual(['高压', '低压', '心率'])
    expect(Array.isArray(opt.yAxis)).toBe(true)
    expect(opt.yAxis).toHaveLength(2)
    expect(opt.yAxis[0].name).toBe('mmHg')
    expect(opt.yAxis[1].name).toBe('bpm')
    // 心率必须走副轴，否则和血压挤一根轴会把血压压平
    const pulseSeries = opt.series.find((s: { name: string }) => s.name === '心率')
    expect(pulseSeries.yAxisIndex).toBe(1)
    expect(pulseSeries.data).toEqual([76])
    // 副轴不画网格线（否则两层网格叠在一起很脏）。autoValueAxis 不额外返回 splitLine，
    // 这里显式钉住约定：如果将来给副轴加了网格线，这条会红。
    expect(opt.yAxis[1].splitLine ?? { show: false }).toEqual({ show: false })
  })

  /**
   * M-1（独立评审）：双轴 tooltip 的单位必须**按 series 分别**输出。
   *
   * 原实现用 `valueFormatter: (v, params) => params?.seriesName === '心率' ? 'bpm' : 'mmHg'`，
   * 但 ECharts 的签名是 `valueFormatter(value, dataIndex: number)` —— 第二个参数是**数字下标**，
   * `params.seriesName` 恒 undefined → 心率被标成「76 mmHg」。护士把心率当血压读，量纲错误。
   *
   * 为什么原用例抓不住：`BaseChartStub` 用 `JSON.stringify` 序列化 option，函数属性被丢弃，
   * 断言只能退化成对源码做正则。这条用例直接调用 `option.tooltip.formatter`，断言**运行时输出**。
   */
  it('双轴 tooltip：心率按 bpm、血压按 mmHg（直接调用 formatter 断言运行时输出）', async () => {
    const w = await mountTrend({
      sessions: [sess],
      bpsBySession: { s1: [makeBp({ id: 'bp1', sessionId: 's1', systolic: 130, diastolic: 80, pulse: 76 })] },
    })

    await switchTab(w, '血压')
    // 取最后一次渲染的血压图 option（含真实函数属性）
    const opt = capturedOptions
      .filter((o) => o?.series?.some((s: { name: string }) => s.name === '心率'))
      .pop()
    expect(opt).toBeTruthy()
    expect(typeof opt.tooltip.formatter).toBe('function')

    // 模拟 ECharts 在某个 x 点上给到的 params 数组（每项带 seriesName / value / marker）
    const out = opt.tooltip.formatter([
      { seriesName: '高压', value: 130, marker: '', axisValueLabel: '01-05 08:00' },
      { seriesName: '低压', value: 80, marker: '', axisValueLabel: '01-05 08:00' },
      { seriesName: '心率', value: 76, marker: '', axisValueLabel: '01-05 08:00' },
    ]) as string

    expect(out).toContain('130 mmHg')
    expect(out).toContain('80 mmHg')
    expect(out).toContain('76 bpm') // 关键：心率必须是 bpm，不能是 mmHg
    expect(out).not.toContain('76 mmHg')
    expect(out).toContain('01-05 08:00') // 时间标题
    void w
  })

  it('没有心率（历史数据）：只画两条线，yAxis 保持单轴（不能多出一根空轴）', async () => {
    const w = await mountTrend({
      sessions: [sess],
      bpsBySession: { s1: [makeBp({ id: 'bp1', sessionId: 's1', pulse: null })] },
    })

    await switchTab(w, '血压')
    const opt = optionBySeries(w, '高压')

    expect(opt.legend.data).toEqual(['高压', '低压'])
    expect(Array.isArray(opt.yAxis)).toBe(false)
    expect(opt.yAxis.name).toBe('mmHg')
    expect(opt.series.map((s: { name: string }) => s.name)).toEqual(['高压', '低压'])
    // 没有副轴时右侧留白要收回去，否则图表右边会空一大块
    expect(opt.grid.right).toBe(20)
  })

  it('部分点有心率：没记心率的点必须是 null 断点（不能填 0 把曲线拽到地板）', async () => {
    const w = await mountTrend({
      sessions: [sess],
      bpsBySession: {
        s1: [
          makeBp({ id: 'bp1', sessionId: 's1', measuredAt: 1_700_000_100_000, pulse: 76 }),
          makeBp({ id: 'bp2', sessionId: 's1', measuredAt: 1_700_000_200_000, pulse: null }),
          makeBp({ id: 'bp3', sessionId: 's1', measuredAt: 1_700_000_300_000, pulse: 82 }),
        ],
      },
    })

    await switchTab(w, '血压')
    const opt = optionBySeries(w, '心率')
    const pulseSeries = opt.series.find((s: { name: string }) => s.name === '心率')

    expect(pulseSeries.data).toEqual([76, null, 82])
  })

  /**
   * ⚠️ 这条用例原本是**源码正则断言**（`expect(src).toMatch(/seriesName === '心率'/)`），
   * 属于典型假绿：它只证明「代码里写了这两个字符串」，不证明运行时真的输出 bpm ——
   * 而实际实现用的是 `valueFormatter`（第二参是 dataIndex，拿不到 seriesName），
   * 心率一直显示成「76 mmHg」，用例照样绿。
   *
   * 现在改成上面的**运行时用例**（直接调用 `option.tooltip.formatter` 断言输出），
   * 逻辑也抽到了 `src/utils/chartTooltip.ts` 供趋势页 / 报告页共用。
   * 这里只留一条轻量护栏：两页都必须用共用的 `dualAxisTooltip`，别再各写一份走散。
   */
  it('趋势页与报告页共用同一个双轴 tooltip 实现（防止两处各写一份走散）', () => {
    for (const file of ['src/views/TrendView.vue', 'src/views/ReportView.vue']) {
      const src = stripComments(readFileSync(resolve(process.cwd(), file), 'utf8'))
      expect(src, `${file} 必须用共用的 dualAxisTooltip`).toMatch(/dualAxisTooltip/)
      // 不许再自己拼 bpm / mmHg 的单位判断
      expect(src, `${file} 不应重复实现双轴单位判断`).not.toMatch(/seriesName === '心率'/)
    }
  })
})

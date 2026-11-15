/**
 * BaseChart 组件测试（图表生命周期）
 *
 * jsdom 里没有真实 canvas，echarts 初始化必然失败，所以整体替换为可断言的桩，
 * 断言的是「什么时候 init / setOption / resize / dispose」这一层逻辑，
 * 而不是 echarts 的绘图结果（那属于 echarts 自身职责）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import BaseChart from '../../src/components/BaseChart.vue'

// vi.hoisted：mock 工厂会被提升到 import 之前，桩必须在这里造
const echartsStub = vi.hoisted(() => {
  const chart = { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() }
  return { chart, init: vi.fn(() => chart) }
})

vi.mock('echarts', () => ({ init: echartsStub.init }))

describe('BaseChart', () => {
  beforeEach(() => {
    echartsStub.init.mockClear()
    echartsStub.chart.setOption.mockClear()
    echartsStub.chart.resize.mockClear()
    echartsStub.chart.dispose.mockClear()
  })

  it('挂载时用容器初始化一次 echarts，并把 option 交给 setOption', () => {
    const option = { series: [{ type: 'line', data: [1, 2, 3] }] }
    const wrapper = mount(BaseChart, { props: { option } })

    expect(echartsStub.init).toHaveBeenCalledTimes(1)
    // 第一个参数是组件根节点（真实 DOM 元素）
    expect(echartsStub.init.mock.calls[0][0]).toBe(wrapper.element)
    expect(echartsStub.chart.setOption).toHaveBeenCalledTimes(1)
    expect(echartsStub.chart.setOption).toHaveBeenCalledWith(option, { notMerge: true })

    wrapper.unmount()
  })

  it('option 整体替换时重新 setOption，但不会重复 init', async () => {
    const wrapper = mount(BaseChart, { props: { option: { series: [{ data: [1] }] } } })
    expect(echartsStub.chart.setOption).toHaveBeenCalledTimes(1)

    await wrapper.setProps({ option: { series: [{ data: [1, 2] }] } })

    expect(echartsStub.init).toHaveBeenCalledTimes(1)
    expect(echartsStub.chart.setOption).toHaveBeenCalledTimes(2)

    wrapper.unmount()
  })

  it('option 内部深层数据变化（deep watch）也会重新 setOption', async () => {
    // 用响应式对象模拟「同一个 option 对象内部数据被改动」的场景
    const option = reactive({ series: [{ data: [1] as number[] }] })
    const wrapper = mount(BaseChart, { props: { option } })
    expect(echartsStub.chart.setOption).toHaveBeenCalledTimes(1)

    option.series[0].data.push(2)
    await nextTick()

    expect(echartsStub.chart.setOption).toHaveBeenCalledTimes(2)

    wrapper.unmount()
  })

  it('监听 window resize，触发时调用 chart.resize', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const wrapper = mount(BaseChart, { props: { option: {} } })

    expect(addSpy).toHaveBeenCalledWith('resize', expect.any(Function))
    window.dispatchEvent(new Event('resize'))
    expect(echartsStub.chart.resize).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  it('卸载时移除 resize 监听并 dispose 图表实例', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const wrapper = mount(BaseChart, { props: { option: {} } })

    wrapper.unmount()

    expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(echartsStub.chart.dispose).toHaveBeenCalledTimes(1)
  })

  it('卸载时断开 ResizeObserver（尺寸变化的自动重绘要停掉）', () => {
    const observe = vi.fn()
    const disconnect = vi.fn()
    class ResizeObserverStub {
      observe = observe
      unobserve = vi.fn()
      disconnect = disconnect
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)

    const wrapper = mount(BaseChart, { props: { option: {} } })
    expect(observe).toHaveBeenCalledTimes(1)

    wrapper.unmount()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })
 /**
   * 评审 M1：图表结构变化时必须 notMerge 重建，否则旧 series 会残留。
   *
   * 真实后果（评审实测）：报告页有 3 条血压、只有第 2 条填了心率 → 删掉第 2 条 →
   * hasBpPulse 变 false、option 变成 2 条 series + 单轴 → 但 ECharts 的 setOption
   * 是合并语义，会**保留**第 3 条心率曲线和那根空的 bpm 副轴：
   * x 轴只有 2 个点、心率却有 3 个点，医生看到的图与明细对不上。
   */
  it('结构变化（series 数量/名字或 y 轴数量变了）时用 notMerge 重建，避免残留曲线', async () => {
    const withPulse = {
      series: [
        { name: '高压', data: [130, 120] },
        { name: '低压', data: [80, 75] },
        { name: '心率', data: [76, null] },
      ],
      yAxis: [{ name: 'mmHg' }, { name: 'bpm' }],
    }
    const wrapper = mount(BaseChart, { props: { option: withPulse } })
    // 首次渲染也是整体替换（没有旧状态可合并）
    expect(echartsStub.chart.setOption).toHaveBeenLastCalledWith(withPulse, { notMerge: true })

    // 删掉唯一带心率的那条 → 结构从「3 series + 双轴」变成「2 series + 单轴」
    const noPulse = {
      series: [
        { name: '高压', data: [130] },
        { name: '低压', data: [80] },
      ],
      yAxis: { name: 'mmHg' },
    }
    await wrapper.setProps({ option: noPulse })
    // 关键断言：必须 notMerge，否则心率曲线与 bpm 副轴会残留在图上
    expect(echartsStub.chart.setOption).toHaveBeenLastCalledWith(noPulse, { notMerge: true })

    wrapper.unmount()
  })

  it('结构没变（只是数据点更新）时走合并更新，保留动画', async () => {
    const option = { series: [{ name: '高压', data: [130] }], yAxis: { name: 'mmHg' } }
    const wrapper = mount(BaseChart, { props: { option } })
    expect(echartsStub.chart.setOption).toHaveBeenLastCalledWith(option, { notMerge: true })

    const updated = { series: [{ name: '高压', data: [130, 125] }], yAxis: { name: 'mmHg' } }
    await wrapper.setProps({ option: updated })
    // 同样的 series 名与轴数量 → 合并即可（不必整体重建）
    expect(echartsStub.chart.setOption).toHaveBeenLastCalledWith(updated, { notMerge: false })

    wrapper.unmount()
  })
})

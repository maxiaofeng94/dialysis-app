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
    expect(echartsStub.chart.setOption).toHaveBeenCalledWith(option)

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
})

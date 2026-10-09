/**
 * App.vue（外壳）测试
 *
 * 底部 tabbar 的显示与否只看 `route.meta.tabbar`，高亮项由当前路径推导。
 * 这里用真实的 memory history 路由 + 桩页面组件，验证「元信息 → 渲染」与「点击 → push」两条链路。
 */
import { describe, it, expect } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { defineComponent, h } from 'vue'
import Vant from 'vant'
import App from '../../src/App.vue'

const PageStub = (name: string) =>
  defineComponent({ name, render: () => h('div', { class: `page-${name}` }, name) })

/** 只保留 App.vue 关心的 meta.tabbar 与路径，页面本身用桩，避免牵连真实视图的数据层 */
function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: PageStub('home'), meta: { tabbar: true } },
      { path: '/trend', name: 'trend', component: PageStub('trend'), meta: { tabbar: true } },
      { path: '/settings', name: 'settings', component: PageStub('settings'), meta: { tabbar: true } },
      { path: '/session/:id', name: 'session', component: PageStub('session') },
    ],
  })
}

async function mountApp(path: string) {
  const router = makeRouter()
  await router.push(path)
  await router.isReady()
  const wrapper = mount(App, { global: { plugins: [Vant, router] } })
  await flushPromises()
  return { wrapper, router }
}

describe('App 外壳 · 底部 tabbar 显隐', () => {
  it('meta.tabbar=true 的首页显示 tabbar', async () => {
    const { wrapper } = await mountApp('/')
    expect(wrapper.findComponent({ name: 'VanTabbar' }).exists()).toBe(true)
    expect(wrapper.findAll('.van-tabbar-item')).toHaveLength(3)
    wrapper.unmount()
  })

  it('meta.tabbar=true 的趋势页/设置页显示 tabbar', async () => {
    for (const path of ['/trend', '/settings']) {
      const { wrapper } = await mountApp(path)
      expect(wrapper.findComponent({ name: 'VanTabbar' }).exists()).toBe(true)
      wrapper.unmount()
    }
  })

  it('meta.tabbar 未声明的详情页不显示 tabbar', async () => {
    const { wrapper } = await mountApp('/session/abc')
    expect(wrapper.findComponent({ name: 'VanTabbar' }).exists()).toBe(false)
    expect(wrapper.find('.page-session').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('App 外壳 · 当前高亮项（active）', () => {
  it('/ → 0，/trend → 1，/settings → 2', async () => {
    const cases: [string, number][] = [
      ['/', 0],
      ['/trend', 1],
      ['/settings', 2],
    ]
    for (const [path, expected] of cases) {
      const { wrapper } = await mountApp(path)
      expect(wrapper.findComponent({ name: 'VanTabbar' }).props('modelValue')).toBe(expected)
      wrapper.unmount()
    }
  })

  it('详情页等无 tabbar 的路径不会渲染 tabbar（active 无宿主）', async () => {
    const { wrapper } = await mountApp('/session/abc')
    expect(wrapper.find('.van-tabbar').exists()).toBe(false)
    expect(wrapper.find('.page-session').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('App 外壳 · 点击 tabbar 切换路由', () => {
  it('点击第 2/3/1 项分别跳到 /trend、/settings、/', async () => {
    const { wrapper, router } = await mountApp('/')

    await wrapper.findAll('.van-tabbar-item')[1].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/trend')

    await wrapper.findAll('.van-tabbar-item')[2].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/settings')

    await wrapper.findAll('.van-tabbar-item')[0].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/')

    wrapper.unmount()
  })
})

/**
 * src/lib/backButton.ts
 *
 * 背景：Capacitor 只在 **JS 侧注册了 `backButton` 监听**时才不执行系统默认的 `finish()`。
 * 之前一个监听都没注册 → 在任何页面（含弹窗打开时）按返回键都直接退出 App，
 * 正在弹窗里填的血压 / 血糖全丢。
 *
 * 这里把「关弹层 → 退回上一页 → 首页双击退出」三级优先级钉住，
 * 其中最容易写错、也最危险的是两条：
 *   1. Vant 的弹窗关闭后 DOM 仍在（高度为 0）—— 不过滤可见性就永远退不出去；
 *   2. 命令式对话框只能点「取消」，点确认等于替用户确认了删除。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const platform = vi.hoisted(() => ({ current: 'android' }))
const appMock = vi.hoisted(() => ({
  addListener: vi.fn(() => Promise.resolve({ remove: vi.fn() })),
  exitApp: vi.fn(() => Promise.resolve()),
}))
const toastMock = vi.hoisted(() => vi.fn())
const routerMock = vi.hoisted(() => ({
  currentRoute: { value: { path: '/' } },
  back: vi.fn(),
  replace: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => platform.current,
    isNativePlatform: () => platform.current !== 'web',
  },
}))
vi.mock('@capacitor/app', () => ({ App: appMock }))
vi.mock('vant', () => ({ showToast: toastMock }))
vi.mock('../../src/router', () => ({ default: routerMock }))

import { setupAndroidBackButton } from '../../src/lib/backButton'

/** jsdom 里 getBoundingClientRect 恒返回 0，可见性判断需要手工打桩 */
function visibleEl(html: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.innerHTML = html
  const el = wrap.firstElementChild as HTMLElement
  el.getBoundingClientRect = () =>
    ({ width: 320, height: 200, top: 0, left: 0, right: 320, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  document.body.appendChild(el)
  return el
}

/** 已关闭的弹窗：DOM 还在，但高度为 0（Vant 的真实行为） */
function hiddenEl(html: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.innerHTML = html
  const el = wrap.firstElementChild as HTMLElement
  el.getBoundingClientRect = () =>
    ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  document.body.appendChild(el)
  return el
}

/** 取注册给 Capacitor 的 backButton 回调 */
function backHandler(): () => void {
  const call = appMock.addListener.mock.calls.at(-1) as unknown as [string, () => void]
  expect(call?.[0]).toBe('backButton')
  return call[1]
}

/**
 * 每个用例把时钟往前推一分钟。
 *
 * `lastBackAt` 是模块级变量（真实运行时会跨页面保留），但测试里模块只加载一次 ——
 * 不推时钟的话，上一个用例刚设过的 lastBackAt 会让本用例的第一次按返回
 * 直接被判成「双击」而退出。
 */
let clockBase = Date.parse('2026-01-01T00:00:00Z')

beforeEach(() => {
  clockBase += 60_000
  vi.useFakeTimers()
  vi.setSystemTime(clockBase)
  document.body.innerHTML = ''
  platform.current = 'android'
  appMock.addListener.mockClear()
  appMock.exitApp.mockClear()
  toastMock.mockClear()
  routerMock.back.mockClear()
  routerMock.replace.mockClear()
  routerMock.currentRoute.value = { path: '/' }
  setupAndroidBackButton()
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('返回键 · 弹层优先级', () => {
  it('有可见弹窗 → 点遮罩关闭，不退出也不跳路由', () => {
    const overlay = visibleEl('<div class="van-overlay"></div>')
    const clicked = vi.fn()
    overlay.addEventListener('click', clicked)

    backHandler()()

    expect(clicked).toHaveBeenCalledTimes(1)
    expect(appMock.exitApp).not.toHaveBeenCalled()
    expect(routerMock.back).not.toHaveBeenCalled()
  })

  it('有多个弹窗时只关最上层那个', () => {
    visibleEl('<div class="van-overlay" id="lower"></div>')
    const top = visibleEl('<div class="van-overlay" id="top"></div>')
    const onTop = vi.fn()
    top.addEventListener('click', onTop)

    backHandler()()

    expect(onTop).toHaveBeenCalledTimes(1)
  })

  it('已关闭的弹窗（DOM 还在但高度为 0）不算数 —— 否则返回键会永远失灵', () => {
    hiddenEl('<div class="van-overlay"></div>')

    backHandler()()

    // 没有弹层可关，首页 → 走双击退出提示
    expect(toastMock).toHaveBeenCalledWith('再按一次返回键退出')
  })

  it('命令式对话框 → 点「取消」，绝不能点「确认」', () => {
    const dialog = visibleEl(
      '<div class="van-dialog">' +
        '<div class="van-dialog__footer">' +
        '<button class="van-dialog__cancel">取消</button>' +
        '<button class="van-dialog__confirm">确认删除</button>' +
        '</div></div>',
    )
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    dialog.querySelector('.van-dialog__cancel')!.addEventListener('click', onCancel)
    dialog.querySelector('.van-dialog__confirm')!.addEventListener('click', onConfirm)

    backHandler()()

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm, '返回键绝不能替用户确认删除这类不可逆操作').not.toHaveBeenCalled()
  })

  it('对话框没有取消按钮时：什么都不做，也不误点确认', () => {
    const dialog = visibleEl(
      '<div class="van-dialog"><button class="van-dialog__confirm">确定</button></div>',
    )
    const onConfirm = vi.fn()
    dialog.querySelector('.van-dialog__confirm')!.addEventListener('click', onConfirm)

    backHandler()()

    expect(onConfirm).not.toHaveBeenCalled()
    expect(appMock.exitApp).not.toHaveBeenCalled()
  })
})

describe('返回键 · 页面导航', () => {
  it('不在首页且有历史 → 回上一页', () => {
    routerMock.currentRoute.value = { path: '/session/abc' }
    window.history.pushState({ back: '/' }, '')

    backHandler()()

    expect(routerMock.back).toHaveBeenCalledTimes(1)
    expect(appMock.exitApp).not.toHaveBeenCalled()
  })

  it('不在首页但没有历史（冷启动直接落详情页）→ 兜底回首页，别让返回键失灵', () => {
    routerMock.currentRoute.value = { path: '/session/abc' }
    window.history.pushState({ back: null }, '')

    backHandler()()

    expect(routerMock.back).not.toHaveBeenCalled()
    expect(routerMock.replace).toHaveBeenCalledWith('/')
  })
})

describe('返回键 · 首页退出', () => {
  it('第一次按：只提示，不退出', () => {
    backHandler()()

    expect(toastMock).toHaveBeenCalledWith('再按一次返回键退出')
    expect(appMock.exitApp).not.toHaveBeenCalled()
  })

  it('2 秒内再按一次：退出 App', () => {
    const t0 = Date.now()

    backHandler()()
    vi.setSystemTime(t0 + 1000)
    backHandler()()

    expect(appMock.exitApp).toHaveBeenCalledTimes(1)
  })

  it('超过 2 秒才按第二次：重新计时，不退出', () => {
    const t0 = Date.now()

    backHandler()()
    vi.setSystemTime(t0 + 5000)
    backHandler()()

    expect(appMock.exitApp).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledTimes(2)
  })
})

describe('返回键 · 平台', () => {
  it('iOS / Web 不接管（iOS 没有系统返回键，Apple 也不允许应用主动退出）', () => {
    for (const p of ['ios', 'web']) {
      platform.current = p
      appMock.addListener.mockClear()

      setupAndroidBackButton()

      expect(appMock.addListener, `${p} 上不该注册 backButton 监听`).not.toHaveBeenCalled()
    }
  })
})

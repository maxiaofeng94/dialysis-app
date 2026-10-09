/**
 * 全局测试环境准备（所有测试文件自动加载）
 */
import 'fake-indexeddb/auto' // Dexie / cloudCache 依赖的 IndexedDB 实现
import { afterEach, beforeEach, vi } from 'vitest'
import { config } from '@vue/test-utils'

// ------------------------------------------------------------------
// 1. 断言「测试默认跑在纯本地模式」
//    如果被 .env 污染，云端分支会意外生效，测试结果将不可复现 —— 直接报错提醒。
// ------------------------------------------------------------------
if (import.meta.env.VITE_SUPABASE_URL || import.meta.env.VITE_SUPABASE_ANON_KEY) {
  throw new Error(
    '测试环境的 VITE_SUPABASE_* 必须为空：请检查 vitest.config.ts 的 define，勿把 .env 带进测试',
  )
}

// ------------------------------------------------------------------
// 2. 浏览器 API 兜底（jsdom 缺失、Vant / Element Plus 需要）
//    edge 用例跑在 node 环境（没有 window），这里整体跳过。
// ------------------------------------------------------------------
const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined'

if (!hasDom) {
  // Node 环境（Edge Function 用例）：只需保证 crypto / fetch 等运行时能力存在
} else {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }

  class FakeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }

  globalThis.ResizeObserver ??= FakeObserver as unknown as typeof ResizeObserver
  globalThis.IntersectionObserver ??= FakeObserver as unknown as typeof IntersectionObserver
  globalThis.scrollTo ??= (() => {}) as unknown as typeof scrollTo
  Element.prototype.scrollIntoView ??= () => {}

  // ECharts 初始化时会读 canvas，jsdom 没有实现 → 给个最小桩
  if (!HTMLCanvasElement.prototype.getContext) {
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as unknown as typeof HTMLCanvasElement.prototype.getContext
  }
}

// ------------------------------------------------------------------
// 3. Vue Test Utils 全局配置
// ------------------------------------------------------------------
// 渲染期的 Vue 警告视为「值得知道」但不失败；需要断言警告的用例自行覆盖 warnHandler
config.global.stubs = {}

// ------------------------------------------------------------------
// 4. 每个用例后清理状态，避免隐性串味
// ------------------------------------------------------------------
beforeEach(() => {
  if (hasDom) localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (hasDom) document.body.innerHTML = ''
})

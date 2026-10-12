/**
 * 带超时与保守重试的 fetch —— App 与后台管理端共用。
 *
 * 为什么需要它：supabase-js **既不超时也不重试**。手机（尤其医院里信号弱、或刚从
 * Wi-Fi 切到移动数据）首次请求要现做 DNS + TLS 握手，实测生产库首次 1489ms、
 * 后续只要 ~310ms —— 首次那一下就足以让请求失败或长时间挂住。
 * 用户看到的是「网络连接失败」，再点一次（连接已建立）就好了。
 *
 * 本文件刻意**不依赖任何东西**（不 import Capacitor、不碰 supabase），
 * 这样 App 与后台管理端都能安全引用 —— 后台不需要为了超时把移动端依赖打进产物。
 */

/** 单次请求最长等待时间：到点就中止，交给上层重试/提示，别让按钮一直转圈 */
export const REQUEST_TIMEOUT_MS = 15000

/** 只读请求的连接类失败重试节奏（写入类不重试：可能重复插入记录） */
const RETRY_DELAYS_MS = [400, 1200]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 只有幂等方法才允许在 fetch 层自动重试 */
function isIdempotentMethod(method: string | undefined): boolean {
  const m = (method ?? 'GET').toUpperCase()
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS'
}

/**
 * 「连接根本没建立」类失败：DNS 解析不了、连不上、断网 —— 请求没到达服务端，重试安全。
 * 超时中止（AbortError）**不算**：那种情况下请求可能已经被服务端处理了。
 */
function isConnectionFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; message?: string }
  if (e.name === 'AbortError') return false
  const m = (e.message ?? '').toLowerCase()
  return e.name === 'TypeError' || m.includes('failed to fetch') || m.includes('network')
}

/** 单次请求 + 超时；调用方自带的 signal 也会被尊重 */
async function fetchOnce(input: RequestInfo | URL, init: RequestInit | undefined): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const outer = init?.signal
  if (outer) {
    if (outer.aborted) controller.abort()
    else outer.addEventListener('abort', () => controller.abort(), { once: true })
  }
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function resilientFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const retriable = isIdempotentMethod(init?.method)
  const attempts = retriable ? RETRY_DELAYS_MS.length + 1 : 1
  let lastError: unknown

  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchOnce(input, init)
    } catch (err) {
      lastError = err
      if (!retriable || !isConnectionFailure(err) || i === attempts - 1) throw err
      await sleep(RETRY_DELAYS_MS[i])
    }
  }
  throw lastError
}

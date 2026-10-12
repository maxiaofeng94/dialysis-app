/**
 * src/lib/supabase.ts 的 resilientFetch
 *
 * 手机（尤其医院里信号弱、或刚从 Wi-Fi 切到移动数据）首次请求要现做 DNS + TLS 握手，
 * 偶发直接失败。supabase-js 默认既不超时也不重试，用户看到「网络连接失败」、
 * 再点一次（连接已建立）就好了 —— 也就是反馈里的「总提示网络失败，要多点几次」。
 *
 * 这里固化两条边界：
 *   1. 只读请求（GET/HEAD/OPTIONS）遇到**连接根本没建立**的失败才重试；
 *   2. 写入请求（POST）与超时中止（请求可能已经被服务端处理）一律不重试。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { resilientFetch, REQUEST_TIMEOUT_MS } from '../../src/lib/supabase'

/** 一个「连接失败」：fetch 在网络层失败时抛的就是 TypeError */
function connectionError() {
  return new TypeError('Failed to fetch')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('resilientFetch · 重试策略', () => {
  it('GET 首次连接失败 → 自动重试并成功', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(connectionError())
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const promise = resilientFetch('https://example.test/rest/v1/patients')
    await vi.advanceTimersByTimeAsync(5000)

    await expect(promise).resolves.toMatchObject({ status: 200 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('GET 连续失败 → 重试到上限后把最后一次的异常抛出', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockRejectedValue(connectionError())
    vi.stubGlobal('fetch', fetchMock)

    const promise = resilientFetch('https://example.test/rest/v1/patients')
    const assertion = expect(promise).rejects.toThrow('Failed to fetch')
    await vi.advanceTimersByTimeAsync(10000)
    await assertion

    // 1 次原始 + 2 次重试（与 RETRY_DELAYS_MS 的长度一致）
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('POST 不做自动重试：写入类重试可能重复插入记录', async () => {
    const fetchMock = vi.fn().mockRejectedValue(connectionError())
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      resilientFetch('https://example.test/rest/v1/sessions', { method: 'POST', body: '{}' }),
    ).rejects.toThrow('Failed to fetch')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('POST 即使 5xx 也不重试（由调用方决定，避免重复写）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('boom', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await resilientFetch('https://example.test/rest/v1/sessions', { method: 'POST' })

    expect(res.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('4xx/5xx 是「拿到了响应」，不算连接失败 —— 不重试', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await resilientFetch('https://example.test/rest/v1/patients')

    expect(res.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('resilientFetch · 超时', () => {
  it('超过 REQUEST_TIMEOUT_MS 会中止请求（不让按钮一直转圈）', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const promise = resilientFetch('https://example.test/rest/v1/slow')
    const assertion = expect(promise).rejects.toThrow(/abort/i)
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 50)
    await assertion

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('超时中止不重试：请求可能已经到达服务端并被处理', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const promise = resilientFetch('https://example.test/rest/v1/slow')
    const assertion = expect(promise).rejects.toThrow()
    // 就算给它足够的时间跑完所有重试间隔，也只应发出一次请求
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 4)
    await assertion

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('请求按时返回时定时器被清掉（不会留下悬挂的中止器）', async () => {
    vi.useFakeTimers()
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status: 200 })))

    await resilientFetch('https://example.test/rest/v1/fast')

    expect(clearSpy).toHaveBeenCalled()
  })
})

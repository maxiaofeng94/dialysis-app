/**
 * src/utils/timeout.ts
 *
 * 这个工具的作用只有一个：**别让首屏被挂死的网络请求卡住**。
 * 路由守卫会 await 登录态恢复与病人校准，`router-view` 在守卫返回前是空的 ——
 * 一旦请求没有响应又没人给上限，就是永久白屏。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { withTimeout } from '../../src/utils/timeout'

afterEach(() => {
  vi.useRealTimers()
})

describe('withTimeout', () => {
  it('原 Promise 先完成：用真实结果，兜底值不生效', async () => {
    vi.useFakeTimers()
    const promise = withTimeout(new Promise<string>((r) => setTimeout(() => r('real'), 100)), 1000, 'fallback')

    await vi.advanceTimersByTimeAsync(500)

    await expect(promise).resolves.toBe('real')
  })

  it('超时：resolve 兜底值，且**不 reject**（调用方不该被超时炸掉）', async () => {
    vi.useFakeTimers()
    const promise = withTimeout(new Promise<string>(() => {}), 1000, 'fallback')

    await vi.advanceTimersByTimeAsync(1000)

    await expect(promise).resolves.toBe('fallback')
  })

  it('原 Promise reject：同样落到兜底值，不把异常抛给调用方', async () => {
    const promise = withTimeout(Promise.reject(new Error('boom')), 1000, 'fallback')

    await expect(promise).resolves.toBe('fallback')
  })

  it('兜底值可以是 null —— getSession() 超时的语义就是「当作未登录」', async () => {
    vi.useFakeTimers()
    const promise = withTimeout(new Promise<{ id: string } | null>(() => {}), 500, null)

    await vi.advanceTimersByTimeAsync(500)

    await expect(promise).resolves.toBeNull()
  })

  it('超时之后原 Promise 才落地：结果被丢弃，不会二次 resolve', async () => {
    vi.useFakeTimers()
    let resolveLate: (v: string) => void = () => {}
    const late = new Promise<string>((r) => {
      resolveLate = r
    })

    const promise = withTimeout(late, 100, 'fallback')
    await vi.advanceTimersByTimeAsync(100)
    resolveLate('late')
    await vi.advanceTimersByTimeAsync(10)

    await expect(promise).resolves.toBe('fallback')
  })
})

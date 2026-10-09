/**
 * src/utils/id.ts 单元测试
 *
 * uuid() 有两条分支：原生 crypto.randomUUID，以及「没有 randomUUID 的环境」的回退实现。
 * 回退分支只在老浏览器 / 非安全上下文（http 非 localhost）下才会走到，属于典型的
 * 「平时测不到、上线才炸」的代码，这里用 vi.stubGlobal 把 crypto 换掉强行覆盖。
 */
import { describe, it, expect, vi } from 'vitest'

/** 标准 v4 UUID */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
/** 回退格式：时间戳(36 进制) + '-' + 随机后缀（后缀长度取决于 Math.random 的位数） */
const FALLBACK = /^[0-9a-z]+-[0-9a-z]{0,8}$/

/** 每次都拿全新的模块实例（配合 vi.resetModules，避免模块级缓存干扰） */
async function loadUuid() {
  vi.resetModules()
  const mod = await import('../../src/utils/id')
  return mod.uuid
}

describe('uuid · 原生分支（crypto.randomUUID 可用）', () => {
  it('返回值原样透传自 crypto.randomUUID', async () => {
    const fixed = 'abcdefab-1234-4abc-8def-abcdefabcdef'
    vi.stubGlobal('crypto', { randomUUID: () => fixed })
    const uuid = await loadUuid()
    expect(uuid()).toBe(fixed)
  })

  it('环境自带 crypto.randomUUID 时返回合法 v4 UUID', async () => {
    // 前提校验：jsdom/Node 环境确实提供 randomUUID（不提供就跳过，避免环境差异导致假失败）
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      const uuid = await loadUuid()
      expect(uuid()).toMatch(UUID_V4)
    }
  })

  it('连续 100 次不重复', async () => {
    const uuid = await loadUuid()
    const list = Array.from({ length: 100 }, () => uuid())
    expect(new Set(list).size).toBe(100)
    expect(list.every((v) => typeof v === 'string' && v.length > 0)).toBe(true)
  })
})

describe('uuid · 回退分支（没有 crypto.randomUUID）', () => {
  it('crypto 存在但没有 randomUUID → 返回「时间戳-随机串」形式', async () => {
    vi.stubGlobal('crypto', {})
    const uuid = await loadUuid()
    const v = uuid()
    expect(v).toMatch(FALLBACK)
    expect(v).not.toMatch(UUID_V4)
  })

  it('crypto 整体不存在（typeof crypto === undefined）也走回退分支', async () => {
    vi.stubGlobal('crypto', undefined)
    const uuid = await loadUuid()
    expect(uuid()).toMatch(FALLBACK)
  })

  it('randomUUID 不是函数（被别的库占用）时同样回退', async () => {
    vi.stubGlobal('crypto', { randomUUID: 'not-a-function' })
    const uuid = await loadUuid()
    expect(uuid()).toMatch(FALLBACK)
  })

  it('回退分支连续 100 次不重复', async () => {
    vi.stubGlobal('crypto', {})
    const uuid = await loadUuid()
    const list = Array.from({ length: 100 }, () => uuid())
    expect(new Set(list).size).toBe(100)
    expect(list.every((v) => FALLBACK.test(v))).toBe(true)
  })

  it('Math.random() 极端为 0 时用递增序号兜底，同毫秒内也不会撞 id', async () => {
    vi.stubGlobal('crypto', {})
    vi.spyOn(Math, 'random').mockReturnValue(0) // (0).toString(36) === '0' → 随机后缀为空
    const uuid = await loadUuid()

    // 回归：曾经随机后缀为空就直接拼成 `<stamp>-`，同一毫秒内连续调用会得到相同 id
    const ids = Array.from({ length: 5 }, () => uuid())
    expect(new Set(ids).size).toBe(5)
    expect(ids.every((v) => FALLBACK.test(v))).toBe(true)
    expect(ids[0]).not.toMatch(/-$/)
  })
})

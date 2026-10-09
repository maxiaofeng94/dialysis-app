/**
 * cachedRepository（缓存优先 + 后台刷新）测试
 *
 * 做法：
 * - `vi.mock('../../src/lib/cloudRepository')` 换成可断言的 vi.fn() 桩（云端行为完全可控）；
 * - cloudCache 用真实实现 + fake-indexeddb，验证缓存真的被读写了。
 *
 * 等待策略：后台刷新是 `void (async () => …)()`，没有返回 promise 可 await。
 * 这里用 `vi.waitFor` 轮询断言，或 `setTimeout(0)` 冲一次宏任务 —— 都是「把待处理的
 * promise 回调放完」，不依赖真实时间（fresh/stale 用 updatedAt 精确构造，不 sleep）。
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { makePatient, makeDryWeight, makeSession, makeBp, makeBg, makeBf, makeReaction } from '../helpers/factories'

/** 云端仓储桩：所有方法都可在用例里改实现 / 断言调用 */
const cloud = vi.hoisted(() => ({
  getPatient: vi.fn(),
  savePatient: vi.fn(),
  listDryWeights: vi.fn(),
  saveDryWeight: vi.fn(),
  deleteDryWeight: vi.fn(),
  listSessions: vi.fn(),
  getSession: vi.fn(),
  saveSession: vi.fn(),
  deleteSession: vi.fn(),
  listBloodPressures: vi.fn(),
  saveBloodPressure: vi.fn(),
  deleteBloodPressure: vi.fn(),
  listBloodGlucoses: vi.fn(),
  saveBloodGlucose: vi.fn(),
  deleteBloodGlucose: vi.fn(),
  listBloodFlows: vi.fn(),
  saveBloodFlow: vi.fn(),
  deleteBloodFlow: vi.fn(),
  listAdverseReactions: vi.fn(),
  replaceAdverseReactions: vi.fn(),
  exportAll: vi.fn(),
  importAll: vi.fn(),
}))

vi.mock('../../src/lib/cloudRepository', () => ({ cloudRepository: cloud }))

import { cachedCloudRepository } from '../../src/repo/cachedRepository'
import { cacheGet, cacheSet, cacheKeysByPrefix, cacheClear, cacheVersion, FRESH_MS } from '../../src/lib/cloudCache'

/** 直接往缓存 kv 表写原始行：用于精确构造 updatedAt（新鲜 / 过期边界）或制造损坏数据 */
function putRawRow(key: string, value: string, updatedAt: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // 不能指定版本号：Dexie 的 version(1) 在 IndexedDB 里是版本 10
    const req = indexedDB.open('dialysis-cloud-cache')
    req.onupgradeneeded = () => {
      const idb = req.result
      if (!idb.objectStoreNames.contains('kv')) idb.createObjectStore('kv', { keyPath: 'key' })
    }
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const idb = req.result
      const tx = idb.transaction('kv', 'readwrite')
      tx.objectStore('kv').put({ key, value, updatedAt })
      tx.oncomplete = () => {
        idb.close()
        resolve()
      }
      tx.onerror = () => {
        idb.close()
        reject(tx.error)
      }
    }
  })
}

/** 写一条正常的缓存行（值会被序列化） */
const putRawCache = (key: string, value: unknown, updatedAt: number) => putRawRow(key, JSON.stringify(value), updatedAt)

/** 写一条「值不是合法 JSON」的缓存行 */
const putRawCacheValue = (key: string, rawValue: string, updatedAt: number) => putRawRow(key, rawValue, updatedAt)

/** 让出一轮宏任务，把后台刷新这类「游离 promise」放完 */
const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0))

function resetCloudMocks() {
  for (const fn of Object.values(cloud)) (fn as Mock).mockReset()
  cloud.getPatient.mockResolvedValue(undefined)
  cloud.savePatient.mockResolvedValue(undefined)
  cloud.listDryWeights.mockResolvedValue([])
  cloud.saveDryWeight.mockResolvedValue(undefined)
  cloud.deleteDryWeight.mockResolvedValue(undefined)
  cloud.listSessions.mockResolvedValue([])
  cloud.getSession.mockResolvedValue(undefined)
  cloud.saveSession.mockResolvedValue(undefined)
  cloud.deleteSession.mockResolvedValue(undefined)
  cloud.listBloodPressures.mockResolvedValue([])
  cloud.saveBloodPressure.mockResolvedValue(undefined)
  cloud.deleteBloodPressure.mockResolvedValue(undefined)
  cloud.listBloodGlucoses.mockResolvedValue([])
  cloud.saveBloodGlucose.mockResolvedValue(undefined)
  cloud.deleteBloodGlucose.mockResolvedValue(undefined)
  cloud.listBloodFlows.mockResolvedValue([])
  cloud.saveBloodFlow.mockResolvedValue(undefined)
  cloud.deleteBloodFlow.mockResolvedValue(undefined)
  cloud.listAdverseReactions.mockResolvedValue([])
  cloud.replaceAdverseReactions.mockResolvedValue(undefined)
  cloud.exportAll.mockResolvedValue('{"version":1}')
  cloud.importAll.mockResolvedValue(undefined)
}

beforeEach(async () => {
  resetCloudMocks()
  await cacheClear()
})

describe('cachedRepository · 无缓存时走网络', () => {
  it('首次读取直接请求云端，并把结果写入缓存', async () => {
    const list = [makeSession({ id: 's1', patientId: 'p1' })]
    cloud.listSessions.mockResolvedValue(list)

    const got = await cachedCloudRepository.listSessions('p1')

    expect(got).toEqual(list)
    expect(cloud.listSessions).toHaveBeenCalledWith('p1')
    expect((await cacheGet<typeof list>('sessions:p1'))?.value).toEqual(list)
  })

  it('云端无数据时缓存空数组（下次命中缓存，不会反复空跑网络）', async () => {
    const first = await cachedCloudRepository.listSessions('p1')
    expect(first).toEqual([])
    expect((await cacheGet<unknown[]>('sessions:p1'))?.value).toEqual([])

    const again = await cachedCloudRepository.listSessions('p1')

    expect(again).toEqual([])
    expect(cloud.listSessions).toHaveBeenCalledTimes(1)
  })

  it('无缓存且网络失败时向调用方抛错，且不写入缓存', async () => {
    cloud.listSessions.mockRejectedValue(new Error('网络不可用'))

    await expect(cachedCloudRepository.listSessions('p1')).rejects.toThrow('网络不可用')
    expect(await cacheGet('sessions:p1')).toBeNull()
  })

  it('列表接口按 key 隔离：不同病人的缓存互不干扰', async () => {
    cloud.listSessions.mockImplementation(async (pid: string) => [makeSession({ id: `s-${pid}`, patientId: pid })])

    await cachedCloudRepository.listSessions('p1')
    await cachedCloudRepository.listSessions('p2')

    expect((await cacheGet<{ id: string }[]>('sessions:p1'))?.value[0].id).toBe('s-p1')
    expect((await cacheGet<{ id: string }[]>('sessions:p2'))?.value[0].id).toBe('s-p2')
  })

  it('子表读取同样缓存优先（血压）', async () => {
    const bps = [makeBp({ id: 'bp1', sessionId: 's1' })]
    cloud.listBloodPressures.mockResolvedValue(bps)

    await cachedCloudRepository.listBloodPressures('s1')
    const second = await cachedCloudRepository.listBloodPressures('s1')

    expect(second).toEqual(bps)
    expect(cloud.listBloodPressures).toHaveBeenCalledTimes(1)
  })

  it('干体重 / 血糖 / 血流量 / 不良反应列表都走缓存优先', async () => {
    const dries = [makeDryWeight({ id: 'd1', patientId: 'p1' })]
    const bgs = [makeBg({ id: 'bg1', sessionId: 's1' })]
    const bfs = [makeBf({ id: 'bf1', sessionId: 's1' })]
    const ars = [makeReaction({ id: 'ar1', sessionId: 's1' })]
    cloud.listDryWeights.mockResolvedValue(dries)
    cloud.listBloodGlucoses.mockResolvedValue(bgs)
    cloud.listBloodFlows.mockResolvedValue(bfs)
    cloud.listAdverseReactions.mockResolvedValue(ars)

    // 每个接口读两次：第一次落缓存，第二次命中缓存
    expect(await cachedCloudRepository.listDryWeights('p1')).toEqual(dries)
    expect(await cachedCloudRepository.listDryWeights('p1')).toEqual(dries)
    expect(await cachedCloudRepository.listBloodGlucoses('s1')).toEqual(bgs)
    expect(await cachedCloudRepository.listBloodGlucoses('s1')).toEqual(bgs)
    expect(await cachedCloudRepository.listBloodFlows('s1')).toEqual(bfs)
    expect(await cachedCloudRepository.listBloodFlows('s1')).toEqual(bfs)
    expect(await cachedCloudRepository.listAdverseReactions('s1')).toEqual(ars)
    expect(await cachedCloudRepository.listAdverseReactions('s1')).toEqual(ars)

    expect(cloud.listDryWeights).toHaveBeenCalledTimes(1)
    expect(cloud.listBloodGlucoses).toHaveBeenCalledTimes(1)
    expect(cloud.listBloodFlows).toHaveBeenCalledTimes(1)
    expect(cloud.listAdverseReactions).toHaveBeenCalledTimes(1)
    expect((await cacheGet<unknown[]>('dryWeights:p1'))?.value).toEqual(dries)
    expect((await cacheGet<unknown[]>('ars:s1'))?.value).toEqual(ars)
  })

  it('getSession 也走缓存优先；云端查不到时缓存 null（下次不再请求）', async () => {
    const session = makeSession({ id: 's1', patientId: 'p1' })
    cloud.getSession.mockImplementation(async (id: string) => (id === 's1' ? session : undefined))

    expect(await cachedCloudRepository.getSession('s1')).toEqual(session)
    expect(await cachedCloudRepository.getSession('s1')).toEqual(session)
    expect(cloud.getSession).toHaveBeenCalledTimes(1)

    // 云端无此记录（RLS 过滤 / 已删除）→ undefined，且不会反复请求
    expect(await cachedCloudRepository.getSession('s-not-exist')).toBeUndefined()
    expect(await cachedCloudRepository.getSession('s-not-exist')).toBeUndefined()
    expect(cloud.getSession).toHaveBeenCalledTimes(2)
  })
})

describe('cachedRepository · 新鲜缓存直接命中', () => {
  it('updatedAt 是刚刚 → 直接返回缓存，云端 fetcher 完全不被调用', async () => {
    const cachedList = [makeSession({ id: 'cached', patientId: 'p1', date: '2024-01-01' })]
    await cacheSet('sessions:p1', cachedList)

    const got = await cachedCloudRepository.listSessions('p1')

    expect(got).toEqual(cachedList)
    expect(cloud.listSessions).not.toHaveBeenCalled()
  })

  it('缓存年龄远小于 FRESH_MS（1 秒前写入）仍算新鲜', async () => {
    const cachedList = [makeSession({ id: 'cached', patientId: 'p1' })]
    await putRawCache('sessions:p1', cachedList, Date.now() - 1000)

    const got = await cachedCloudRepository.listSessions('p1')

    expect(got).toEqual(cachedList)
    expect(cloud.listSessions).not.toHaveBeenCalled()
  })

  it('显式缓存 null 的 getPatient 视为命中：返回 undefined 且不再请求云端', async () => {
    cloud.getPatient.mockResolvedValue(undefined)
    expect(await cachedCloudRepository.getPatient('p1')).toBeUndefined()
    expect(cloud.getPatient).toHaveBeenCalledTimes(1)

    // 第二次：命中的是「null 值的缓存」，不是未命中
    expect(await cachedCloudRepository.getPatient('p1')).toBeUndefined()
    expect(cloud.getPatient).toHaveBeenCalledTimes(1)
  })

  it('getPatient 云端返回 null 时对外是 undefined', async () => {
    cloud.getPatient.mockResolvedValue(null)

    expect(await cachedCloudRepository.getPatient('p-null')).toBeUndefined()
  })
})

describe('cachedRepository · 过期缓存的「先返回旧值 + 后台刷新」', () => {
  it('updatedAt=0（被标记过期）：立刻返回旧值，随后后台刷新并让 cacheVersion 自增', async () => {
    const oldList = [makeSession({ id: 'old', patientId: 'p1', date: '2024-01-01' })]
    const newList = [makeSession({ id: 'new', patientId: 'p1', date: '2024-06-01' })]
    await cacheSet('sessions:p1', oldList)
    await putRawCache('sessions:p1', oldList, 0) // 明确置 0，避免受 cacheSet 的写入时刻影响
    cloud.listSessions.mockResolvedValue(newList)
    const versionBefore = cacheVersion.value

    const got = await cachedCloudRepository.listSessions('p1')

    // 用户立刻拿到旧值，且不等待网络
    expect(got).toEqual(oldList)

    await vi.waitFor(() => expect(cacheVersion.value).toBe(versionBefore + 1))
    expect((await cacheGet<typeof newList>('sessions:p1'))?.value).toEqual(newList)
    expect(cloud.listSessions).toHaveBeenCalledTimes(1)
  })

  it('缓存年龄刚好超过 FRESH_MS 也触发后台刷新', async () => {
    const oldList = [makeSession({ id: 'old', patientId: 'p1' })]
    const newList = [makeSession({ id: 'new', patientId: 'p1' })]
    await putRawCache('sessions:p1', oldList, Date.now() - FRESH_MS - 50)
    cloud.listSessions.mockResolvedValue(newList)
    const versionBefore = cacheVersion.value

    expect(await cachedCloudRepository.listSessions('p1')).toEqual(oldList)

    await vi.waitFor(() => expect(cacheVersion.value).toBe(versionBefore + 1))
    expect((await cacheGet<typeof newList>('sessions:p1'))?.value).toEqual(newList)
  })

  it('背景刷新只发一次请求：刷新后的缓存是新鲜的，不会立刻再刷一轮', async () => {
    const oldList = [makeSession({ id: 'old', patientId: 'p1' })]
    await putRawCache('sessions:p1', oldList, 0)
    cloud.listSessions.mockResolvedValue([makeSession({ id: 'new', patientId: 'p1' })])

    await cachedCloudRepository.listSessions('p1')
    await vi.waitFor(() => expect(cloud.listSessions).toHaveBeenCalledTimes(1))

    // 重新读一次：命中的是刚写入的新鲜缓存
    await cachedCloudRepository.listSessions('p1')
    await flushAsync()

    expect(cloud.listSessions).toHaveBeenCalledTimes(1)
  })

  it('后台刷新失败：仍返回旧缓存、cacheVersion 不变、不向调用方抛错', async () => {
    const oldList = [makeSession({ id: 'old', patientId: 'p1' })]
    await putRawCache('sessions:p1', oldList, 0)
    cloud.listSessions.mockRejectedValue(new Error('云端 500'))
    const versionBefore = cacheVersion.value

    await expect(cachedCloudRepository.listSessions('p1')).resolves.toEqual(oldList)

    await vi.waitFor(() => expect(cloud.listSessions).toHaveBeenCalledTimes(1))
    await flushAsync()

    expect(cacheVersion.value).toBe(versionBefore)
    expect((await cacheGet<typeof oldList>('sessions:p1'))?.value).toEqual(oldList)
  })
})

describe('cachedRepository · 写操作：先落云端再更新缓存', () => {
  it('saveSession 写入单条缓存，并把该条插入列表缓存（按 date 倒序）', async () => {
    const existing = [
      makeSession({ id: 's-old', patientId: 'p1', date: '2024-01-01' }),
      makeSession({ id: 's-newest', patientId: 'p1', date: '2024-09-01' }),
    ]
    await cacheSet('sessions:p1', existing)
    const saved = makeSession({ id: 's-mid', patientId: 'p1', date: '2024-05-01' })

    await cachedCloudRepository.saveSession(saved)

    expect(cloud.saveSession).toHaveBeenCalledWith(saved)
    expect((await cacheGet<typeof saved>('session:s-mid'))?.value).toEqual(saved)
    const list = (await cacheGet<{ id: string }[]>('sessions:p1'))!.value
    expect(list.map((s) => s.id)).toEqual(['s-newest', 's-mid', 's-old'])
  })

  it('saveSession 云端失败时抛错，且不动任何缓存', async () => {
    await cacheSet('sessions:p1', [makeSession({ id: 's-old', patientId: 'p1' })])
    cloud.saveSession.mockRejectedValue(new Error('写入被 RLS 拦截'))
    const saved = makeSession({ id: 's1', patientId: 'p1' })

    await expect(cachedCloudRepository.saveSession(saved)).rejects.toThrow('写入被 RLS 拦截')

    expect(await cacheGet('session:s1')).toBeNull()
    expect((await cacheGet<{ id: string }[]>('sessions:p1'))!.value.map((s) => s.id)).toEqual(['s-old'])
  })

  it('列表缓存不存在时不无中生有（只写单条缓存）', async () => {
    const saved = makeSession({ id: 's1', patientId: 'p1' })

    await cachedCloudRepository.saveSession(saved)

    expect(await cacheGet('sessions:p1')).toBeNull()
    expect((await cacheGet<typeof saved>('session:s1'))?.value).toEqual(saved)
  })

  it('upsertInto 语义：列表里已有同 id 时是替换而不是追加', async () => {
    const old = makeSession({ id: 's1', patientId: 'p1', date: '2024-01-01', notes: '旧备注' })
    await cacheSet('sessions:p1', [old, makeSession({ id: 's2', patientId: 'p1', date: '2024-02-01' })])
    const updated = { ...old, notes: '新备注' }

    await cachedCloudRepository.saveSession(updated)

    const list = (await cacheGet<typeof updated[]>('sessions:p1'))!.value
    expect(list).toHaveLength(2)
    expect(list.find((s) => s.id === 's1')?.notes).toBe('新备注')
  })

  it('同日期记录按稳定排序追加在该日期分组末尾（byDateDesc 的相等分支不重排已有顺序）', async () => {
    const day = '2024-05-01'
    await cacheSet('sessions:p1', [
      makeSession({ id: 's-a', patientId: 'p1', date: day }),
      makeSession({ id: 's-b', patientId: 'p1', date: day }),
      makeSession({ id: 's-older', patientId: 'p1', date: '2024-01-01' }),
    ])

    await cachedCloudRepository.saveSession(makeSession({ id: 's-c', patientId: 'p1', date: day }))

    const list = (await cacheGet<{ id: string }[]>('sessions:p1'))!.value
    expect(list.map((s) => s.id)).toEqual(['s-a', 's-b', 's-c', 's-older'])
  })

  it('同生效日期的干体重同样稳定追加（byEffectiveDesc 的相等分支）', async () => {
    const day = '2024-03-01'
    await cacheSet('dryWeights:p1', [
      makeDryWeight({ id: 'd-a', patientId: 'p1', effectiveDate: day }),
      makeDryWeight({ id: 'd-b', patientId: 'p1', effectiveDate: day }),
      makeDryWeight({ id: 'd-older', patientId: 'p1', effectiveDate: '2024-01-01' }),
    ])

    await cachedCloudRepository.saveDryWeight(makeDryWeight({ id: 'd-c', patientId: 'p1', effectiveDate: day }))

    const list = (await cacheGet<{ id: string }[]>('dryWeights:p1'))!.value
    expect(list.map((d) => d.id)).toEqual(['d-a', 'd-b', 'd-c', 'd-older'])
  })

  it('saveDryWeight 按 effectiveDate 倒序插入列表缓存', async () => {
    await cacheSet('dryWeights:p1', [
      makeDryWeight({ id: 'd-old', patientId: 'p1', effectiveDate: '2024-01-01' }),
      makeDryWeight({ id: 'd-new', patientId: 'p1', effectiveDate: '2024-09-01' }),
    ])
    const saved = makeDryWeight({ id: 'd-mid', patientId: 'p1', effectiveDate: '2024-05-01' })

    await cachedCloudRepository.saveDryWeight(saved)

    expect(cloud.saveDryWeight).toHaveBeenCalledWith(saved)
    const list = (await cacheGet<{ id: string }[]>('dryWeights:p1'))!.value
    expect(list.map((d) => d.id)).toEqual(['d-new', 'd-mid', 'd-old'])
  })

  it('saveBloodPressure 按 measuredAt 升序插入列表缓存', async () => {
    await cacheSet('bps:s1', [
      makeBp({ id: 'bp-late', sessionId: 's1', measuredAt: 900 }),
      makeBp({ id: 'bp-early', sessionId: 's1', measuredAt: 100 }),
    ])
    const saved = makeBp({ id: 'bp-mid', sessionId: 's1', measuredAt: 500 })

    await cachedCloudRepository.saveBloodPressure(saved)

    expect(cloud.saveBloodPressure).toHaveBeenCalledWith(saved)
    const list = (await cacheGet<{ id: string }[]>('bps:s1'))!.value
    expect(list.map((b) => b.id)).toEqual(['bp-early', 'bp-mid', 'bp-late'])
  })

  it('saveBloodGlucose / saveBloodFlow 同样更新各自的列表缓存', async () => {
    await cacheSet('bgs:s1', [makeBg({ id: 'bg-2', sessionId: 's1', measuredAt: 200 })])
    await cacheSet('bfs:s1', [makeBf({ id: 'bf-2', sessionId: 's1', measuredAt: 200 })])

    await cachedCloudRepository.saveBloodGlucose(makeBg({ id: 'bg-1', sessionId: 's1', measuredAt: 100 }))
    await cachedCloudRepository.saveBloodFlow(makeBf({ id: 'bf-1', sessionId: 's1', measuredAt: 100 }))

    expect((await cacheGet<{ id: string }[]>('bgs:s1'))!.value.map((g) => g.id)).toEqual(['bg-1', 'bg-2'])
    expect((await cacheGet<{ id: string }[]>('bfs:s1'))!.value.map((f) => f.id)).toEqual(['bf-1', 'bf-2'])
  })

  it('savePatient 只更新单条缓存（不走列表）', async () => {
    const p = makePatient({ id: 'p1', name: '张三' })

    await cachedCloudRepository.savePatient(p)

    expect(cloud.savePatient).toHaveBeenCalledWith(p)
    expect((await cacheGet<typeof p>('patient:p1'))?.value).toEqual(p)
  })

  it('replaceAdverseReactions 用新数组整体覆盖缓存', async () => {
    await cacheSet('ars:s1', [makeReaction({ id: 'old', sessionId: 's1' })])
    const next = [makeReaction({ id: 'a1', sessionId: 's1' }), makeReaction({ id: 'a2', sessionId: 's1' })]

    await cachedCloudRepository.replaceAdverseReactions('s1', next)

    expect(cloud.replaceAdverseReactions).toHaveBeenCalledWith('s1', next)
    expect((await cacheGet<typeof next>('ars:s1'))?.value).toEqual(next)
  })

  it('replaceAdverseReactions 传空数组时缓存也被清空', async () => {
    await cacheSet('ars:s1', [makeReaction({ id: 'old', sessionId: 's1' })])

    await cachedCloudRepository.replaceAdverseReactions('s1', [])

    expect((await cacheGet<unknown[]>('ars:s1'))?.value).toEqual([])
  })
})

describe('cachedRepository · 删除', () => {
  /** 铺一条 session 的五类缓存 */
  async function seedSessionCache(id = 's1', patientId = 'p1') {
    await cacheSet(`session:${id}`, makeSession({ id, patientId }))
    await cacheSet(`bps:${id}`, [makeBp({ id: `bp-${id}`, sessionId: id })])
    await cacheSet(`bgs:${id}`, [makeBg({ id: `bg-${id}`, sessionId: id })])
    await cacheSet(`bfs:${id}`, [makeBf({ id: `bf-${id}`, sessionId: id })])
    await cacheSet(`ars:${id}`, [makeReaction({ id: `ar-${id}`, sessionId: id })])
    await cacheSet(`sessions:${patientId}`, [
      makeSession({ id, patientId, date: '2024-05-01' }),
      makeSession({ id: 'other', patientId, date: '2024-01-01' }),
    ])
  }

  it('deleteSession 清掉 session/bps/bgs/bfs/ars 五类缓存，并从 sessions 列表移除', async () => {
    await seedSessionCache('s1', 'p1')

    await cachedCloudRepository.deleteSession('s1')

    expect(cloud.deleteSession).toHaveBeenCalledWith('s1')
    expect(await cacheGet('session:s1')).toBeNull()
    expect(await cacheGet('bps:s1')).toBeNull()
    expect(await cacheGet('bgs:s1')).toBeNull()
    expect(await cacheGet('bfs:s1')).toBeNull()
    expect(await cacheGet('ars:s1')).toBeNull()
    const list = (await cacheGet<{ id: string }[]>('sessions:p1'))!.value
    expect(list.map((s) => s.id)).toEqual(['other'])
  })

  it('云端删除失败时抛错，且五类缓存与列表都保持原样（不提前清缓存）', async () => {
    await seedSessionCache('s1', 'p1')
    cloud.deleteSession.mockRejectedValue(new Error('删除被拒绝'))

    await expect(cachedCloudRepository.deleteSession('s1')).rejects.toThrow('删除被拒绝')

    expect((await cacheGet('session:s1'))?.value).toBeTruthy()
    expect((await cacheGet('bps:s1'))?.value).toHaveLength(1)
    expect((await cacheGet('bgs:s1'))?.value).toHaveLength(1)
    expect((await cacheGet('bfs:s1'))?.value).toHaveLength(1)
    expect((await cacheGet('ars:s1'))?.value).toHaveLength(1)
    expect((await cacheGet<{ id: string }[]>('sessions:p1'))!.value.map((s) => s.id)).toEqual(['s1', 'other'])
  })

  it('没有单条 session 缓存时也能从 sessions 列表里摘掉（回归：曾经取不到 patientId 就整段跳过，页面残留幽灵记录）', async () => {
    await cacheSet('sessions:p1', [
      makeSession({ id: 's1', patientId: 'p1', date: '2024-05-01' }),
      makeSession({ id: 'other', patientId: 'p1', date: '2024-01-01' }),
    ])
    // 刻意不写 session:s1：它可能刚被清理过，或用户是直接从列表进的详情页

    await expect(cachedCloudRepository.deleteSession('s1')).resolves.toBeUndefined()

    expect(cloud.deleteSession).toHaveBeenCalledWith('s1')
    expect(await cacheGet('session:s1')).toBeNull() // 删单条缓存这一步照旧发生（这里本来就没缓存）
    expect((await cacheGet<{ id: string }[]>('sessions:p1'))!.value.map((s) => s.id)).toEqual(['other'])
  })

  it('扫遍所有 sessions: 前缀的列表缓存：同一个 id 出现在多份列表里一并摘掉，别的前缀不动', async () => {
    await cacheSet('sessions:p1', [makeSession({ id: 's1', patientId: 'p1' })])
    await cacheSet('sessions:p2', [
      makeSession({ id: 's1', patientId: 'p2' }),
      makeSession({ id: 's2', patientId: 'p2' }),
    ])
    await cacheSet('dryWeights:p2', [makeDryWeight({ id: 'd1', patientId: 'p2' })])

    await cachedCloudRepository.deleteSession('s1')

    expect((await cacheGet<{ id: string }[]>('sessions:p1'))!.value).toEqual([])
    expect((await cacheGet<{ id: string }[]>('sessions:p2'))!.value.map((s) => s.id)).toEqual(['s2'])
    // 只动 sessions: 前缀的列表，干体重列表原样
    expect((await cacheGet<{ id: string }[]>('dryWeights:p2'))!.value.map((d) => d.id)).toEqual(['d1'])
  })

  it('列表里本来就没有这条 id 时不会被重写（updatedAt 不变）', async () => {
    await cacheSet('sessions:p1', [makeSession({ id: 'other', patientId: 'p1' })])
    const before = (await cacheGet<unknown[]>('sessions:p1'))!.updatedAt

    await expect(cachedCloudRepository.deleteSession('s-not-exist')).resolves.toBeUndefined()

    const after = await cacheGet<unknown[]>('sessions:p1')
    expect(after!.updatedAt).toBe(before)
    expect(after!.value).toHaveLength(1)
  })

  it('单条 session 缓存存在、但 sessions 列表缓存缺失时不报错', async () => {
    await cacheSet('session:s1', makeSession({ id: 's1', patientId: 'p1' }))
    // 故意不写 sessions:p1 列表缓存

    await expect(cachedCloudRepository.deleteSession('s1')).resolves.toBeUndefined()

    expect(await cacheGet('session:s1')).toBeNull()
    expect(await cacheGet('sessions:p1')).toBeNull()
  })

  it('deleteDryWeight 从所有 dryWeights: 前缀的列表里移除该项', async () => {
    await cacheSet('dryWeights:p1', [
      makeDryWeight({ id: 'd1', patientId: 'p1' }),
      makeDryWeight({ id: 'd2', patientId: 'p1' }),
    ])
    await cacheSet('dryWeights:p2', [makeDryWeight({ id: 'd1', patientId: 'p2' })])

    await cachedCloudRepository.deleteDryWeight('d1')

    expect(cloud.deleteDryWeight).toHaveBeenCalledWith('d1')
    expect((await cacheGet<{ id: string }[]>('dryWeights:p1'))!.value.map((d) => d.id)).toEqual(['d2'])
    expect((await cacheGet<{ id: string }[]>('dryWeights:p2'))!.value).toEqual([])
  })

  it('deleteBloodPressure 从多个 session 的 bps: 列表里移除，别的 id 保留', async () => {
    await cacheSet('bps:s1', [makeBp({ id: 'bp1', sessionId: 's1' }), makeBp({ id: 'bp2', sessionId: 's1' })])
    await cacheSet('bps:s2', [makeBp({ id: 'bp1', sessionId: 's2' })])

    await cachedCloudRepository.deleteBloodPressure('bp1')

    expect((await cacheGet<{ id: string }[]>('bps:s1'))!.value.map((b) => b.id)).toEqual(['bp2'])
    expect((await cacheGet<{ id: string }[]>('bps:s2'))!.value).toEqual([])
  })

  it('deleteBloodGlucose / deleteBloodFlow 同理（各自前缀）', async () => {
    await cacheSet('bgs:s1', [makeBg({ id: 'bg1', sessionId: 's1' }), makeBg({ id: 'bg2', sessionId: 's1' })])
    await cacheSet('bfs:s1', [makeBf({ id: 'bf1', sessionId: 's1' })])

    await cachedCloudRepository.deleteBloodGlucose('bg1')
    await cachedCloudRepository.deleteBloodFlow('bf1')

    expect((await cacheGet<{ id: string }[]>('bgs:s1'))!.value.map((g) => g.id)).toEqual(['bg2'])
    expect((await cacheGet<{ id: string }[]>('bfs:s1'))!.value).toEqual([])
  })

  it('云端删除失败时 deleteBloodPressure 不清缓存', async () => {
    await cacheSet('bps:s1', [makeBp({ id: 'bp1', sessionId: 's1' })])
    cloud.deleteBloodPressure.mockRejectedValue(new Error('失败'))

    await expect(cachedCloudRepository.deleteBloodPressure('bp1')).rejects.toThrow('失败')

    expect((await cacheGet<{ id: string }[]>('bps:s1'))!.value.map((b) => b.id)).toEqual(['bp1'])
  })

  it('删除只在缓存里存在、但前缀下没有该 id 的列表不会被重写', async () => {
    await cacheSet('bps:s1', [makeBp({ id: 'bp-other', sessionId: 's1' })])
    // 记录写入时刻，用于判断是否被重写
    const before = (await cacheGet<unknown[]>('bps:s1'))!.updatedAt

    await cachedCloudRepository.deleteBloodPressure('bp-not-exist')

    const after = await cacheGet<unknown[]>('bps:s1')
    expect(after!.updatedAt).toBe(before)
    expect(after!.value).toHaveLength(1)
  })

  it('前缀下的缓存行本身损坏时跳过它，不抛错、不影响其它列表', async () => {
    // 'bps:broken' 是非法的 JSON：cacheKeysByPrefix 能列出 key，但 cacheGet 返回 null
    await putRawCacheValue('bps:broken', '{不是 JSON', Date.now())
    await cacheSet('bps:s1', [makeBp({ id: 'bp1', sessionId: 's1' })])

    await expect(cachedCloudRepository.deleteBloodPressure('bp1')).resolves.toBeUndefined()

    expect((await cacheGet<{ id: string }[]>('bps:s1'))!.value).toEqual([])
    expect(await cacheGet('bps:broken')).toBeNull()
  })
})

describe('cachedRepository · 导入导出直接透传', () => {
  it('exportAll 走云端，不读缓存', async () => {
    cloud.exportAll.mockResolvedValue('{"version":1,"exportedAt":1}')

    const json = await cachedCloudRepository.exportAll()

    expect(json).toBe('{"version":1,"exportedAt":1}')
    expect(cloud.exportAll).toHaveBeenCalledTimes(1)
  })

  it('importAll 原样透传参数并向上抛错（云端不支持导入）', async () => {
    cloud.importAll.mockRejectedValue(new Error('云端模式无需导入，数据已保存在云端'))

    await expect(cachedCloudRepository.importAll('{}')).rejects.toThrow('云端模式无需导入')
    expect(cloud.importAll).toHaveBeenCalledWith('{}')
  })

  it('缓存清理不影响透传接口（导出前清空缓存仍能拿到云端数据）', async () => {
    await cacheClear()
    cloud.exportAll.mockResolvedValue('{"version":1}')

    expect(await cachedCloudRepository.exportAll()).toBe('{"version":1}')
    expect(await cacheKeysByPrefix('')).toEqual([])
  })
})

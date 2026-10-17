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
import { watch } from 'vue'
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
  listBloodPressuresMany: vi.fn(),
  saveBloodPressure: vi.fn(),
  deleteBloodPressure: vi.fn(),
  listBloodGlucoses: vi.fn(),
  listBloodGlucosesMany: vi.fn(),
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
import {
  cacheGet,
  cacheSet,
  cacheKeysByPrefix,
  cacheClear,
  cacheVersion,
  isBatchRefreshing,
  FRESH_MS,
} from '../../src/lib/cloudCache'

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
  cloud.listBloodPressuresMany.mockResolvedValue([])
  cloud.saveBloodPressure.mockResolvedValue(undefined)
  cloud.deleteBloodPressure.mockResolvedValue(undefined)
  cloud.listBloodGlucoses.mockResolvedValue([])
  cloud.listBloodGlucosesMany.mockResolvedValue([])
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

/**
 * 请求风暴回归（用户反馈「web 端长期打开后手机发烫、耗电激增」的根因）
 *
 * 实测：模拟 800ms 网络延迟后打开趋势页，30 秒内打出 **131614 个请求**
 * （血压 63028 次 + 血糖 62603 次），页面停不下来。链路是：
 * 命中陈旧缓存 → 每个 key 发起后台刷新 → 刷新成功让 cacheVersion 自增 →
 * 页面 watch 到就重新 load → 重新 load 时**还在途**的 key 依旧是陈旧的
 * （FRESH_MS 只看「上次写入时间」，管不住在途）→ 再次发起刷新 → 又自增……
 *
 * 修法是在 cloudCache 里给每个 key 的刷新加「在途去重」。下面两个用例是防线。
 */
describe('cachedRepository · 请求风暴（在途去重）', () => {
  it('刷新还在途中时反复读取同一个 key，只会发出一次请求', async () => {
    const oldList = [makeSession({ id: 'old', patientId: 'p1' })]
    await putRawCache('sessions:p1', oldList, 0)

    let release: (v: unknown[]) => void = () => {}
    cloud.listSessions.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve as (v: unknown[]) => void
        }),
    )

    // 页面在「上次刷新还没回来」的窗口里反复重读（watch(cacheVersion) → refresh）
    for (let i = 0; i < 20; i++) {
      expect(await cachedCloudRepository.listSessions('p1')).toEqual(oldList)
    }

    expect(cloud.listSessions).toHaveBeenCalledTimes(1)

    release([])
    await flushAsync()

    // 刷新落地后缓存变新鲜，继续读也不会再发请求
    for (let i = 0; i < 20; i++) await cachedCloudRepository.listSessions('p1')
    expect(cloud.listSessions).toHaveBeenCalledTimes(1)
  })

  it('30 个子表 key 全部陈旧时，页面重读循环不会把请求放大（修复前是 30+29+28… 的平方级增长）', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `s${i}`)
    for (const id of ids) await putRawCache(`bps:${id}`, [], Date.now() - FRESH_MS - 1000)

    // 每次请求 5ms：制造出「刷新在途时页面又重读」的窗口（弱网下这个窗口很长，所以会失控）
    cloud.listBloodPressures.mockImplementation(
      (sessionId: string) =>
        new Promise((resolve) => setTimeout(() => resolve([makeBp({ id: `bp-${sessionId}`, sessionId })]), 5)),
    )

    // 趋势页的写法：watch(cacheVersion, load) —— 任何 key 刷新成功都会让它重跑
    const loadAll = () => Promise.all(ids.map((id) => cachedCloudRepository.listBloodPressures(id)))
    const stop = watch(cacheVersion, () => {
      void loadAll()
    })

    await loadAll()
    await new Promise((resolve) => setTimeout(resolve, 300))
    stop()

    // 每个 key 最多一次：修复前这里会是几百次（且随网络变慢无限增长）
    expect(cloud.listBloodPressures).toHaveBeenCalledTimes(ids.length)
  })
})

describe('cachedRepository · 批量读取子表（趋势页一次拉回 30 条记录的血压/血糖）', () => {
  it('没有缓存时合并成一次批量请求，并按 session 分组回填各自的缓存 key', async () => {
    cloud.listBloodPressuresMany.mockResolvedValue([
      makeBp({ id: 'bp1', sessionId: 's1' }),
      makeBp({ id: 'bp2', sessionId: 's2' }),
      makeBp({ id: 'bp3', sessionId: 's2' }),
    ])

    const got = await cachedCloudRepository.listBloodPressuresMany(['s1', 's2', 's3'])

    expect(cloud.listBloodPressuresMany).toHaveBeenCalledTimes(1)
    expect(cloud.listBloodPressuresMany).toHaveBeenCalledWith(['s1', 's2', 's3'])
    expect(got.map((x) => x.id)).toEqual(['bp1', 'bp2', 'bp3'])
    // 分组回填：详情页随后打开这些记录时直接命中缓存
    expect((await cacheGet<unknown[]>('bps:s1'))?.value).toHaveLength(1)
    expect((await cacheGet<unknown[]>('bps:s2'))?.value).toHaveLength(2)
    // 确实没有数据的 session 也要写空数组，否则每次都会重新拉它
    expect((await cacheGet<unknown[]>('bps:s3'))?.value).toEqual([])
    expect(cloud.listBloodPressures).not.toHaveBeenCalled()
  })

  it('全部命中新鲜缓存时不发任何请求', async () => {
    await cacheSet('bgs:s1', [makeBg({ id: 'bg1', sessionId: 's1' })])
    await cacheSet('bgs:s2', [])

    const got = await cachedCloudRepository.listBloodGlucosesMany(['s1', 's2'])

    expect(got.map((x) => x.id)).toEqual(['bg1'])
    expect(cloud.listBloodGlucosesMany).not.toHaveBeenCalled()
  })

  it('陈旧缓存先用旧值渲染，再补一次批量后台刷新（而不是逐个 key 发请求）', async () => {
    await putRawCache('bps:s1', [makeBp({ id: 'old', sessionId: 's1' })], 0)
    await putRawCache('bps:s2', [makeBp({ id: 'old2', sessionId: 's2' })], 0)
    cloud.listBloodPressuresMany.mockResolvedValue([
      makeBp({ id: 'new1', sessionId: 's1' }),
      makeBp({ id: 'new2', sessionId: 's2' }),
    ])
    const versionBefore = cacheVersion.value

    const got = await cachedCloudRepository.listBloodPressuresMany(['s1', 's2'])

    expect(got.map((x) => x.id)).toEqual(['old', 'old2'])
    await vi.waitFor(() => expect(cacheVersion.value).toBe(versionBefore + 1))
    expect(cloud.listBloodPressuresMany).toHaveBeenCalledTimes(1)
    expect(cloud.listBloodPressures).not.toHaveBeenCalled()
    expect((await cacheGet<unknown[]>('bps:s1'))?.value).toEqual([makeBp({ id: 'new1', sessionId: 's1' })])
  })

  it('批量刷新在途时重复读取不会再发一次（同一条防线）', async () => {
    await putRawCache('bps:s1', [makeBp({ id: 'old', sessionId: 's1' })], 0)

    let release: (v: unknown[]) => void = () => {}
    cloud.listBloodPressuresMany.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve as (v: unknown[]) => void
        }),
    )

    for (let i = 0; i < 10; i++) await cachedCloudRepository.listBloodPressuresMany(['s1'])

    expect(cloud.listBloodPressuresMany).toHaveBeenCalledTimes(1)
    release([])
    await flushAsync()
  })

  it('批量请求失败时向调用方抛错（趋势页要能显示失败态，而不是静默显示「暂无数据」）', async () => {
    cloud.listBloodPressuresMany.mockRejectedValue(new Error('查询失败（血压）：Failed to fetch'))

    await expect(cachedCloudRepository.listBloodPressuresMany(['s1'])).rejects.toThrow('查询失败')
  })

  /**
   * 回归：批量刷新在途时，单条读**不能复用它的返回值** —— 那是整批数据。
   *
   * `shareRefresh` 把「在刷」登记到它覆盖的每个 key 上（这是防请求风暴的关键），
   * 但批量任务的返回值是**整批**：如果单条读直接拿它当自己的值，
   * 详情页「血压 (N)」就会混进其他透析日的血压 —— 类型相同、语义不同，TS 拦不住。
   * 触发窗口是弱网下的 1~3 秒，场景就是「趋势页正在加载时点进某条记录」。
   */
  it('批量刷新在途时，单条读只能拿到自己那条记录的数据（不能复用整批的返回值）', async () => {
    let release: (v: unknown[]) => void = () => {}
    cloud.listBloodPressuresMany.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve as (v: unknown[]) => void
        }),
    )
    cloud.listBloodPressures.mockResolvedValue([makeBp({ id: 'single-s1', sessionId: 's1' })])

    // 趋势页发起批量刷新（在途），此刻详情页读 s1
    void cachedCloudRepository.listBloodPressuresMany(['s1', 's2'])
    // 等批量真的把这批 key 登记成「在刷」再继续（注册要经过几轮 IndexedDB 异步）
    await vi.waitFor(() => {
      expect(isBatchRefreshing('bps:s1')).toBe(true)
    })

    const pending = cachedCloudRepository.listBloodPressures('s1')
    await flushAsync()

    release([
      makeBp({ id: 'batch-s1', sessionId: 's1' }),
      makeBp({ id: 'batch-s2', sessionId: 's2' }),
    ])
    const got = await pending

    // 核心：s1 的详情页绝不能出现 s2 的血压。
    // 修复前这里会直接复用批量任务的返回值（整批），于是 s1 页面上混进 s2 的数据 ——
    // 类型相同、语义不同，TypeScript 拦不住；触发窗口就是弱网下那 1~3 秒。
    expect(got.map((x) => x.id)).not.toContain('batch-s2')
    expect(got.every((x) => x.sessionId === 's1')).toBe(true)
    expect(got).toHaveLength(1)
  })

  /**
   * 回归：800ms 弱网修掉之后，把延迟提到 3 秒（= FRESH_MS）仍会「每 3.2 秒刷一轮、几十秒不停」。
   *
   * 根因是批量刷新只用一个「这一批的 id 列表」当去重键 —— 写回是逐个 key 落库的，
   * 写到一半时页面因别的刷新重读，看到的陈旧集合少几个 id、键就变了，于是又发一次，
   * 无限循环。现在改成按 key 登记在途，任何读路径看到的都是「这个 key 正在刷新」。
   */
  it('批量刷新在途时，单条读取同一个 key 也不会再发一次请求（跨路径共用「在刷」登记）', async () => {
    await putRawCache('bps:s1', [makeBp({ id: 'old', sessionId: 's1' })], 0)

    let release: (v: unknown[]) => void = () => {}
    cloud.listBloodPressuresMany.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve as (v: unknown[]) => void
        }),
    )

    // 趋势页发起批量刷新（在途），此刻详情页/别的路径读同一条记录
    void cachedCloudRepository.listBloodPressuresMany(['s1'])
    await flushAsync()

    const got = await cachedCloudRepository.listBloodPressures('s1')
    expect(got.map((x) => x.id)).toEqual(['old'])
    await flushAsync()

    // 没有额外的单条请求，也没有第二次批量请求
    expect(cloud.listBloodPressures).not.toHaveBeenCalled()
    expect(cloud.listBloodPressuresMany).toHaveBeenCalledTimes(1)

    release([])
    await flushAsync()
  })

  it('批量刷新在途时，页面反复重读批量接口始终只发一次', async () => {
    const ids = ['s1', 's2', 's3']
    for (const id of ids) await putRawCache(`bgs:${id}`, [makeBg({ id: `old-${id}`, sessionId: id })], 0)

    let release: (v: unknown[]) => void = () => {}
    cloud.listBloodGlucosesMany.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve as (v: unknown[]) => void
        }),
    )

    // 模拟「写回途中页面被别的缓存刷新唤醒、又重读一轮」：拿到的陈旧集合每轮都可能少几个 id
    for (let round = 0; round < 5; round++) {
      const got = await cachedCloudRepository.listBloodGlucosesMany(ids)
      expect(got.map((x) => x.id)).toEqual(['old-s1', 'old-s2', 'old-s3'])
      await flushAsync()
    }

    expect(cloud.listBloodGlucosesMany).toHaveBeenCalledTimes(1)
    release([])
    await flushAsync()
  })

  /**
   * 边界：某条记录正被别的路径（例如详情页的单条读）刷新时，批量读不能把它算进自己这一批 ——
   * 否则 shareRefresh 会复用到别人的任务，按那个（只覆盖部分 key 的）结果写回，
   * 会把没请求到的 key 写成空数组，页面显示「暂无数据」。
   */
  it('某条记录正被别的路径刷新时，批量读不会把它的缓存写成空数组', async () => {
    await putRawCache('bps:s1', [makeBp({ id: 'old-1', sessionId: 's1' })], 0)
    await putRawCache('bps:s2', [makeBp({ id: 'old-2', sessionId: 's2' })], 0)

    let releaseSingle: (v: unknown[]) => void = () => {}
    cloud.listBloodPressures.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSingle = resolve as (v: unknown[]) => void
        }),
    )
    cloud.listBloodPressuresMany.mockResolvedValue([makeBp({ id: 'new-2', sessionId: 's2' })])

    // 详情页先给 s1 发起单条刷新（在途）
    void cachedCloudRepository.listBloodPressures('s1')
    await flushAsync()

    const got = await cachedCloudRepository.listBloodPressuresMany(['s1', 's2'])

    // 两条都先用旧值渲染（陈旧刷新的新值是后台写回的，不阻塞这次返回）
    expect(got.map((x) => x.id)).toEqual(['old-1', 'old-2'])
    // 关键：批量请求只带没被接手的 s2，不能把在途的 s1 也算进来
    expect(cloud.listBloodPressuresMany).toHaveBeenCalledWith(['s2'])

    await vi.waitFor(async () => {
      expect((await cacheGet<unknown[]>('bps:s2'))?.value).toEqual([makeBp({ id: 'new-2', sessionId: 's2' })])
    })
    // s1 的缓存不能被批量结果（只含 s2）覆盖成空
    expect((await cacheGet<unknown[]>('bps:s1'))?.value).toHaveLength(1)

    releaseSingle([])
    await flushAsync()
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

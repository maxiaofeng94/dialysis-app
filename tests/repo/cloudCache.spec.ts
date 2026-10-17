/**
 * cloudCache（云端数据本地缓存）测试
 *
 * cloudCache 没有导出自己的 Dexie 实例，所以这里用原生 IndexedDB 直接读原始行 /
 * 写「损坏数据」。注意 Dexie 的内部版本号是十进制编码（version(1) → IDB 版本 10），
 * 因此原生打开时**不能指定版本号**，只能打开当前版本；库的创建交给 beforeEach 里
 * 的 cacheClear()（它会触发 Dexie 首次打开并建表）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  cacheGet,
  cacheSet,
  cacheStale,
  cacheDelete,
  cacheKeysByPrefix,
  cacheClear,
  cacheVersion,
  dedupe,
  shareRefresh,
  isRefreshing,
  isBatchRefreshing,
  cacheFirstWithRevalidate,
  WAIT_INFLIGHT_MS,
  FRESH_MS,
} from '../../src/lib/cloudCache'

interface RawRow {
  key: string
  value: string
  updatedAt: number
}

/** 直接操作底层库（dialysis-cloud-cache 的 kv 表），绕过 cloudCache 封装 */
function withKvStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('dialysis-cloud-cache')
    req.onupgradeneeded = () => {
      const idb = req.result
      if (!idb.objectStoreNames.contains('kv')) idb.createObjectStore('kv', { keyPath: 'key' })
    }
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const idb = req.result
      const tx = idb.transaction('kv', mode)
      let out: T | undefined
      const r = fn(tx.objectStore('kv'))
      if (r) r.onsuccess = () => (out = r.result)
      tx.oncomplete = () => {
        idb.close()
        resolve(out)
      }
      tx.onerror = () => {
        idb.close()
        reject(tx.error)
      }
      tx.onabort = () => {
        idb.close()
        reject(tx.error)
      }
    }
  })
}

/** 往 kv 表里塞原始行（用于制造损坏数据 / 指定 updatedAt） */
const rawPut = (row: RawRow) => withKvStore('readwrite', (s) => s.put(row))
/** 读原始行（用于断言落库内容） */
const rawGet = (key: string) => withKvStore<RawRow>('readonly', (s) => s.get(key))

beforeEach(async () => {
  // 触发 Dexie 打开/建库并清空缓存；这里会自增一次 cacheVersion，
  // 所以所有涉及 cacheVersion 的断言都用「相对增量」，不写死绝对值。
  await cacheClear()
})

describe('cloudCache · 存取往返', () => {
  it('cacheSet / cacheGet 往返对象（含嵌套结构）', async () => {
    const value = { id: 'p1', nested: { list: [1, 2, 3], flag: true } }
    await cacheSet('patient:p1', value)

    const entry = await cacheGet<typeof value>('patient:p1')
    expect(entry?.value).toEqual(value)
    expect(typeof entry?.updatedAt).toBe('number')
  })

  it('cacheSet / cacheGet 往返数组与原始值', async () => {
    await cacheSet('list', [{ id: 'a' }, { id: 'b' }])
    await cacheSet('num', 42)

    expect((await cacheGet<{ id: string }[]>('list'))?.value).toEqual([{ id: 'a' }, { id: 'b' }])
    expect((await cacheGet<number>('num'))?.value).toBe(42)
  })

  it('显式缓存 null 也视为「命中」：返回 entry（value 为 null），不是未命中', async () => {
    await cacheSet('nullable', null)

    const entry = await cacheGet<null>('nullable')
    expect(entry).not.toBeNull()
    expect(entry?.value).toBeNull()
  })

  it('未写入的 key 返回 null', async () => {
    expect(await cacheGet('从未写过')).toBeNull()
  })

  it('updatedAt 是写入时刻的毫秒时间戳', async () => {
    const before = Date.now()
    await cacheSet('k', 'v')
    const after = Date.now()

    const entry = await cacheGet('k')
    expect(entry!.updatedAt).toBeGreaterThanOrEqual(before)
    expect(entry!.updatedAt).toBeLessThanOrEqual(after)
  })

  it('同 key 覆盖写：值被替换、updatedAt 刷新、库里只有一行', async () => {
    await rawPut({ key: 'k', value: '"旧值"', updatedAt: 1 })
    await cacheSet('k', '新值')

    const entry = await cacheGet<string>('k')
    expect(entry?.value).toBe('新值')
    expect(entry!.updatedAt).toBeGreaterThan(1)
    expect(await cacheKeysByPrefix('k')).toEqual(['k'])
  })

  it('落库的是 JSON 文本（便于人工排查），不是对象引用', async () => {
    await cacheSet('k', { a: 1 })

    const row = await rawGet('k')
    expect(row?.value).toBe('{"a":1}')
  })
})

describe('cloudCache · 损坏数据容错', () => {
  it('缓存里是非法的 JSON 时 cacheGet 返回 null 且不抛错', async () => {
    await rawPut({ key: 'broken', value: '{不是合法 JSON', updatedAt: Date.now() })

    await expect(cacheGet('broken')).resolves.toBeNull()
  })

  it('空字符串值同样按损坏处理（JSON.parse 抛错 → null）', async () => {
    await rawPut({ key: 'empty', value: '', updatedAt: Date.now() })

    await expect(cacheGet('empty')).resolves.toBeNull()
  })

  it('一个 key 损坏不影响其它 key 的读取', async () => {
    await rawPut({ key: 'broken', value: 'oops', updatedAt: Date.now() })
    await cacheSet('ok', 'fine')

    expect(await cacheGet('broken')).toBeNull()
    expect((await cacheGet<string>('ok'))?.value).toBe('fine')
  })
})

describe('cloudCache · cacheStale 标记过期', () => {
  it('cacheStale 把 updatedAt 置 0，但保留原值', async () => {
    await cacheSet('sessions:p1', [{ id: 's1' }])

    await cacheStale('sessions:p1')

    const entry = await cacheGet<{ id: string }[]>('sessions:p1')
    expect(entry!.updatedAt).toBe(0)
    expect(entry!.value).toEqual([{ id: 's1' }])
  })

  it('cacheStale 支持数组形式，且对不存在的 key 静默忽略', async () => {
    await cacheSet('a', 1)
    await cacheSet('b', 2)

    await expect(cacheStale(['a', 'b', '不存在'])).resolves.toBeUndefined()

    expect((await cacheGet('a'))!.updatedAt).toBe(0)
    expect((await cacheGet('b'))!.updatedAt).toBe(0)
  })
})

describe('cloudCache · cacheDelete', () => {
  it('删除单个 key 后读取返回 null，其它 key 不受影响', async () => {
    await cacheSet('a', 1)
    await cacheSet('b', 2)

    await cacheDelete('a')

    expect(await cacheGet('a')).toBeNull()
    expect((await cacheGet('b'))?.value).toBe(2)
  })

  it('删除数组内的多个 key，忽略不存在项', async () => {
    await cacheSet('a', 1)
    await cacheSet('b', 2)
    await cacheSet('c', 3)

    await expect(cacheDelete(['a', 'c', '不存在'])).resolves.toBeUndefined()

    expect(await cacheGet('a')).toBeNull()
    expect(await cacheGet('c')).toBeNull()
    expect((await cacheGet('b'))?.value).toBe(2)
  })
})

describe('cloudCache · cacheKeysByPrefix', () => {
  it('按前缀命中，不匹配其它前缀，也不误伤「同前缀但无冒号」的 key', async () => {
    await cacheSet('bps:a', 1)
    await cacheSet('bps:b', 2)
    await cacheSet('bgs:c', 3)
    await cacheSet('bpsx:d', 4)

    expect((await cacheKeysByPrefix('bps:')).sort()).toEqual(['bps:a', 'bps:b'])
    expect((await cacheKeysByPrefix('bgs:')).sort()).toEqual(['bgs:c'])
    expect((await cacheKeysByPrefix('bps')).sort()).toEqual(['bps:a', 'bps:b', 'bpsx:d'])
  })

  it('无匹配前缀返回空数组；空前缀返回全部 key', async () => {
    await cacheSet('a', 1)
    await cacheSet('b', 2)

    expect(await cacheKeysByPrefix('zzz:')).toEqual([])
    expect((await cacheKeysByPrefix('')).sort()).toEqual(['a', 'b'])
  })

  it('底层 IndexedDB 抛错时返回空数组而不是把异常抛给调用方', async () => {
    await cacheSet('bps:a', 1)
    // Dexie 的 primaryKeys() 最终落到 IDBObjectStore.getAllKeys，这里让它直接抛错
    const spy = vi.spyOn(IDBObjectStore.prototype, 'getAllKeys').mockImplementation(() => {
      throw new Error('IndexedDB 不可用')
    })
    try {
      await expect(cacheKeysByPrefix('bps:')).resolves.toEqual([])
    } finally {
      spy.mockRestore()
    }
    // 恢复后仍能正常读取
    expect(await cacheKeysByPrefix('bps:')).toEqual(['bps:a'])
  })
})

describe('cloudCache · cacheClear', () => {
  it('清空全部缓存并让 cacheVersion 自增一次', async () => {
    await cacheSet('a', 1)
    await cacheSet('b', 2)
    const before = cacheVersion.value

    await cacheClear()

    expect(cacheVersion.value).toBe(before + 1)
    expect(await cacheKeysByPrefix('')).toEqual([])
    expect(await cacheGet('a')).toBeNull()
    expect(await cacheGet('b')).toBeNull()
  })

  it('缓存本来就空时依然自增（页面可据此重新读取）', async () => {
    const before = cacheVersion.value

    await cacheClear()

    expect(cacheVersion.value).toBe(before + 1)
  })

  /**
   * 登出后再登录同一账号时缓存 key 是一样的（`sessions:<同一个 pid>`）。
   * 在途表不清的话，`dedupe` 会复用登出前那个**带旧 token** 的请求 —— 回来 401，
   * 首屏直接显示「加载失败，请检查网络后重试」。
   */
  it('作废在途刷新登记（否则重登后会复用带旧 token 的请求）', async () => {
    let release: (v: string[]) => void = () => {}
    const pending = dedupe('sessions:p1', () => new Promise<string[]>((resolve) => (release = resolve)))
    expect(isRefreshing('sessions:p1')).toBe(true)

    await cacheClear()

    expect(isRefreshing('sessions:p1')).toBe(false)
    expect(isBatchRefreshing('sessions:p1')).toBe(false)
    release([])
    await pending
  })
})

/**
 * 批量刷新与单条读的相互作用。
 *
 * 这一组用**纯内存、无 IndexedDB** 的确定性时序：先把批量任务挂起，
 * 再在同一个 key 上发起单条读，最后才让批量完成。
 * 之前那条集成用例（`cachedRepository.spec.ts`）依赖宏任务轮数，
 * `release()` 常常抢在单条读之前，于是**修复前也照样绿** —— 等于没有防线。
 */
describe('cloudCache · 批量任务与单条读（防串数据）', () => {
  it('批量在途时，同一个 key 的单条 dedupe 不会复用它的返回值', async () => {
    let releaseBatch: (v: string[]) => void = () => {}
    const batch = shareRefresh(['bps:s1'], () => new Promise<string[]>((resolve) => (releaseBatch = resolve)))
    expect(isBatchRefreshing('bps:s1')).toBe(true)

    // 关键时序：单条读必须在批量完成**之前**发起
    const single = dedupe('bps:s1', async () => ['only-mine'])

    releaseBatch(['b1', 'b2'])
    await batch

    // 修复前 dedupe 无条件复用 inflight → 这里会拿到 ['b1','b2']（30 条记录的血压混进单条）
    expect(await single).toEqual(['only-mine'])
  })

  it('单条任务在途时，同一个 key 的第二次 dedupe 复用它是安全的（同一个 loader 语义）', async () => {
    let calls = 0
    let release: (v: string) => void = () => {}
    const first = dedupe('k', () => {
      calls++
      return new Promise<string>((resolve) => (release = resolve))
    })
    const second = dedupe('k', async () => {
      calls++
      return 'second'
    })

    release('first')
    expect(await first).toBe('first')
    expect(await second).toBe('first') // 复用了同一个任务
    expect(calls).toBe(1)
  })

  it('一个 key 都没认领到（全被别的路径接手）时 shareRefresh 抛错，不拿别人的结果去写缓存', async () => {
    let release: (v: string[]) => void = () => {}
    const running = shareRefresh(['bps:s1'], () => new Promise<string[]>((resolve) => (release = resolve)))

    await expect(shareRefresh(['bps:s1'], async () => ['别人的结果'])).rejects.toThrow('已在刷新中')

    release(['ok'])
    await running
  })

  it('批量在途且超时未落库时，无缓存的单条读会自己发请求（不会永久挂起）', async () => {
    vi.useFakeTimers()
    try {
      // 批量任务永远不完成
      void shareRefresh(['bps:s1'], () => new Promise<string[]>(() => {}))
      expect(isBatchRefreshing('bps:s1')).toBe(true)

      const loader = vi.fn(async () => ['fresh'])
      const pending = cacheFirstWithRevalidate('bps:s1', loader)

      // 等到超过等待上限
      await vi.advanceTimersByTimeAsync(WAIT_INFLIGHT_MS + 100)

      expect(await pending).toEqual(['fresh'])
      expect(loader).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('cloudCache · 常量', () => {
  it('FRESH_MS 为 3000（3 秒内视为新鲜，避免 watch → 刷新 → watch 死循环）', () => {
    expect(FRESH_MS).toBe(3000)
  })
})

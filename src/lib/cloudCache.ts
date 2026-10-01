import Dexie, { type Table } from 'dexie'
import { ref } from 'vue'

/**
 * 云端数据的本地缓存（stale-while-revalidate 的基础设施）
 *
 * 思路：把云端拉到的数据顺手存一份到本机 IndexedDB。
 * - 下次打开页面时**先用缓存立即渲染**，不再干等网络；
 * - 同时后台静默请求云端，拿到新数据后写回缓存并让 cacheVersion 自增，
 *   页面 watch 到这个信号再读一次（此时命中刚写入的新缓存，无需等待网络）。
 *
 * 注意：登出时必须清空，否则换账号会看到上一个账号的数据。
 */

interface CacheRow {
  key: string
  value: string
  updatedAt: number
}

class CloudCacheDB extends Dexie {
  kv!: Table<CacheRow, string>

  constructor() {
    super('dialysis-cloud-cache')
    this.version(1).stores({ kv: 'key' })
  }
}

const db = new CloudCacheDB()

/** 后台刷新写入新数据后自增，页面 watch 它重新读取 */
export const cacheVersion = ref(0)

/** 距上次刷新小于该毫秒数视为「新鲜」，不再触发后台刷新（同时避免 watch → 刷新 → watch 的循环） */
export const FRESH_MS = 3000

export interface CacheEntry<T> {
  value: T
  updatedAt: number
}

export async function cacheGet<T>(key: string): Promise<CacheEntry<T> | null> {
  try {
    const row = await db.kv.get(key)
    if (!row) return null
    return { value: JSON.parse(row.value) as T, updatedAt: row.updatedAt }
  } catch {
    return null
  }
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
  try {
    await db.kv.put({ key, value: JSON.stringify(value), updatedAt: Date.now() })
  } catch {
    // 缓存失败不影响主流程
  }
}

/** 把某个 key 标记为过期（下次读取仍会先返回旧值，同时立即后台刷新） */
export async function cacheStale(keys: string | string[]): Promise<void> {
  const list = Array.isArray(keys) ? keys : [keys]
  try {
    await db.kv.where('key').anyOf(list).modify({ updatedAt: 0 })
  } catch {
    // ignore
  }
}

export async function cacheDelete(keys: string | string[]): Promise<void> {
  const list = Array.isArray(keys) ? keys : [keys]
  try {
    await db.kv.bulkDelete(list)
  } catch {
    // ignore
  }
}

/** 按前缀列出缓存 key（用于批量更新某一类列表，如 bps:xxx） */
export async function cacheKeysByPrefix(prefix: string): Promise<string[]> {
  try {
    return await db.kv.where('key').startsWith(prefix).primaryKeys()
  } catch {
    return []
  }
}

/** 清空全部云端缓存（登出、切换账号时调用） */
export async function cacheClear(): Promise<void> {
  try {
    await db.kv.clear()
    cacheVersion.value++
  } catch {
    // ignore
  }
}

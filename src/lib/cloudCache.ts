import Dexie, { type Table } from 'dexie'
import { ref } from 'vue'
import { withTimeout } from '../utils/timeout'

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

    // 同 db/database.ts：另一个标签页要求升级版本时主动让路，
    // 否则本页会卡在 blocked 状态 —— 所有缓存读写永久 pending，页面只剩骨架。
    this.on('versionchange', () => {
      this.close()
    })
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

/**
 * 在途刷新登记表（`dedupe` / `shareRefresh` 用）。
 *
 * `batch` 标记很关键：一次请求覆盖多个 key 的「批量刷新」，它的返回值是**整批**数据，
 * 不能当成其中某一个 key 的值（详情页会因此混进别的透析日的血压）。
 *
 * 声明放在 `cacheClear()` 之前：登出时也要清它。
 */
interface InflightEntry {
  promise: Promise<unknown>
  /** true = 批量任务（返回值覆盖多个 key，别拿它当单条结果用） */
  batch: boolean
}
const inflight = new Map<string, InflightEntry>()

/** 清空全部云端缓存（登出、切换账号时调用） */
export async function cacheClear(): Promise<void> {
  try {
    await db.kv.clear()
    // ⚠️ 在途刷新也必须作废：登出后再登录同一个账号时缓存 key 是一样的
    // （`sessions:<同一个 pid>`），留着旧 Promise 会让 dedupe 复用它 ——
    // 那次请求带的是**已经作废的 token**，回来 401，首屏直接显示「加载失败」。
    // 正在跑的请求取消不了，但至少后续读取会重新发起。
    inflight.clear()
    cacheVersion.value++
  } catch {
    // ignore
  }
}

/**
 * 同一个 key 的刷新只允许有一个在途任务，后来的调用直接复用。
 *
 * 没有这道去重会发生什么（实测复现）：趋势页一次加载要读「最近 30 条记录」的血压 / 血糖，
 * 命中陈旧缓存时每个 key 都会发起后台刷新；每个刷新成功又让 cacheVersion 自增，
 * 页面 watch 到就重新 load —— 而重新 load 时那些**还在途**的 key 依旧是陈旧的
 * （FRESH_MS 闸门只看「上次写入时间」，管不住在途），于是再次发起刷新、再自增、再 load……
 * 网络越慢越失控：把库请求延迟设为 800ms 后，趋势页 30 秒内打出了 **13 万个请求**
 * （血压 63028 次 + 血糖 62603 次），手机持续发烫、耗电激增就是这么来的。
 *
 * ⚠️ 只复用**单条**任务：批量任务在途时这里会另外发一次单条请求 —— 多一个请求，
 * 但换来的是「返回的一定是这个 key 自己的数据」。
 */
export function dedupe<T>(key: string, task: () => Promise<T>): Promise<T> {
  const running = inflight.get(key)
  if (running && !running.batch) return running.promise as Promise<T>
  // 声明成可空再赋值：finally 里要拿它跟表里的条目比对（`tsc -b` 会拦「变量在赋值前被使用」）
  let p: Promise<T> | undefined
  p = (async () => {
    try {
      return await task()
    } finally {
      // 成败都要摘掉，失败后下一次调用才有机会重试
      if (inflight.get(key)?.promise === p) inflight.delete(key)
    }
  })()
  inflight.set(key, { promise: p, batch: false })
  return p
}

/** 某个 key 是否正在后台刷新（批量请求会把「在刷」登记到它覆盖的每一个 key 上） */
export function isRefreshing(key: string): boolean {
  return inflight.has(key)
}

/** 某个 key 是否正被**批量**任务刷新（它的返回值是整批数据，不能当这个 key 的值） */
export function isBatchRefreshing(key: string): boolean {
  return inflight.get(key)?.batch === true
}

/** 取某个 key 正在进行的刷新（没有在途刷新时是 undefined），用于「等它写完再读」 */
export function refreshInFlight(key: string): Promise<unknown> | undefined {
  return inflight.get(key)?.promise
}

/** 等待「已经在跑的刷新」的上限：弱网下一趟请求 1~3 秒回来，封顶只是防彻底挂住把页面拖死 */
export const WAIT_INFLIGHT_MS = 5000

/**
 * 一次请求覆盖多个 key（如按 30 条记录批量拉血压）时，把「正在刷新」登记到**每个** key 上。
 *
 * 为什么不能只拿「这一批的 id 列表」当去重键：写回是逐个 key 落库的，
 * 写到一半时页面若因别的刷新重读，看到的陈旧集合就**少几个 id** —— 键一变，去重失效，
 * 于是又发一次批量请求；而它完成时又可能撞上下一次重读……实测把延迟设成 3 秒（= FRESH_MS）时，
 * 趋势页会稳定地每 3.2 秒刷一轮、几十秒都停不下来。按 key 登记后，任何一条读路径
 * （单条读、批量读、页面重读）看到的都是「这个 key 正在刷新」，不会重复发。
 *
 * 登记时打上 `batch: true`：单条读路径看到这个标记会改为「等它落库再读缓存」，
 * 而不是直接复用返回值（那样会把整批数据当成单条记录的数据）。
 *
 * ⚠️ 调用前请用 `isRefreshing` 把「已经在刷」的 key 滤掉（见 `cachedRepository.claim`）；
 * 若一个都没认领到（全被别的路径接手），这里会 reject 而不是拿别人的任务结果去写缓存。
 */
export function shareRefresh<T>(keys: string[], task: () => Promise<T>): Promise<T> {
  let running: Promise<T> | null = null
  const shared = (): Promise<T> => (running ??= task())
  const promises: Promise<unknown>[] = []
  let claimed = 0

  for (const key of keys) {
    const existing = inflight.get(key)
    if (existing) {
      promises.push(existing.promise)
      continue
    }
    claimed++
    let p: Promise<T> | undefined
    p = (async () => {
      try {
        return await shared()
      } finally {
        if (inflight.get(key)?.promise === p) inflight.delete(key)
      }
    })()
    inflight.set(key, { promise: p, batch: true })
    promises.push(p)
  }

  if (!claimed) {
    // 全部都被别的路径接手了：别人的任务覆盖范围未必和本次一致，
    // 拿它的结果去 writeBack 会把没请求到的 key 写成空数组 —— 交给调用方重新读缓存
    return Promise.reject(new Error('shareRefresh: 这批 key 都已在刷新中'))
  }

  return Promise.all(promises).then(() => shared())
}

/**
 * 缓存优先 + 后台刷新（stale-while-revalidate）的**统一读法**。
 *
 * `cachedRepository` 与 `cloudAdmin` 共用这一份实现：以前两边各写一遍，
 * 结果只有一边补上了 FRESH_MS 闸门、另一边补上了 error 检查，改完还会走散。
 */
export async function cacheFirstWithRevalidate<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const cached = await cacheGet<T>(key)
  if (cached) {
    // 新鲜度闸门 + 在途去重缺一不可：前者防「刚写完又刷」，后者防「并发/在途时重复刷」
    if (Date.now() - cached.updatedAt >= FRESH_MS && !isRefreshing(key)) {
      void dedupe(key, async () => {
        const value = await loader()
        await cacheSet(key, value)
        return value
      })
        .then(() => {
          cacheVersion.value++
        })
        .catch(() => {
          // 后台刷新失败就继续用旧缓存，不打扰用户
        })
    }
    return cached.value
  }

  // 没有缓存，但正被**批量任务**刷新：等它落库，然后读这个 key 自己的缓存。
  // 直接复用它的返回值会把整批数据当成这一条记录的数据（详情页「血压 (N)」里
  // 混进其他透析日的血压）—— 类型一样，TypeScript 拦不住。
  if (isBatchRefreshing(key)) {
    const running = refreshInFlight(key)
    if (running) {
      await withTimeout(running.catch(() => undefined), WAIT_INFLIGHT_MS, undefined)
      const afterWait = await cacheGet<T>(key)
      if (afterWait) return afterWait.value
    }
  }

  // 首次没有缓存（或等完仍没有）：自己发一次；走去重，两个组件同时读同一个 key 只会发一次请求
  return dedupe(key, async () => {
    const value = await loader()
    await cacheSet(key, value)
    return value
  })
}

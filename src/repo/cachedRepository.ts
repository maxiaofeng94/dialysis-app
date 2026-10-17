import { cloudRepository } from '../lib/cloudRepository'
import type { Repository } from './repository'
import { withTimeout } from '../utils/timeout'
import {
  cacheGet,
  cacheSet,
  cacheDelete,
  cacheKeysByPrefix,
  cacheFirstWithRevalidate,
  cacheVersion,
  isRefreshing,
  refreshInFlight,
  shareRefresh,
  WAIT_INFLIGHT_MS,
  FRESH_MS,
} from '../lib/cloudCache'
import type {
  Patient,
  DryWeight,
  DialysisSession,
  BloodPressure,
  BloodGlucose,
  BloodFlow,
} from '../types'

/**
 * 给云端仓储加一层「缓存优先 + 后台刷新」（stale-while-revalidate）
 *
 * - 本地有缓存：立刻返回，页面马上有内容；同时后台请求云端，拿到后写回缓存并让 cacheVersion 自增，
 *   页面 watch 到这个信号再读一次即可显示最新数据（此时命中刚写入的缓存，不再等网络）。
 * - 本地没缓存（首次使用/刚清理）：只能正常等一次网络。
 * - 写操作：先落云端，成功后再同步本地缓存，保持"刚改完立刻看到"。
 *
 * 「新鲜度闸门 + 在途去重」都在 `cacheFirstWithRevalidate` 里，后台管理端共用同一份实现。
 */

const K = {
  patient: (id: string) => `patient:${id}`,
  dryWeights: (pid: string) => `dryWeights:${pid}`,
  session: (id: string) => `session:${id}`,
  sessions: (pid: string) => `sessions:${pid}`,
  bps: (sid: string) => `bps:${sid}`,
  bgs: (sid: string) => `bgs:${sid}`,
  bfs: (sid: string) => `bfs:${sid}`,
  ars: (sid: string) => `ars:${sid}`,
}

const cacheFirst = cacheFirstWithRevalidate

/** 写入/更新列表缓存中的一条（不存在则插入），并按给定规则排序 */
async function upsertInto<T extends { id: string }>(
  key: string,
  item: T,
  compare: (a: T, b: T) => number,
): Promise<void> {
  const cached = await cacheGet<T[]>(key)
  if (!cached) return
  const list = cached.value.filter((x) => x.id !== item.id)
  list.push(item)
  list.sort(compare)
  await cacheSet(key, list)
}

async function removeFromListsById(id: string, prefixes: string[]): Promise<void> {
  for (const prefix of prefixes) {
    for (const key of await cacheKeysByPrefix(prefix)) {
      const cached = await cacheGet<{ id: string }[]>(key)
      if (!cached) continue
      const filtered = cached.value.filter((x) => x.id !== id)
      if (filtered.length !== cached.value.length) await cacheSet(key, filtered)
    }
  }
}

/**
 * 更新「我的病人」列表缓存里的病人副本。
 *
 * 这个列表的元素是 `{ patient, role }`（没有顶层 `id`），用不了 `upsertInto`。
 * 不更新的话，在设置页改完档案（轮椅重量 / 回水量）看到的还是旧值，用户会以为没保存上。
 */
async function updateMyPatientsCache(patient: Patient): Promise<void> {
  for (const key of await cacheKeysByPrefix('myPatients:')) {
    const cached = await cacheGet<{ patient: Patient; role: string }[]>(key)
    if (!cached || !Array.isArray(cached.value)) continue
    await cacheSet(
      key,
      cached.value.map((item) => (item.patient?.id === patient.id ? { ...item, patient } : item)),
    )
  }
}

/**
 * 子表（血压 / 血糖 / 血流量）的**批量**读法 —— 趋势页一次要最近 30 条记录的数据。
 *
 * 以前是 `Promise.all(recent.map(listBloodPressures))`：30 条记录 × 2 类 = 60 次往返，
 * 手机弱网下首屏要等几十秒；更糟的是这 60 个 key 各自「缓存优先 + 后台刷新」，
 * 把 cacheVersion 推着反复自增（见 cloudCache.dedupe 的注释），请求数会失控。
 *
 * 现在的口径：
 * - 命中缓存的直接用（页面立刻有内容）；
 * - 缺失的合并成**一次** `in.(…)` 请求拉回，再按缓存 key 分组回填（详情页随后命中缓存）；
 * - 整体陈旧（超过 FRESH_MS）的补一次后台批量刷新，同样走 dedupe，绝不重复发。
 */
async function listManyBySession<T extends { sessionId: string }>(
  sessionIds: string[],
  keyOf: (sessionId: string) => string,
  fetchMany: (ids: string[]) => Promise<T[]>,
): Promise<T[]> {
  const ids = [...new Set(sessionIds.filter((id) => Boolean(id)))]
  if (!ids.length) return []

  const entries = await Promise.all(ids.map((id) => cacheGet<T[]>(keyOf(id))))
  const values = new Map<string, T[]>()
  const missing: string[] = []
  const stale: string[] = []
  /** 没有缓存、但已经有刷新在跑的 key：等它落库，别重复发请求 */
  const waiting: { id: string; task: Promise<unknown> }[] = []

  ids.forEach((id, i) => {
    const key = keyOf(id)
    const cached = entries[i]
    if (isRefreshing(key)) {
      // 已经在刷：有旧值就先渲染（绝不为它再排一次队，否则会拿着不同的 id 集合重复请求）；
      // 一点缓存都没有的，才需要等这一趟
      if (cached) values.set(id, cached.value)
      else waiting.push({ id, task: refreshInFlight(key)! })
      return
    }
    if (!cached) {
      missing.push(id)
      return
    }
    values.set(id, cached.value)
    if (Date.now() - cached.updatedAt >= FRESH_MS) stale.push(id)
  })

  // 等的是「别人已经在跑的请求」，不会新增网络往返；封顶是防止弱网下把页面拖死
  if (waiting.length) {
    await withTimeout(
      Promise.all(waiting.map((w) => w.task.catch(() => undefined))),
      WAIT_INFLIGHT_MS,
      undefined,
    )
    for (const { id } of waiting) {
      const cached = await cacheGet<T[]>(keyOf(id))
      if (cached) values.set(id, cached.value)
    }
  }

  /** 按 session 分组写回各自的缓存 key（空数组也要写：代表「这条记录确实没有数据」，否则每次都会重拉） */
  const writeBack = async (targets: string[], rows: T[]): Promise<void> => {
    const grouped = new Map<string, T[]>()
    for (const row of rows) {
      const arr = grouped.get(row.sessionId)
      if (arr) arr.push(row)
      else grouped.set(row.sessionId, [row])
    }
    await Promise.all(
      targets.map((id) => {
        const list = grouped.get(id) ?? []
        values.set(id, list)
        return cacheSet(keyOf(id), list)
      }),
    )
  }

  /**
   * 真正要发请求的 key：把「在这一步之前刚被别的路径接手刷新」的滤掉。
   *
   * 不能不过滤就交给 shareRefresh —— 它会复用到别人的任务，而那个任务的返回结果
   * 未必覆盖本次的 key，按它写回会把多余的 key 写成空数组（页面于是显示「暂无数据」）。
   * 被滤掉的那些读一次缓存就好：它们正在刷，马上就有新值。
   */
  const claim = async (candidates: string[]): Promise<string[]> => {
    const mine = candidates.filter((id) => !isRefreshing(keyOf(id)))
    const taken = new Set(mine)
    for (const id of candidates) {
      if (taken.has(id)) continue
      const cached = await cacheGet<T[]>(keyOf(id))
      if (cached) values.set(id, cached.value)
    }
    return mine
  }

  if (missing.length) {
    const targets = await claim(missing)
    if (targets.length) {
      // shareRefresh：这一批 id 一起登记在途，写回途中页面重读也不会再发一次
      const rows = await shareRefresh(targets.map(keyOf), () => fetchMany(targets))
      await writeBack(targets, rows)
    }
  }

  if (stale.length) {
    void claim(stale).then((targets) => {
      if (!targets.length) return
      return shareRefresh(targets.map(keyOf), async () => {
        const rows = await fetchMany(targets)
        await writeBack(targets, rows)
        return rows
      }).then(() => {
        cacheVersion.value++
      })
    }).catch(() => {
      // 后台刷新失败继续用旧缓存，不打扰用户
    })
  }

  // 按调用方给的顺序拼回去（每次 load 的 session 顺序一致，图表点位才稳定）
  return ids.flatMap((id) => values.get(id) ?? [])
}

// 与 localRepository.listSessions 保持同一口径：date 倒序，同一天按 createdAt 倒序
const byDateDesc = (a: DialysisSession, b: DialysisSession) =>
  a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.createdAt - a.createdAt
const byEffectiveDesc = (a: DryWeight, b: DryWeight) =>
  a.effectiveDate < b.effectiveDate ? 1 : a.effectiveDate > b.effectiveDate ? -1 : 0
const byMeasuredAsc = (a: { measuredAt: number }, b: { measuredAt: number }) => a.measuredAt - b.measuredAt

export const cachedCloudRepository: Repository = {
  // ---------- 病人 ----------
  async getPatient(id, opts) {
    // fresh：乐观锁冲突后的「重新加载」必须绕过缓存
    if (opts?.fresh) await cacheDelete([K.patient(id)])
    const v = await cacheFirst<Patient | null>(K.patient(id), async () => (await cloudRepository.getPatient(id)) ?? null)
    return v ?? undefined
  },
  async savePatient(patient, expectedUpdatedAt) {
    const iso = await cloudRepository.savePatient(patient, expectedUpdatedAt)
    // 保存成功后把新版本号写回对象与缓存，否则下一次保存会拿旧版本去比 → 自己跟自己冲突
    if (iso) patient.updatedAtIso = iso
    await cacheSet(K.patient(patient.id), patient)
    // 顺手更新「我的病人」列表里的那份副本：列表页显示的还是改动前的轮椅重量 / 回水量，
    // 用户会以为没保存上
    await updateMyPatientsCache(patient)
    return iso
  },

  // ---------- 干体重 ----------
  async listDryWeights(patientId) {
    return cacheFirst(K.dryWeights(patientId), () => cloudRepository.listDryWeights(patientId))
  },
  async saveDryWeight(dryWeight) {
    await cloudRepository.saveDryWeight(dryWeight)
    await upsertInto(K.dryWeights(dryWeight.patientId), dryWeight, byEffectiveDesc)
  },
  async deleteDryWeight(id) {
    await cloudRepository.deleteDryWeight(id)
    await removeFromListsById(id, ['dryWeights:'])
  },

  // ---------- 透析记录 ----------
  async listSessions(patientId) {
    return cacheFirst(K.sessions(patientId), () => cloudRepository.listSessions(patientId))
  },
  async getSession(id, opts) {
    // fresh：乐观锁冲突后的「重新加载」必须绕过缓存 —— 缓存里正是冲突前那份旧数据
    if (opts?.fresh) await cacheDelete([K.session(id)])
    const v = await cacheFirst<DialysisSession | null>(K.session(id), async () => (await cloudRepository.getSession(id)) ?? null)
    return v ?? undefined
  },
  async saveSession(session, expectedUpdatedAt) {
    const iso = await cloudRepository.saveSession(session, expectedUpdatedAt)
    // 保存成功后必须把**新版本号**写回对象与缓存：页面下一次自动保存（防抖 400ms）
    // 如果还拿旧版本去比，会立刻「自己跟自己冲突」，用户莫名其妙被问「记录已被他人修改」。
    if (iso) session.updatedAtIso = iso
    await cacheSet(K.session(session.id), session)
    await upsertInto(K.sessions(session.patientId), session, byDateDesc)
    return iso
  },
  async deleteSession(id) {
    await cloudRepository.deleteSession(id)
    await cacheDelete([K.session(id), K.bps(id), K.bgs(id), K.bfs(id), K.ars(id)])
    // 不再依赖「单条 session 缓存」里的 patientId（可能刚被清掉、或本来就没缓存过）：
    // 直接扫所有 sessions: 列表把它摘掉，否则用户会看到一条已经删掉的「幽灵记录」直到下次刷新。
    await removeFromListsById(id, ['sessions:'])
  },

  // ---------- 血压 ----------
  async listBloodPressures(sessionId) {
    return cacheFirst(K.bps(sessionId), () => cloudRepository.listBloodPressures(sessionId))
  },
  async listBloodPressuresMany(sessionIds) {
    return listManyBySession(sessionIds, K.bps, (ids) => cloudRepository.listBloodPressuresMany(ids))
  },
  async saveBloodPressure(bp) {
    await cloudRepository.saveBloodPressure(bp)
    await upsertInto<BloodPressure>(K.bps(bp.sessionId), bp, byMeasuredAsc)
  },
  async deleteBloodPressure(id) {
    await cloudRepository.deleteBloodPressure(id)
    await removeFromListsById(id, ['bps:'])
  },

  // ---------- 血糖 ----------
  async listBloodGlucoses(sessionId) {
    return cacheFirst(K.bgs(sessionId), () => cloudRepository.listBloodGlucoses(sessionId))
  },
  async listBloodGlucosesMany(sessionIds) {
    return listManyBySession(sessionIds, K.bgs, (ids) => cloudRepository.listBloodGlucosesMany(ids))
  },
  async saveBloodGlucose(glucose) {
    await cloudRepository.saveBloodGlucose(glucose)
    await upsertInto<BloodGlucose>(K.bgs(glucose.sessionId), glucose, byMeasuredAsc)
  },
  async deleteBloodGlucose(id) {
    await cloudRepository.deleteBloodGlucose(id)
    await removeFromListsById(id, ['bgs:'])
  },

  // ---------- 血流量 ----------
  async listBloodFlows(sessionId) {
    return cacheFirst(K.bfs(sessionId), () => cloudRepository.listBloodFlows(sessionId))
  },
  async saveBloodFlow(flow) {
    await cloudRepository.saveBloodFlow(flow)
    await upsertInto<BloodFlow>(K.bfs(flow.sessionId), flow, byMeasuredAsc)
  },
  async deleteBloodFlow(id) {
    await cloudRepository.deleteBloodFlow(id)
    await removeFromListsById(id, ['bfs:'])
  },

  // ---------- 不良反应 ----------
  async listAdverseReactions(sessionId, opts) {
    if (opts?.fresh) await cacheDelete([K.ars(sessionId)])
    return cacheFirst(K.ars(sessionId), () => cloudRepository.listAdverseReactions(sessionId))
  },
  async replaceAdverseReactions(sessionId, reactions, expectedIds) {
    await cloudRepository.replaceAdverseReactions(sessionId, reactions, expectedIds)
    await cacheSet(K.ars(sessionId), reactions)
  },

  // ---------- 导入导出（直接透传，不走缓存） ----------
  exportAll: () => cloudRepository.exportAll(),
  importAll: (json: string) => cloudRepository.importAll(json),
}

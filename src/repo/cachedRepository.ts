import { cloudRepository } from '../lib/cloudRepository'
import type { Repository } from './repository'
import { cacheGet, cacheSet, cacheDelete, cacheVersion, cacheKeysByPrefix, FRESH_MS } from '../lib/cloudCache'
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

async function cacheFirst<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const cached = await cacheGet<T>(key)
  if (cached) {
    if (Date.now() - cached.updatedAt >= FRESH_MS) {
      void (async () => {
        try {
          const value = await fetcher()
          await cacheSet(key, value)
          cacheVersion.value++
        } catch {
          // 后台刷新失败就继续用旧缓存，不打扰用户
        }
      })()
    }
    return cached.value
  }
  const value = await fetcher()
  await cacheSet(key, value)
  return value
}

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

const byDateDesc = (a: { date: string }, b: { date: string }) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)
const byEffectiveDesc = (a: DryWeight, b: DryWeight) =>
  a.effectiveDate < b.effectiveDate ? 1 : a.effectiveDate > b.effectiveDate ? -1 : 0
const byMeasuredAsc = (a: { measuredAt: number }, b: { measuredAt: number }) => a.measuredAt - b.measuredAt

export const cachedCloudRepository: Repository = {
  // ---------- 病人 ----------
  async getPatient(id) {
    const v = await cacheFirst<Patient | null>(K.patient(id), async () => (await cloudRepository.getPatient(id)) ?? null)
    return v ?? undefined
  },
  async savePatient(patient) {
    await cloudRepository.savePatient(patient)
    await cacheSet(K.patient(patient.id), patient)
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
  async getSession(id) {
    const v = await cacheFirst<DialysisSession | null>(K.session(id), async () => (await cloudRepository.getSession(id)) ?? null)
    return v ?? undefined
  },
  async saveSession(session) {
    await cloudRepository.saveSession(session)
    await cacheSet(K.session(session.id), session)
    await upsertInto(K.sessions(session.patientId), session, byDateDesc)
  },
  async deleteSession(id) {
    const cached = await cacheGet<DialysisSession>(K.session(id))
    await cloudRepository.deleteSession(id)
    await cacheDelete([K.session(id), K.bps(id), K.bgs(id), K.bfs(id), K.ars(id)])
    const patientId = cached?.value.patientId
    if (patientId) {
      const key = K.sessions(patientId)
      const list = await cacheGet<DialysisSession[]>(key)
      if (list) await cacheSet(key, list.value.filter((s) => s.id !== id))
    }
  },

  // ---------- 血压 ----------
  async listBloodPressures(sessionId) {
    return cacheFirst(K.bps(sessionId), () => cloudRepository.listBloodPressures(sessionId))
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
  async listAdverseReactions(sessionId) {
    return cacheFirst(K.ars(sessionId), () => cloudRepository.listAdverseReactions(sessionId))
  },
  async replaceAdverseReactions(sessionId, reactions) {
    await cloudRepository.replaceAdverseReactions(sessionId, reactions)
    await cacheSet(K.ars(sessionId), reactions)
  },

  // ---------- 导入导出（直接透传，不走缓存） ----------
  exportAll: () => cloudRepository.exportAll(),
  importAll: (json: string) => cloudRepository.importAll(json),
}

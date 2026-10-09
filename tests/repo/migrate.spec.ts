/**
 * migrateLocalToCloud（本地单机数据 → 云端）测试
 *
 * 本地侧用真实 localRepository + fake-indexeddb 造数据；
 * 云端侧替换成桩：`createPatient`（Edge Function 调用）与 `repository`（写云端各表）都可断言。
 *
 * 关键不变量：本地 id 不是 uuid（patient-default / 自增 id），迁移必须**全部重映射**，
 * 且子表的 session_id 要指向新会话 —— 任何一处漏改都会把数据串到别的病人/会话上。
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { db } from '../../src/db/database'
import { localRepository } from '../../src/repo/localRepository'
import { DEFAULT_PATIENT_ID } from '../../src/constants'
import { makePatient, makeDryWeight, makeSession, makeBp, makeBg, makeBf, makeReaction, resetIdSeq } from '../helpers/factories'

/** 记录所有云端写调用的顺序与参数，便于断言「有没有串数据」 */
const hoisted = vi.hoisted(() => {
  const calls: { method: string; args: unknown[] }[] = []
  const fn = (method: string) =>
    vi.fn(async (...args: unknown[]) => {
      calls.push({ method, args })
    })
  return {
    calls,
    createPatient: vi.fn(),
    repository: {
      saveDryWeight: fn('saveDryWeight'),
      saveSession: fn('saveSession'),
      saveBloodPressure: fn('saveBloodPressure'),
      saveBloodGlucose: fn('saveBloodGlucose'),
      saveBloodFlow: fn('saveBloodFlow'),
      replaceAdverseReactions: fn('replaceAdverseReactions'),
    },
  }
})

vi.mock('../../src/lib/cloudAdmin', () => ({ createPatient: hoisted.createPatient }))
vi.mock('../../src/repo', () => ({ repository: hoisted.repository }))

import { migrateLocalToCloud } from '../../src/lib/migrate'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (v: unknown): boolean => typeof v === 'string' && UUID_RE.test(v)

/** 写一条本地「默认病人」+ 一套子数据 */
async function seedLocal() {
  await localRepository.savePatient(
    makePatient({ id: DEFAULT_PATIENT_ID, name: '张三', wheelchairWeight: 20, rinseBackVolume: 300 }),
  )
}

beforeEach(async () => {
  await db.delete()
  await db.open()
  resetIdSeq()
  hoisted.calls.length = 0
  for (const m of Object.values(hoisted.repository)) (m as Mock).mockClear()
  hoisted.createPatient.mockReset()
  hoisted.createPatient.mockResolvedValue({ ok: true, data: { patient: { id: 'cloud-p1' } } })
})

describe('migrate · 前置条件', () => {
  it('本机没有病人 → 返回 {ok:false, message:"本机没有病人数据"}，且不调云端', async () => {
    const res = await migrateLocalToCloud()

    expect(res).toEqual({ ok: false, message: '本机没有病人数据' })
    expect(hoisted.createPatient).not.toHaveBeenCalled()
    expect(hoisted.calls).toEqual([])
  })

  it('只有非默认 id 的病人时同样视为「本机没有病人数据」（本地单人版固定用 patient-default）', async () => {
    await localRepository.savePatient(makePatient({ id: 'other-patient' }))

    const res = await migrateLocalToCloud()

    expect(res.ok).toBe(false)
    expect(res.message).toBe('本机没有病人数据')
    expect(hoisted.createPatient).not.toHaveBeenCalled()
  })

  it('createPatient 失败（ok=false）→ 透传服务端错误信息，且不写任何云端数据', async () => {
    await seedLocal()
    await localRepository.saveDryWeight(makeDryWeight({ id: 'local-d1', patientId: DEFAULT_PATIENT_ID }))
    hoisted.createPatient.mockResolvedValue({ ok: false, data: { error: '病人数量已达上限' } })

    const res = await migrateLocalToCloud()

    expect(res).toEqual({ ok: false, message: '病人数量已达上限' })
    expect(hoisted.calls).toEqual([])
  })

  it('createPatient 返回 ok 但没有 patient.id → 返回失败且不写数据', async () => {
    await seedLocal()
    hoisted.createPatient.mockResolvedValue({ ok: true, data: {} })

    const res = await migrateLocalToCloud()

    expect(res.ok).toBe(false)
    expect(res.message).toBe('创建云端病人失败')
    expect(hoisted.calls).toEqual([])
  })

  it('createPatient 抛异常（网络中断）时返回失败结果，不开始迁移、也不把异常抛给调用方', async () => {
    await seedLocal()
    await localRepository.saveDryWeight(makeDryWeight({ id: 'local-d1', patientId: DEFAULT_PATIENT_ID }))
    hoisted.createPatient.mockRejectedValue(new Error('网络中断'))

    // 回归：曾经异常直接冒泡，调用方（设置页）会卡在「迁移中」且没有任何提示
    await expect(migrateLocalToCloud()).resolves.toEqual({ ok: false, message: '迁移中断：网络中断' })
    expect(hoisted.calls).toEqual([])
  })
})

describe('migrate · 成功路径', () => {
  /** 铺一套完整的本地数据并执行迁移，返回断言需要的中间结果 */
  async function runFullMigration() {
    await seedLocal()
    await localRepository.saveDryWeight(
      makeDryWeight({ id: 'local-d1', patientId: DEFAULT_PATIENT_ID, value: 60, effectiveDate: '2024-01-01' }),
    )
    await localRepository.saveSession(
      makeSession({ id: 'local-s1', patientId: DEFAULT_PATIENT_ID, date: '2024-05-01', notes: '第一班' }),
    )
    await localRepository.saveSession(
      makeSession({ id: 'local-s2', patientId: DEFAULT_PATIENT_ID, date: '2024-04-01', notes: '第二班' }),
    )
    await localRepository.saveBloodPressure(
      makeBp({ id: 'local-bp1', sessionId: 'local-s1', measuredAt: 1000, systolic: 130, note: 's1-bp' }),
    )
    await localRepository.saveBloodPressure(
      makeBp({ id: 'local-bp2', sessionId: 'local-s2', measuredAt: 2000, systolic: 150, note: 's2-bp' }),
    )
    await localRepository.saveBloodGlucose(makeBg({ id: 'local-bg1', sessionId: 'local-s1', measuredAt: 1000 }))
    await localRepository.saveBloodGlucose(makeBg({ id: 'local-bg2', sessionId: 'local-s2', measuredAt: 2000 }))
    await localRepository.saveBloodFlow(makeBf({ id: 'local-bf1', sessionId: 'local-s1', measuredAt: 1000 }))
    await localRepository.saveBloodFlow(makeBf({ id: 'local-bf2', sessionId: 'local-s2', measuredAt: 2000 }))
    await localRepository.replaceAdverseReactions('local-s1', [
      makeReaction({ id: 'local-ar1', sessionId: 'local-s1', type: 'cramp' }),
    ])
    await localRepository.replaceAdverseReactions('local-s2', [
      makeReaction({ id: 'local-ar2', sessionId: 'local-s2', type: 'vomit' }),
    ])

    const res = await migrateLocalToCloud()
    const savedSessions = hoisted.repository.saveSession.mock.calls.map((c) => c[0] as Record<string, any>)
    return { res, savedSessions, newSessionIds: savedSessions.map((s) => s.id as string) }
  }

  it('按本机档案创建云端病人：姓名 / 轮椅重量 / 回水量透传', async () => {
    await runFullMigration()

    expect(hoisted.createPatient).toHaveBeenCalledTimes(1)
    expect(hoisted.createPatient).toHaveBeenCalledWith('张三', 20, 300)
  })

  it('返回消息里带迁移的透析记录条数，并回传新病人 id（供调用方切换当前病人）', async () => {
    const { res } = await runFullMigration()

    expect(res).toEqual({ ok: true, message: '已迁移 2 条透析记录到云端', patientId: 'cloud-p1' })
  })

  it('干体重：重新生成 uuid 且 patientId 重映射为新病人 id', async () => {
    await runFullMigration()

    expect(hoisted.repository.saveDryWeight).toHaveBeenCalledTimes(1)
    const d = hoisted.repository.saveDryWeight.mock.calls[0][0] as Record<string, any>
    expect(isUuid(d.id)).toBe(true)
    expect(d.id).not.toBe('local-d1')
    expect(d.patientId).toBe('cloud-p1')
    // 业务字段原样保留
    expect(d).toMatchObject({ value: 60, effectiveDate: '2024-01-01' })
  })

  it('透析记录：新 id 都是 uuid，不等于旧 id，patientId 全部指向新病人，业务字段保留', async () => {
    const { savedSessions } = await runFullMigration()

    expect(hoisted.repository.saveSession).toHaveBeenCalledTimes(2)
    for (const s of savedSessions) {
      expect(isUuid(s.id)).toBe(true)
      expect(['local-s1', 'local-s2']).not.toContain(s.id)
      expect(s.patientId).toBe('cloud-p1')
      expect(s.status).toBe('ongoing')
      expect(s.abortTags).toEqual([])
    }
    expect(savedSessions.map((s) => s.notes)).toEqual(['第一班', '第二班'])
  })

  it('迁移顺序沿用本地列表顺序（date 倒序）', async () => {
    const { savedSessions } = await runFullMigration()

    expect(savedSessions.map((s) => s.date)).toEqual(['2024-05-01', '2024-04-01'])
  })

  it('子表条数一致，且 session_id 全部指向新会话 id（不是本地 id）', async () => {
    const { newSessionIds } = await runFullMigration()

    for (const method of ['saveBloodPressure', 'saveBloodGlucose', 'saveBloodFlow'] as const) {
      const rows = hoisted.repository[method].mock.calls.map((c) => c[0] as Record<string, any>)
      expect(rows).toHaveLength(2)
      for (const r of rows) {
        expect(isUuid(r.id)).toBe(true)
        expect(newSessionIds).toContain(r.sessionId)
      }
      // 两个会话各一条，说明没有把两条都挂到同一个会话上
      expect(new Set(rows.map((r) => r.sessionId)).size).toBe(2)
    }
  })

  it('子表与新会话的配对正确（用备注区分，防止串数据）', async () => {
    const { savedSessions } = await runFullMigration()
    const dateOf = (sessionId: string) => savedSessions.find((s) => s.id === sessionId)!.date

    const bps = hoisted.repository.saveBloodPressure.mock.calls.map((c) => c[0] as Record<string, any>)
    const pairs = bps.map((b) => [dateOf(b.sessionId), b.note])
    expect(pairs).toContainEqual(['2024-05-01', 's1-bp'])
    expect(pairs).toContainEqual(['2024-04-01', 's2-bp'])
  })

  it('不良反应：按新会话 id 逐条替换写回，条目 id 也是 uuid', async () => {
    const { newSessionIds } = await runFullMigration()

    const arCalls = hoisted.repository.replaceAdverseReactions.mock.calls as [string, Record<string, any>[]][]
    expect(arCalls).toHaveLength(2)
    for (const [sessionId, list] of arCalls) {
      expect(newSessionIds).toContain(sessionId)
      expect(list).toHaveLength(1)
      expect(isUuid(list[0].id)).toBe(true)
      expect(list[0].sessionId).toBe(sessionId)
    }
    expect(arCalls.map(([, list]) => list[0].type).sort()).toEqual(['cramp', 'vomit'])
  })

  it('任何写入的 payload 里都不能出现本地 id / patient-default（防串数据的硬性检查）', async () => {
    await runFullMigration()

    const dump = JSON.stringify(hoisted.calls)
    for (const localId of [
      DEFAULT_PATIENT_ID,
      'local-d1',
      'local-s1',
      'local-s2',
      'local-bp1',
      'local-bp2',
      'local-bg1',
      'local-bg2',
      'local-bf1',
      'local-bf2',
      'local-ar1',
      'local-ar2',
    ]) {
      expect(dump).not.toContain(localId)
    }
    // 新病人 id 必须出现（否则 patientId 就没重映射）
    expect(dump).toContain('cloud-p1')
  })

  it('云端写入调用次数与本地条数一一对应', async () => {
    await runFullMigration()

    expect(hoisted.calls.map((c) => c.method)).toEqual([
      'saveDryWeight',
      'saveSession',
      'saveBloodPressure',
      'saveBloodGlucose',
      'saveBloodFlow',
      'replaceAdverseReactions',
      'saveSession',
      'saveBloodPressure',
      'saveBloodGlucose',
      'saveBloodFlow',
      'replaceAdverseReactions',
    ])
  })

  it('迁移只读本地：本机数据一条不少', async () => {
    await runFullMigration()

    expect((await localRepository.listSessions(DEFAULT_PATIENT_ID)).map((s) => s.id)).toEqual(['local-s1', 'local-s2'])
    expect((await localRepository.listDryWeights(DEFAULT_PATIENT_ID)).map((d) => d.id)).toEqual(['local-d1'])
    expect(await localRepository.listBloodPressures('local-s1')).toHaveLength(1)
    expect(await localRepository.listAdverseReactions('local-s2')).toHaveLength(1)
    expect((await localRepository.getPatient(DEFAULT_PATIENT_ID))?.name).toBe('张三')
  })

  it('两次迁移生成互不相同的 id（同一份本地数据不会撞 id）', async () => {
    await seedLocal()
    await localRepository.saveSession(makeSession({ id: 'local-s1', patientId: DEFAULT_PATIENT_ID }))

    await migrateLocalToCloud()
    const first = hoisted.repository.saveSession.mock.calls[0][0] as Record<string, any>

    hoisted.calls.length = 0
    for (const m of Object.values(hoisted.repository)) (m as Mock).mockClear()
    await migrateLocalToCloud()
    const second = hoisted.repository.saveSession.mock.calls[0][0] as Record<string, any>

    expect(first.id).not.toBe(second.id)
  })
})

describe('migrate · 边界数据', () => {
  it('只有病人、没有记录时迁移成功，消息为 0 条，且不调任何写方法', async () => {
    await seedLocal()

    const res = await migrateLocalToCloud()

    expect(res).toEqual({ ok: true, message: '已迁移 0 条透析记录到云端', patientId: 'cloud-p1' })
    expect(hoisted.calls).toEqual([])
  })

  it('某条记录没有任何子数据时也能迁移（子表为空不写）', async () => {
    await seedLocal()
    await localRepository.saveSession(makeSession({ id: 'local-s1', patientId: DEFAULT_PATIENT_ID, date: '2024-05-01' }))

    const res = await migrateLocalToCloud()

    expect(res.ok).toBe(true)
    expect(hoisted.repository.saveSession).toHaveBeenCalledTimes(1)
    expect(hoisted.repository.saveBloodPressure).not.toHaveBeenCalled()
    expect(hoisted.repository.replaceAdverseReactions).toHaveBeenCalledTimes(1)
    expect(hoisted.repository.replaceAdverseReactions.mock.calls[0][1]).toEqual([])
  })

  it('旧版本的记录（缺中止字段）迁移时已被规整为默认值', async () => {
    await seedLocal()
    // 绕过类型直接写库，模拟升级前的旧记录
    await db.sessions.put({
      id: 'local-legacy',
      patientId: DEFAULT_PATIENT_ID,
      date: '2023-01-01',
      preWeightMeasured: 70,
      postWeightMeasured: null,
      wheelchairWeightUsed: 20,
      rinseBackVolumeUsed: 300,
      operator: null,
      doctorUf: null,
      notes: null,
      createdAt: 1,
      updatedAt: 1,
    } as never)

    const res = await migrateLocalToCloud()

    expect(res.ok).toBe(true)
    const saved = hoisted.repository.saveSession.mock.calls[0][0] as Record<string, any>
    expect(saved).toMatchObject({ status: 'ongoing', abortedAt: null, abortTags: [], abortReason: null })
    expect(isUuid(saved.id)).toBe(true)
  })

  it('其它病人的本地记录不会被顺手迁移（只迁默认病人）', async () => {
    await seedLocal()
    await localRepository.saveSession(makeSession({ id: 'local-s1', patientId: DEFAULT_PATIENT_ID, date: '2024-05-01' }))
    await localRepository.saveSession(makeSession({ id: 'local-other', patientId: 'other-patient', date: '2024-05-02' }))
    await localRepository.saveDryWeight(makeDryWeight({ id: 'local-d-other', patientId: 'other-patient' }))

    await migrateLocalToCloud()

    expect(hoisted.repository.saveSession).toHaveBeenCalledTimes(1)
    // 其它病人的干体重也不该被迁移（listDryWeights 按 patientId 过滤）
    expect(hoisted.repository.saveDryWeight).not.toHaveBeenCalled()
    const dump = JSON.stringify(hoisted.calls)
    expect(dump).not.toContain('local-other')
    expect(dump).not.toContain('local-d-other')
    expect(dump).not.toContain('other-patient')
  })
})

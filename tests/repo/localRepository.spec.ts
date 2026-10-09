/**
 * localRepository（Dexie + IndexedDB 本地单机仓储）测试
 *
 * 隔离策略：每个用例前 `db.delete()` + `db.open()`——整库删掉重建，
 * 比逐表 clear 更彻底（连索引/残留的自增状态一起清），也避免某个用例写入
 * 了脏结构后影响后续用例。fake-indexeddb 下这两个操作都是纯内存的，很快。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../../src/db/database'
import { localRepository } from '../../src/repo/localRepository'
import {
  makePatient,
  makeDryWeight,
  makeSession,
  makeBp,
  makeBg,
  makeBf,
  makeReaction,
  resetIdSeq,
} from '../helpers/factories'
import type { DialysisSession } from '../../src/types'

/** 造一条「旧版本」透析记录：没有中止相关的四个字段 */
function legacySession(patch: Partial<DialysisSession> = {}): DialysisSession {
  const s = makeSession(patch)
  delete (s as Partial<DialysisSession>).status
  delete (s as Partial<DialysisSession>).abortedAt
  delete (s as Partial<DialysisSession>).abortTags
  delete (s as Partial<DialysisSession>).abortReason
  return s
}

beforeEach(async () => {
  await db.delete()
  await db.open()
  resetIdSeq()
})

describe('localRepository · 病人档案', () => {
  it('savePatient → getPatient 原样往返（含 0 值的轮椅重量与回水量）', async () => {
    const p = makePatient({ id: 'p1', name: '李四', wheelchairWeight: 0, rinseBackVolume: 0, birthday: '' })
    await localRepository.savePatient(p)

    const got = await localRepository.getPatient('p1')
    expect(got).toEqual(p)
  })

  it('同 id 再保存是覆盖写，不会产生第二条', async () => {
    await localRepository.savePatient(makePatient({ id: 'p1', name: '旧名字' }))
    await localRepository.savePatient(makePatient({ id: 'p1', name: '新名字', wheelchairWeight: 25 }))

    const all = await db.patients.toArray()
    expect(all).toHaveLength(1)
    const got = await localRepository.getPatient('p1')
    expect(got?.name).toBe('新名字')
    expect(got?.wheelchairWeight).toBe(25)
  })

  it('查不到的 id 返回 undefined（不是 null）', async () => {
    expect(await localRepository.getPatient('不存在')).toBeUndefined()
  })

  it('savePatient 是拷贝语义：外部对象事后被改不影响库里的值', async () => {
    const p = makePatient({ id: 'p1', name: '原始' })
    await localRepository.savePatient(p)

    p.name = '被外部改了'
    p.wheelchairWeight = 999

    const got = await localRepository.getPatient('p1')
    expect(got?.name).toBe('原始')
    expect(got?.wheelchairWeight).toBe(20)
  })
})

describe('localRepository · 干体重', () => {
  it('只返回该病人的记录（按 patientId 过滤，不串人）', async () => {
    await localRepository.saveDryWeight(makeDryWeight({ id: 'd1', patientId: 'p1' }))
    await localRepository.saveDryWeight(makeDryWeight({ id: 'd2', patientId: 'p2' }))

    expect((await localRepository.listDryWeights('p1')).map((d) => d.id)).toEqual(['d1'])
    expect((await localRepository.listDryWeights('p2')).map((d) => d.id)).toEqual(['d2'])
    expect(await localRepository.listDryWeights('p3')).toEqual([])
  })

  it('按 effectiveDate 倒序（最新生效的排最前）', async () => {
    await localRepository.saveDryWeight(makeDryWeight({ id: 'old', effectiveDate: '2024-01-01' }))
    await localRepository.saveDryWeight(makeDryWeight({ id: 'new', effectiveDate: '2024-06-01' }))
    await localRepository.saveDryWeight(makeDryWeight({ id: 'mid', effectiveDate: '2024-03-01' }))

    const ids = (await localRepository.listDryWeights('patient-1')).map((d) => d.id)
    expect(ids).toEqual(['new', 'mid', 'old'])
  })

  it('同一天生效的按 createdAt 倒序（后创建的排前）', async () => {
    await localRepository.saveDryWeight(makeDryWeight({ id: 'a', effectiveDate: '2024-03-01', createdAt: 100 }))
    await localRepository.saveDryWeight(makeDryWeight({ id: 'b', effectiveDate: '2024-03-01', createdAt: 300 }))
    await localRepository.saveDryWeight(makeDryWeight({ id: 'c', effectiveDate: '2024-03-01', createdAt: 200 }))

    const ids = (await localRepository.listDryWeights('patient-1')).map((d) => d.id)
    expect(ids).toEqual(['b', 'c', 'a'])
  })

  it('同 id 覆盖写后排序位置随新值变化', async () => {
    await localRepository.saveDryWeight(makeDryWeight({ id: 'd1', effectiveDate: '2024-01-01' }))
    await localRepository.saveDryWeight(makeDryWeight({ id: 'd2', effectiveDate: '2024-05-01' }))
    // 把 d1 的生效日期改到最新
    await localRepository.saveDryWeight(makeDryWeight({ id: 'd1', effectiveDate: '2024-09-01' }))

    const ids = (await localRepository.listDryWeights('patient-1')).map((d) => d.id)
    expect(ids).toEqual(['d1', 'd2'])
  })

  it('deleteDryWeight 只删指定 id', async () => {
    await localRepository.saveDryWeight(makeDryWeight({ id: 'd1' }))
    await localRepository.saveDryWeight(makeDryWeight({ id: 'd2' }))

    await localRepository.deleteDryWeight('d1')

    expect((await localRepository.listDryWeights('patient-1')).map((d) => d.id)).toEqual(['d2'])
  })
})

describe('localRepository · 透析记录', () => {
  it('按 date 倒序；同日按 createdAt 倒序', async () => {
    await localRepository.saveSession(makeSession({ id: 's1', date: '2024-01-10', createdAt: 100 }))
    await localRepository.saveSession(makeSession({ id: 's2', date: '2024-03-10', createdAt: 100 }))
    await localRepository.saveSession(makeSession({ id: 's3', date: '2024-03-10', createdAt: 500 }))
    await localRepository.saveSession(makeSession({ id: 's4', date: '2024-02-10', createdAt: 100 }))

    const ids = (await localRepository.listSessions('patient-1')).map((s) => s.id)
    expect(ids).toEqual(['s3', 's2', 's4', 's1'])
  })

  it('只返回该病人的记录', async () => {
    await localRepository.saveSession(makeSession({ id: 's1', patientId: 'p1' }))
    await localRepository.saveSession(makeSession({ id: 's2', patientId: 'p2' }))

    expect((await localRepository.listSessions('p1')).map((s) => s.id)).toEqual(['s1'])
  })

  it('getSession 命中返回记录、未命中返回 undefined', async () => {
    await localRepository.saveSession(makeSession({ id: 's1', notes: '备注' }))

    expect((await localRepository.getSession('s1'))?.notes).toBe('备注')
    expect(await localRepository.getSession('s404')).toBeUndefined()
  })

  it('兼容旧数据：库里缺 status/abortedAt/abortTags/abortReason 时读出来是默认值', async () => {
    // 直接写库绕过类型，模拟「升级前存下的旧记录」
    await db.sessions.put(legacySession({ id: 'legacy', date: '2023-01-01' }) as DialysisSession)

    const one = await localRepository.getSession('legacy')
    expect(one?.status).toBe('ongoing')
    expect(one?.abortedAt).toBeNull()
    expect(one?.abortTags).toEqual([])
    expect(one?.abortReason).toBeNull()

    // 列表接口同样规整
    const list = await localRepository.listSessions('patient-1')
    expect(list[0].status).toBe('ongoing')
    expect(list[0].abortTags).toEqual([])
  })

  it('兼容脏数据：abortTags 不是数组时规整为空数组（不外泄原始值）', async () => {
    await db.sessions.put({ ...makeSession({ id: 'dirty' }), abortTags: 'cramp' } as unknown as DialysisSession)

    const got = await localRepository.getSession('dirty')
    expect(Array.isArray(got?.abortTags)).toBe(true)
    expect(got?.abortTags).toEqual([])
  })

  it('saveSession 也做规整：缺字段的写入对象读回来是完整字段', async () => {
    await localRepository.saveSession(legacySession({ id: 's-new' }))

    const got = await localRepository.getSession('s-new')
    expect(got?.status).toBe('ongoing')
    expect(got?.abortedAt).toBeNull()
    expect(got?.abortTags).toEqual([])
    expect(got?.abortReason).toBeNull()
  })

  it('saveSession 拷贝 abortTags 数组：外部改数组不影响库里', async () => {
    const s = makeSession({ id: 's1', status: 'aborted', abortTags: ['cramp'] })
    await localRepository.saveSession(s)

    s.abortTags.push('hypotension')

    expect((await localRepository.getSession('s1'))?.abortTags).toEqual(['cramp'])
  })

  it('已中止记录的 status/abortedAt/abortTags/abortReason 原样保存', async () => {
    await localRepository.saveSession(
      makeSession({
        id: 's1',
        status: 'aborted',
        abortedAt: 1_700_000_500_000,
        abortTags: ['machineFault', 'other'],
        abortReason: '机器报警',
      }),
    )

    const got = await localRepository.getSession('s1')
    expect(got).toMatchObject({
      status: 'aborted',
      abortedAt: 1_700_000_500_000,
      abortTags: ['machineFault', 'other'],
      abortReason: '机器报警',
    })
  })
})

describe('localRepository · deleteSession 级联与隔离', () => {
  /** 给某条 session 铺满四类子表数据 */
  async function seedChildren(sessionId: string, tag: string) {
    await localRepository.saveBloodPressure(makeBp({ id: `bp-${tag}`, sessionId }))
    await localRepository.saveBloodGlucose(makeBg({ id: `bg-${tag}`, sessionId }))
    await localRepository.saveBloodFlow(makeBf({ id: `bf-${tag}`, sessionId }))
    await localRepository.replaceAdverseReactions(sessionId, [makeReaction({ id: `ar-${tag}`, sessionId })])
  }

  it('删除记录时同一 sessionId 的血压/血糖/血流量/不良反应全部被删', async () => {
    await localRepository.saveSession(makeSession({ id: 's1' }))
    await seedChildren('s1', 'keep-me-out')

    expect(await db.bloodPressures.count()).toBe(1)
    await localRepository.deleteSession('s1')

    expect(await localRepository.getSession('s1')).toBeUndefined()
    expect(await localRepository.listBloodPressures('s1')).toEqual([])
    expect(await localRepository.listBloodGlucoses('s1')).toEqual([])
    expect(await localRepository.listBloodFlows('s1')).toEqual([])
    expect(await localRepository.listAdverseReactions('s1')).toEqual([])
    // 四张子表在库里也真的空了（不是读取时被过滤）
    expect(await db.bloodPressures.count()).toBe(0)
    expect(await db.bloodGlucoses.count()).toBe(0)
    expect(await db.bloodFlows.count()).toBe(0)
    expect(await db.adverseReactions.count()).toBe(0)
  })

  it('其它 session 的子表数据不受影响（数据隔离不变量）', async () => {
    await localRepository.saveSession(makeSession({ id: 's1' }))
    await localRepository.saveSession(makeSession({ id: 's2' }))
    await seedChildren('s1', 'one')
    await seedChildren('s2', 'two')

    await localRepository.deleteSession('s1')

    expect((await localRepository.listBloodPressures('s2')).map((b) => b.id)).toEqual(['bp-two'])
    expect((await localRepository.listBloodGlucoses('s2')).map((b) => b.id)).toEqual(['bg-two'])
    expect((await localRepository.listBloodFlows('s2')).map((b) => b.id)).toEqual(['bf-two'])
    expect((await localRepository.listAdverseReactions('s2')).map((a) => a.id)).toEqual(['ar-two'])
    expect((await localRepository.listSessions('patient-1')).map((s) => s.id)).toEqual(['s2'])
  })

  it('删除不存在的 session 不报错，也不误删别人的子数据', async () => {
    await localRepository.saveSession(makeSession({ id: 's1' }))
    await seedChildren('s1', 'one')

    await expect(localRepository.deleteSession('不存在')).resolves.toBeUndefined()

    expect(await localRepository.listBloodPressures('s1')).toHaveLength(1)
  })
})

describe('localRepository · 子表读取与排序', () => {
  it('血压按 measuredAt 升序，且只取该 session', async () => {
    await localRepository.saveBloodPressure(makeBp({ id: 'b2', sessionId: 's1', measuredAt: 200 }))
    await localRepository.saveBloodPressure(makeBp({ id: 'b1', sessionId: 's1', measuredAt: 100 }))
    await localRepository.saveBloodPressure(makeBp({ id: 'b3', sessionId: 's1', measuredAt: 300 }))
    await localRepository.saveBloodPressure(makeBp({ id: 'other', sessionId: 's2', measuredAt: 150 }))

    expect((await localRepository.listBloodPressures('s1')).map((b) => b.id)).toEqual(['b1', 'b2', 'b3'])
    expect((await localRepository.listBloodPressures('s2')).map((b) => b.id)).toEqual(['other'])
  })

  it('血糖按 measuredAt 升序', async () => {
    await localRepository.saveBloodGlucose(makeBg({ id: 'g2', measuredAt: 500 }))
    await localRepository.saveBloodGlucose(makeBg({ id: 'g1', measuredAt: 100 }))

    expect((await localRepository.listBloodGlucoses('session-1')).map((g) => g.id)).toEqual(['g1', 'g2'])
  })

  it('血流量按 measuredAt 升序', async () => {
    await localRepository.saveBloodFlow(makeBf({ id: 'f3', measuredAt: 900 }))
    await localRepository.saveBloodFlow(makeBf({ id: 'f1', measuredAt: 100 }))
    await localRepository.saveBloodFlow(makeBf({ id: 'f2', measuredAt: 400 }))

    expect((await localRepository.listBloodFlows('session-1')).map((f) => f.id)).toEqual(['f1', 'f2', 'f3'])
  })

  it('不良反应按 recordedAt 升序', async () => {
    await localRepository.replaceAdverseReactions('session-1', [
      makeReaction({ id: 'a2', recordedAt: 200 }),
      makeReaction({ id: 'a1', recordedAt: 100 }),
    ])

    expect((await localRepository.listAdverseReactions('session-1')).map((a) => a.id)).toEqual(['a1', 'a2'])
  })

  it('子表单条删除只删自己', async () => {
    await localRepository.saveBloodPressure(makeBp({ id: 'b1', sessionId: 's1' }))
    await localRepository.saveBloodPressure(makeBp({ id: 'b2', sessionId: 's1' }))
    await localRepository.saveBloodGlucose(makeBg({ id: 'g1', sessionId: 's1' }))
    await localRepository.saveBloodFlow(makeBf({ id: 'f1', sessionId: 's1' }))

    await localRepository.deleteBloodPressure('b1')
    await localRepository.deleteBloodGlucose('g1')
    await localRepository.deleteBloodFlow('f1')

    expect((await localRepository.listBloodPressures('s1')).map((b) => b.id)).toEqual(['b2'])
    expect(await localRepository.listBloodGlucoses('s1')).toEqual([])
    expect(await localRepository.listBloodFlows('s1')).toEqual([])
  })
})

describe('localRepository · 不良反应替换', () => {
  it('replaceAdverseReactions 先清后插：原有记录被整体替换', async () => {
    await localRepository.replaceAdverseReactions('s1', [
      makeReaction({ id: 'old1', sessionId: 's1' }),
      makeReaction({ id: 'old2', sessionId: 's1', type: 'vomit' }),
    ])

    await localRepository.replaceAdverseReactions('s1', [makeReaction({ id: 'new1', sessionId: 's1', type: 'cramp' })])

    const list = await localRepository.listAdverseReactions('s1')
    expect(list.map((a) => a.id)).toEqual(['new1'])
    expect(await db.adverseReactions.count()).toBe(1)
  })

  it('传空数组 = 清空该 session 的不良反应', async () => {
    await localRepository.replaceAdverseReactions('s1', [makeReaction({ id: 'a1', sessionId: 's1' })])
    await localRepository.replaceAdverseReactions('s1', [])

    expect(await localRepository.listAdverseReactions('s1')).toEqual([])
    expect(await db.adverseReactions.count()).toBe(0)
  })

  it('替换只作用于指定 session，别的 session 不受影响', async () => {
    await localRepository.replaceAdverseReactions('s1', [makeReaction({ id: 'a1', sessionId: 's1' })])
    await localRepository.replaceAdverseReactions('s2', [makeReaction({ id: 'a2', sessionId: 's2' })])

    await localRepository.replaceAdverseReactions('s1', [makeReaction({ id: 'a1-new', sessionId: 's1' })])

    expect((await localRepository.listAdverseReactions('s1')).map((a) => a.id)).toEqual(['a1-new'])
    expect((await localRepository.listAdverseReactions('s2')).map((a) => a.id)).toEqual(['a2'])
  })
})

describe('localRepository · 导入导出', () => {
  /** 铺一套完整数据 */
  async function seedAll() {
    await localRepository.savePatient(makePatient({ id: 'p1' }))
    await localRepository.saveDryWeight(makeDryWeight({ id: 'd1', patientId: 'p1' }))
    await localRepository.saveSession(makeSession({ id: 's1', patientId: 'p1' }))
    await localRepository.saveBloodPressure(makeBp({ id: 'bp1', sessionId: 's1' }))
    await localRepository.saveBloodGlucose(makeBg({ id: 'bg1', sessionId: 's1' }))
    await localRepository.saveBloodFlow(makeBf({ id: 'bf1', sessionId: 's1' }))
    await localRepository.replaceAdverseReactions('s1', [makeReaction({ id: 'ar1', sessionId: 's1' })])
  }

  it('exportAll 输出带版本号与导出时间的完整 JSON', async () => {
    await seedAll()
    const before = Date.now()

    const raw = await localRepository.exportAll()
    const data = JSON.parse(raw)

    expect(data.version).toBe(1)
    expect(typeof data.exportedAt).toBe('number')
    expect(data.exportedAt).toBeGreaterThanOrEqual(before)
    expect(data.exportedAt).toBeLessThanOrEqual(Date.now())
    expect(data.patients.map((p: { id: string }) => p.id)).toEqual(['p1'])
    expect(data.dryWeights.map((d: { id: string }) => d.id)).toEqual(['d1'])
    expect(data.sessions.map((s: { id: string }) => s.id)).toEqual(['s1'])
    expect(data.bloodPressures.map((b: { id: string }) => b.id)).toEqual(['bp1'])
    expect(data.bloodGlucoses.map((g: { id: string }) => g.id)).toEqual(['bg1'])
    expect(data.bloodFlows.map((f: { id: string }) => f.id)).toEqual(['bf1'])
    expect(data.adverseReactions.map((a: { id: string }) => a.id)).toEqual(['ar1'])
  })

  it('导出的旧记录也已被规整（导出的 JSON 里不会出现缺字段的 session）', async () => {
    await db.sessions.put(legacySession({ id: 'legacy' }) as DialysisSession)

    const data = JSON.parse(await localRepository.exportAll())
    expect(data.sessions[0]).toMatchObject({
      id: 'legacy',
      status: 'ongoing',
      abortedAt: null,
      abortTags: [],
      abortReason: null,
    })
  })

  it('importAll 先清空再写入：导入前库里的脏数据必须消失', async () => {
    // 库里预置一条「导入数据里没有」的记录，且 id 与导入数据不同
    await localRepository.savePatient(makePatient({ id: 'dirty-patient' }))
    await localRepository.saveSession(makeSession({ id: 'dirty-session' }))
    await localRepository.saveDryWeight(makeDryWeight({ id: 'dirty-dry' }))
    await localRepository.saveBloodPressure(makeBp({ id: 'dirty-bp', sessionId: 'dirty-session' }))

    await localRepository.importAll(
      JSON.stringify({
        version: 1,
        patients: [makePatient({ id: 'p-new' })],
        sessions: [makeSession({ id: 's-new' })],
      }),
    )

    expect(await localRepository.getPatient('dirty-patient')).toBeUndefined()
    expect(await localRepository.getSession('dirty-session')).toBeUndefined()
    expect(await localRepository.listDryWeights('patient-1')).toEqual([])
    expect(await db.bloodPressures.count()).toBe(0)
    expect((await db.patients.toArray()).map((p) => p.id)).toEqual(['p-new'])
  })

  it('importAll 容忍缺字段的 JSON：只有 patients 时不报错，其余表为空', async () => {
    await localRepository.saveSession(makeSession({ id: 'old-session' }))

    await expect(
      localRepository.importAll(JSON.stringify({ patients: [makePatient({ id: 'p-only' })] })),
    ).resolves.toBeUndefined()

    expect((await db.patients.toArray()).map((p) => p.id)).toEqual(['p-only'])
    expect(await db.dryWeights.count()).toBe(0)
    expect(await db.sessions.count()).toBe(0)
    expect(await db.bloodPressures.count()).toBe(0)
    expect(await db.adverseReactions.count()).toBe(0)
  })

  it('importAll 写入的旧格式 session 会被规整', async () => {
    await localRepository.importAll(JSON.stringify({ sessions: [legacySession({ id: 'legacy-in' })] }))

    const got = await localRepository.getSession('legacy-in')
    expect(got).toMatchObject({ status: 'ongoing', abortedAt: null, abortTags: [], abortReason: null })
  })

  it('export → import 往返后数据与导出前一致', async () => {
    await seedAll()
    const exported = await localRepository.exportAll()
    const before = JSON.parse(exported)

    await localRepository.importAll(exported)

    const after = JSON.parse(await localRepository.exportAll())
    // exportedAt 每次都变，其余字段应逐字一致（含各表顺序）
    delete before.exportedAt
    delete after.exportedAt
    expect(after).toEqual(before)
  })

  it('importAll 传入非法 JSON 字符串会抛错（不静默清库）', async () => {
    await localRepository.savePatient(makePatient({ id: 'p1' }))

    await expect(localRepository.importAll('{不是 json')).rejects.toThrow()
    // JSON.parse 在清库之前，因此数据仍在
    expect(await localRepository.getPatient('p1')).toBeDefined()
  })
})

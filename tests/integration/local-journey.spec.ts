/**
 * 本地单机链路 · 端到端集成测试
 *
 * 与 tests/repo/localRepository.spec.ts 的区别：这里**不 mock 任何数据层**，
 * 把「真实 Dexie(fake-indexeddb) + 真实仓储 + 真实计算/格式化/常量」串起来跑一遍完整旅程，
 * 验的是模块之间的接缝（排序约定、快照字段、导出/导入格式、级联删除、跨病人隔离）。
 *
 * 刻意不 import `src/repo/index`：那个是「按登录态分发」的动态代理，属于另一条链路；
 * 本文件只验 pure local（`localRepository`）这条路。
 *
 * 时间：用 fake Date 钉死「现在」，让 exportedAt / todayStr 之类的取值可复现；
 * 只 fake Date（不 fake 定时器），避免 IndexedDB 的异步事务被卡住。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { db } from '../../src/db/database'
import { localRepository } from '../../src/repo/localRepository'
import { getEffectiveDryWeight, computeSession, round1 } from '../../src/utils/calc'
import { combineDateTime, dateStr, todayStr } from '../../src/utils/format'
import { abortText, DEFAULT_PATIENT_ID } from '../../src/constants'
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

const P1 = 'patient-1'
const P2 = 'patient-2'
const S1 = 'session-1'
const S2 = 'session-2'

/** 固定的「现在」：2024-06-15 10:00 本地时间 */
const FIXED_NOW = new Date(2024, 5, 15, 10, 0, 0)

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FIXED_NOW)
  // 整库删掉重建：比逐表 clear 更彻底，用例之间绝不串味
  await db.delete()
  await db.open()
  resetIdSeq()
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * 铺一条完整旅程：建档案 → 建进行中的记录 → 写各类子数据。
 * 子数据**刻意乱序写入**（先写晚的、后写早的），用来验证读回时由仓储负责排序。
 */
async function seedFullJourney() {
  const patient = makePatient({
    id: P1,
    name: '张三',
    birthday: '1950-06-01',
    wheelchairWeight: 20,
    rinseBackVolume: 300,
  })
  await localRepository.savePatient(patient)

  const session = makeSession({
    id: S1,
    patientId: P1,
    date: '2024-01-15',
    preWeightMeasured: 80,
    postWeightMeasured: 78.5,
    wheelchairWeightUsed: 20,
    rinseBackVolumeUsed: 300,
    status: 'ongoing',
    createdAt: combineDateTime('2024-01-15', '08:50'),
    updatedAt: combineDateTime('2024-01-15', '08:50'),
  })
  await localRepository.saveSession(session)

  const bpEarly = makeBp({
    id: 'bp-1',
    sessionId: S1,
    measuredAt: combineDateTime('2024-01-15', '09:00'),
    systolic: 135,
    diastolic: 85,
  })
  const bpLate = makeBp({
    id: 'bp-2',
    sessionId: S1,
    measuredAt: combineDateTime('2024-01-15', '10:30'),
    systolic: 120,
    diastolic: 75,
  })
  await localRepository.saveBloodPressure(bpLate)
  await localRepository.saveBloodPressure(bpEarly)

  const glucose = makeBg({
    id: 'bg-1',
    sessionId: S1,
    measuredAt: combineDateTime('2024-01-15', '11:00'),
    value: 6.8,
  })
  await localRepository.saveBloodGlucose(glucose)

  const bfEarly = makeBf({
    id: 'bf-1',
    sessionId: S1,
    measuredAt: combineDateTime('2024-01-15', '09:10'),
    value: 180,
  })
  const bfLate = makeBf({
    id: 'bf-2',
    sessionId: S1,
    measuredAt: combineDateTime('2024-01-15', '10:00'),
    value: 260,
  })
  await localRepository.saveBloodFlow(bfLate)
  await localRepository.saveBloodFlow(bfEarly)

  const reactionEarly = makeReaction({
    id: 'ar-1',
    sessionId: S1,
    type: 'hypotension',
    severity: 'mild',
    detail: null,
    recordedAt: combineDateTime('2024-01-15', '09:40'),
  })
  const reactionLate = makeReaction({
    id: 'ar-2',
    sessionId: S1,
    type: 'cramp',
    severity: 'moderate',
    detail: '左小腿',
    recordedAt: combineDateTime('2024-01-15', '11:20'),
  })
  // 不良反应是整体替换语义（页面上是整表提交）
  await localRepository.replaceAdverseReactions(S1, [reactionLate, reactionEarly])

  return { patient, session, bpEarly, bpLate, glucose, bfEarly, bfLate, reactionEarly, reactionLate }
}

describe('本地旅程 · 建档案 → 写记录 → 读回', () => {
  it('病人档案原样往返（含轮椅/回水快照字段）', async () => {
    const { patient } = await seedFullJourney()

    const got = await localRepository.getPatient(P1)
    expect(got).toEqual(patient)
    expect(got?.wheelchairWeight).toBe(20)
    expect(got?.rinseBackVolume).toBe(300)
  })

  it('session 以 ongoing 状态落库，字段（含空值字段）完整读回', async () => {
    const { session } = await seedFullJourney()

    const got = await localRepository.getSession(S1)
    expect(got).toEqual(session)
    expect(got).toMatchObject({
      status: 'ongoing',
      postWeightMeasured: 78.5,
      operator: null,
      doctorUf: null,
      abortedAt: null,
      abortTags: [],
      abortReason: null,
      notes: null,
    })
  })

  it('血压：按 measuredAt 升序返回，条数与内容一致（写入顺序是反的）', async () => {
    const { bpEarly, bpLate } = await seedFullJourney()

    const list = await localRepository.listBloodPressures(S1)

    expect(list).toHaveLength(2)
    expect(list).toEqual([bpEarly, bpLate])
    expect(list.map((b) => b.measuredAt)).toEqual([bpEarly.measuredAt, bpLate.measuredAt])
    expect(list[0].systolic).toBe(135)
    expect(list[1].systolic).toBe(120)
  })

  it('血糖 / 血流量 / 不良反应：条数与内容一致', async () => {
    const { glucose, bfEarly, bfLate, reactionEarly, reactionLate } = await seedFullJourney()

    await expect(localRepository.listBloodGlucoses(S1)).resolves.toEqual([glucose])
    await expect(localRepository.listBloodFlows(S1)).resolves.toEqual([bfEarly, bfLate])
    await expect(localRepository.listAdverseReactions(S1)).resolves.toEqual([reactionEarly, reactionLate])
  })

  it('不良反应 replaceAdverseReactions 是整体替换，且不影响其它记录', async () => {
    const { reactionLate } = await seedFullJourney()
    await localRepository.saveSession(makeSession({ id: S2, patientId: P1, date: '2024-01-22' }))
    const otherSessionReaction = makeReaction({ id: 'ar-other', sessionId: S2, type: 'vomit' })
    await localRepository.replaceAdverseReactions(S2, [otherSessionReaction])

    const only = makeReaction({ id: 'ar-only', sessionId: S1, type: 'headache', recordedAt: 1 })
    await localRepository.replaceAdverseReactions(S1, [only])

    await expect(localRepository.listAdverseReactions(S1)).resolves.toEqual([only])
    // S2 不受影响（替换按 sessionId 精确作用）
    await expect(localRepository.listAdverseReactions(S2)).resolves.toEqual([otherSessionReaction])
    expect(reactionLate.id).toBe('ar-2')
  })

  it('子表各自只属于自己那条记录（sessionId 过滤生效）', async () => {
    await seedFullJourney()
    await localRepository.saveSession(makeSession({ id: S2, patientId: P1, date: '2024-01-22' }))
    const otherBp = makeBp({ id: 'bp-other', sessionId: S2, measuredAt: 1 })
    await localRepository.saveBloodPressure(otherBp)

    const list = await localRepository.listBloodPressures(S1)
    expect(list.map((b) => b.id)).toEqual(['bp-1', 'bp-2'])
    await expect(localRepository.listBloodPressures(S2)).resolves.toEqual([otherBp])
  })
})

describe('本地旅程 · listSessions 排序', () => {
  it('按日期倒序；同一天按 createdAt 倒序（最新的排在前面）', async () => {
    await localRepository.savePatient(makePatient({ id: P1 }))
    const older = makeSession({ id: 's-old', patientId: P1, date: '2024-01-15', createdAt: 100, updatedAt: 100 })
    const newer = makeSession({ id: 's-new', patientId: P1, date: '2024-01-15', createdAt: 200, updatedAt: 200 })
    const march = makeSession({ id: 's-mar', patientId: P1, date: '2024-03-05' })
    const april = makeSession({ id: 's-apr', patientId: P1, date: '2024-04-20' })
    // 乱序写入
    await localRepository.saveSession(march)
    await localRepository.saveSession(older)
    await localRepository.saveSession(april)
    await localRepository.saveSession(newer)

    const list = await localRepository.listSessions(P1)

    expect(list.map((s) => s.id)).toEqual(['s-apr', 's-mar', 's-new', 's-old'])
    expect(list.map((s) => s.date)).toEqual(['2024-04-20', '2024-03-05', '2024-01-15', '2024-01-15'])
  })
})

describe('本地旅程 · 干体重历史稳定性', () => {
  /** 造两条干体重：2024-01-01 起 60kg，2024-03-01 起调整为 58kg */
  async function seedDryWeights() {
    const dwOld = makeDryWeight({
      id: 'dw-60',
      patientId: P1,
      value: 60,
      effectiveDate: '2024-01-01',
      createdAt: 100,
      updatedAt: 100,
    })
    const dwNew = makeDryWeight({
      id: 'dw-58',
      patientId: P1,
      value: 58,
      effectiveDate: '2024-03-01',
      createdAt: 200,
      updatedAt: 200,
    })
    await localRepository.saveDryWeight(dwNew)
    await localRepository.saveDryWeight(dwOld)
    return { dwOld, dwNew }
  }

  it('干体重按生效日倒序返回，且能取到「某日期当时有效」的那条', async () => {
    const { dwOld, dwNew } = await seedDryWeights()

    const list = await localRepository.listDryWeights(P1)
    expect(list.map((d) => d.id)).toEqual(['dw-58', 'dw-60'])

    // 1 月的记录用当时生效的 60；3 月 1 日当天起换成 58
    expect(getEffectiveDryWeight(list, '2024-01-15')).toBe(60)
    expect(getEffectiveDryWeight(list, '2024-02-29')).toBe(60)
    expect(getEffectiveDryWeight(list, '2024-03-01')).toBe(58)
    expect(getEffectiveDryWeight(list, '2024-04-15')).toBe(58)
    expect(dwOld.value).toBe(60)
    expect(dwNew.value).toBe(58)
  })

  it('同一条记录在 1 月与 4 月看，planUf 不同（历史不被后来的干体重改写）', async () => {
    await seedDryWeights()
    const s = makeSession({
      id: S1,
      patientId: P1,
      date: '2024-01-15',
      preWeightMeasured: 80, // 含轮椅
      wheelchairWeightUsed: 20, // 实际体重 60
      rinseBackVolumeUsed: 300,
    })

    const dryWeights = await localRepository.listDryWeights(P1)
    const viewingJanuary = computeSession(s, getEffectiveDryWeight(dryWeights, '2024-01-15'))
    const viewingApril = computeSession(s, getEffectiveDryWeight(dryWeights, '2024-04-15'))

    expect(viewingJanuary.effectiveDryWeight).toBe(60)
    expect(viewingApril.effectiveDryWeight).toBe(58)
    expect(viewingJanuary.planUf).toBe(0) // 60 - 60
    expect(viewingApril.planUf).toBe(2) // 60 - 58
    expect(viewingJanuary.planUf).not.toBe(viewingApril.planUf)

    // HomeView 展示历史记录时固定传 s.date（不是「今天」），所以上机当天的数值永远稳定
    const asRenderedInList = computeSession(s, getEffectiveDryWeight(dryWeights, s.date))
    expect(asRenderedInList.planUf).toBe(viewingJanuary.planUf)
    // machineUf 还会带上回水量（300ml = 0.3L）
    expect(asRenderedInList.machineUf).toBe(round1(0 + 300 / 1000))
  })

  it('干体重全部晚于记录日期时，用最早生效的一条兜底（不出现 null）', async () => {
    await localRepository.saveDryWeight(
      makeDryWeight({ id: 'dw-late', patientId: P1, value: 57, effectiveDate: '2024-05-01' }),
    )
    const s = makeSession({ id: S1, patientId: P1, date: '2024-01-15', preWeightMeasured: 80, wheelchairWeightUsed: 20 })

    const dryWeights = await localRepository.listDryWeights(P1)
    const dry = getEffectiveDryWeight(dryWeights, s.date)

    expect(dry).toBe(57)
    expect(computeSession(s, dry).planUf).toBe(3) // 60 - 57
  })
})

describe('本地旅程 · 中止记录', () => {
  it('中止字段落库后完整读回，abortText 组合出中文文案', async () => {
    const { session } = await seedFullJourney()
    const abortedAt = combineDateTime('2024-01-15', '10:45')

    const aborted = {
      ...session,
      status: 'aborted' as const,
      abortedAt,
      abortTags: ['hypotension', 'other'],
      abortReason: '血压持续偏低',
      updatedAt: abortedAt,
    }
    await localRepository.saveSession(aborted)

    const got = await localRepository.getSession(S1)
    expect(got).toMatchObject({
      status: 'aborted',
      abortedAt,
      abortTags: ['hypotension', 'other'],
      abortReason: '血压持续偏低',
      updatedAt: abortedAt,
    })
    expect(abortText(got!.abortTags, got!.abortReason)).toBe('低血压、血压持续偏低')
    expect(abortText(got!.abortTags, got!.abortReason)).not.toContain('其他')

    // 列表视图读到的也是同一条（normalizeSession 不让字段丢失）
    const [inList] = await localRepository.listSessions(P1)
    expect(inList.status).toBe('aborted')
    expect(inList.abortedAt).toBe(abortedAt)
  })

  it('tags 数组是拷贝语义：外部改读回来的数组不会污染库里', async () => {
    const { session } = await seedFullJourney()
    await localRepository.saveSession({ ...session, status: 'aborted', abortTags: ['clotting'] })

    const first = await localRepository.getSession(S1)
    first!.abortTags.push('被外部改了')

    const second = await localRepository.getSession(S1)
    expect(second!.abortTags).toEqual(['clotting'])
  })

  it('只选 other 时 abortText 显示「其他」，描述只有空格时视为未填', async () => {
    const { session } = await seedFullJourney()
    await localRepository.saveSession({ ...session, status: 'aborted', abortTags: ['other'], abortReason: '   ' })

    const got = await localRepository.getSession(S1)
    expect(abortText(got!.abortTags, got!.abortReason)).toBe('其他')
  })

  it('进行中的记录不会误带中止信息', async () => {
    const { session } = await seedFullJourney()
    expect(session.status).toBe('ongoing')
    expect(session.abortedAt).toBeNull()
    expect(session.abortTags).toEqual([])
    expect(abortText(session.abortTags, session.abortReason)).toBe('')
  })
})

describe('本地旅程 · 导出 → 清库 → 导入', () => {
  /** 导出后逐表比对（exportedAt 每次都会变，单独排除） */
  function tablesOf(json: string) {
    const data = JSON.parse(json) as Record<string, unknown>
    const { exportedAt: _exportedAt, ...tables } = data
    return tables
  }

  it('导出内容含版本号与全部七张表', async () => {
    await seedFullJourney()

    const data = JSON.parse(await localRepository.exportAll())

    expect(data.version).toBe(1)
    expect(typeof data.exportedAt).toBe('number')
    expect(data.exportedAt).toBe(FIXED_NOW.getTime())
    expect(Object.keys(data).sort()).toEqual(
      [
        'adverseReactions',
        'bloodFlows',
        'bloodGlucoses',
        'bloodPressures',
        'dryWeights',
        'exportedAt',
        'patients',
        'sessions',
        'version',
      ].sort(),
    )
    expect(data.patients).toHaveLength(1)
    expect(data.sessions).toHaveLength(1)
    expect(data.bloodPressures).toHaveLength(2)
    expect(data.bloodGlucoses).toHaveLength(1)
    expect(data.bloodFlows).toHaveLength(2)
    expect(data.adverseReactions).toHaveLength(2)
  })

  it('清库后导入：逐表与导入前完全一致（含时间戳与中止状态）', async () => {
    const { session } = await seedFullJourney()
    await localRepository.saveDryWeight(
      makeDryWeight({ id: 'dw-1', patientId: P1, value: 60, effectiveDate: '2024-01-01' }),
    )
    await localRepository.saveSession({
      ...session,
      id: S2,
      date: '2024-01-22',
      status: 'aborted',
      abortedAt: combineDateTime('2024-01-22', '10:00'),
      abortTags: ['machineFault'],
      abortReason: '机器报警',
    })

    const json1 = await localRepository.exportAll()

    // 真的清空（不是「导入时顺带覆盖」）
    await db.delete()
    await db.open()
    expect(await db.patients.count()).toBe(0)
    expect(await db.sessions.count()).toBe(0)

    await localRepository.importAll(json1)

    expect(await db.patients.count()).toBe(1)
    expect(await db.sessions.count()).toBe(2)
    expect(await db.bloodPressures.count()).toBe(2)
    expect(await db.bloodGlucoses.count()).toBe(1)
    expect(await db.bloodFlows.count()).toBe(2)
    expect(await db.adverseReactions.count()).toBe(2)
    expect(await db.dryWeights.count()).toBe(1)

    const json2 = await localRepository.exportAll()
    // exportedAt 会随导出时刻变化，其余七张表必须逐字节等价
    expect(tablesOf(json2)).toEqual(tablesOf(json1))

    // 再具体核对容易丢的字段
    const restored = await localRepository.getSession(S2)
    expect(restored).toMatchObject({
      status: 'aborted',
      abortedAt: combineDateTime('2024-01-22', '10:00'),
      abortTags: ['machineFault'],
      abortReason: '机器报警',
    })
    expect(restored?.createdAt).toBe(session.createdAt)
    const [firstInList] = await localRepository.listSessions(P1)
    expect(firstInList.id).toBe(S2)
  })

  it('导入的内容与读回接口一致：列表排序、干体重取值都照旧', async () => {
    await seedFullJourney()
    await localRepository.saveDryWeight(
      makeDryWeight({ id: 'dw-1', patientId: P1, value: 60, effectiveDate: '2024-01-01' }),
    )
    const json = await localRepository.exportAll()
    await db.delete()
    await db.open()
    await localRepository.importAll(json)

    const sessions = await localRepository.listSessions(P1)
    const dryWeights = await localRepository.listDryWeights(P1)
    const [s] = sessions

    expect(sessions).toHaveLength(1)
    expect(dryWeights).toHaveLength(1)
    expect(getEffectiveDryWeight(dryWeights, s.date)).toBe(60)
    expect(computeSession(s, 60).preWeightActual).toBe(60)
    expect(await localRepository.listBloodPressures(s.id)).toHaveLength(2)
  })

  it('导入旧版本备份（session 没有中止字段）时补默认值，不会读出 undefined', async () => {
    const legacy = makeSession({ id: 's-legacy', patientId: P1, date: '2023-12-01' })
    delete (legacy as Partial<typeof legacy>).status
    delete (legacy as Partial<typeof legacy>).abortedAt
    delete (legacy as Partial<typeof legacy>).abortTags
    delete (legacy as Partial<typeof legacy>).abortReason

    await localRepository.importAll(
      JSON.stringify({ version: 1, exportedAt: 0, patients: [], sessions: [legacy] }),
    )

    const got = await localRepository.getSession('s-legacy')
    expect(got).toMatchObject({ status: 'ongoing', abortedAt: null, abortTags: [], abortReason: null })
    expect(abortText(got!.abortTags, got!.abortReason)).toBe('')
  })

  it('导入会整库替换：原有数据被清掉，不会与备份混在一起', async () => {
    await seedFullJourney()
    await localRepository.importAll(
      JSON.stringify({
        version: 1,
        exportedAt: 0,
        patients: [makePatient({ id: P2, name: '李四' })],
        sessions: [],
      }),
    )

    expect(await db.patients.count()).toBe(1)
    expect(await localRepository.getPatient(P1)).toBeUndefined()
    expect(await localRepository.getPatient(P2)).toMatchObject({ name: '李四' })
    expect(await db.bloodPressures.count()).toBe(0)
  })
})

describe('本地旅程 · 导入前的整份校验', () => {
  /**
   * 回归背景：importAll 曾经是「先 clear 七张表，再 bulkPut」——
   * 备份能 JSON.parse、但字段不合法时，bulkPut 才报错，此时本机数据已经被清空，
   * 界面却只提示「文件格式不正确」，用户根本不知道数据没了。
   *
   * 现在改成三步：JSON.parse → validateBackup 整份校验 → 事务内 clear + bulkPut。
   * 因此下面每个失败用例都同时钉两件事：**抛错** + **本机数据一个字节都没动**。
   */
  /** 七张表的行数快照（校验失败时必须与操作前完全一致） */
  async function tableCounts() {
    return {
      patients: await db.patients.count(),
      dryWeights: await db.dryWeights.count(),
      sessions: await db.sessions.count(),
      bloodPressures: await db.bloodPressures.count(),
      bloodGlucoses: await db.bloodGlucoses.count(),
      bloodFlows: await db.bloodFlows.count(),
      adverseReactions: await db.adverseReactions.count(),
    }
  }

  /** seedFullJourney 铺完之后应有的行数 */
  const SEEDED_COUNTS = {
    patients: 1,
    dryWeights: 0,
    sessions: 1,
    bloodPressures: 2,
    bloodGlucoses: 1,
    bloodFlows: 2,
    adverseReactions: 2,
  }

  const BACKUP_TABLES = [
    'patients',
    'dryWeights',
    'sessions',
    'bloodPressures',
    'bloodGlucoses',
    'bloodFlows',
    'adverseReactions',
  ] as const

  /** 铺一条完整旅程，并确认「操作前数据确实在」 */
  async function seedWithData() {
    await seedFullJourney()
    expect(await tableCounts()).toEqual(SEEDED_COUNTS)
  }

  it('缺 id 的行：抛错且本机原有数据完好无损（本轮修复的核心）', async () => {
    await seedWithData()

    // 合法 JSON，但病人行缺少主键 id
    const corrupted = JSON.stringify({ version: 1, exportedAt: 0, patients: [{ name: '缺主键的行' }] })

    await expect(localRepository.importAll(corrupted)).rejects.toThrow('备份文件格式不正确：patients 第 1 条缺少 id')

    // 曾经这里是「先 clear 再 bulkPut」：bulkPut 报 DataError 时七张表已经全空了
    expect(await tableCounts()).toEqual(SEEDED_COUNTS)
    expect((await localRepository.getPatient(P1))?.name).toBe('张三')
    await expect(localRepository.listSessions(P1)).resolves.toHaveLength(1)
    await expect(localRepository.listBloodPressures(S1)).resolves.toHaveLength(2)
    await expect(localRepository.listAdverseReactions(S1)).resolves.toHaveLength(2)
  })

  it.each(BACKUP_TABLES)('%s 的每一行都必须带字符串 id：缺 id 时抛错且本机数据不动', async (table) => {
    await seedWithData()

    await expect(
      localRepository.importAll(JSON.stringify({ version: 1, exportedAt: 0, [table]: [{ 没有: 'id' }] })),
    ).rejects.toThrow(`备份文件格式不正确：${table} 第 1 条缺少 id`)

    expect(await tableCounts()).toEqual(SEEDED_COUNTS)
  })

  it.each(BACKUP_TABLES)('%s 不是数组时抛错且本机数据不动', async (table) => {
    await seedWithData()

    await expect(
      localRepository.importAll(JSON.stringify({ version: 1, exportedAt: 0, [table]: { 不是: '数组' } })),
    ).rejects.toThrow(`备份文件格式不正确：${table} 不是数组`)

    expect(await tableCounts()).toEqual(SEEDED_COUNTS)
  })

  it.each(BACKUP_TABLES)('%s 里出现不是对象的行时抛错且本机数据不动', async (table) => {
    await seedWithData()

    await expect(
      localRepository.importAll(JSON.stringify({ version: 1, exportedAt: 0, [table]: ['不是对象'] })),
    ).rejects.toThrow(`备份文件格式不正确：${table} 第 1 条不是对象`)

    expect(await tableCounts()).toEqual(SEEDED_COUNTS)
  })

  it('行本身是数组也算「不是对象」，且本机数据不动', async () => {
    await seedWithData()

    await expect(
      localRepository.importAll(JSON.stringify({ version: 1, exportedAt: 0, patients: [[]] })),
    ).rejects.toThrow('备份文件格式不正确：patients 第 1 条不是对象')

    expect(await tableCounts()).toEqual(SEEDED_COUNTS)
  })

  it('version 比当前版本新：抛错并提示先升级 App，本机数据不动', async () => {
    await seedWithData()

    await expect(
      localRepository.importAll(JSON.stringify({ version: 2, exportedAt: 0, patients: [] })),
    ).rejects.toThrow('备份文件版本（2）比当前版本新，请先升级 App 再导入')

    expect(await tableCounts()).toEqual(SEEDED_COUNTS)
  })

  it.each(['[]', '[{"id":"p1"}]', 'null', '123', '"一段文本"'])(
    '顶层不是对象（%s）：抛错且本机数据不动',
    async (json) => {
      await seedWithData()

      await expect(localRepository.importAll(json)).rejects.toThrow('备份文件格式不正确：顶层不是对象')

      expect(await tableCounts()).toEqual(SEEDED_COUNTS)
    },
  )

  it.each(['{不是 JSON', '', '随便一段文字'])(
    '不是合法 JSON（%j）：抛「备份文件不是合法的 JSON」，且本机数据不动',
    async (json) => {
      await seedWithData()

      await expect(localRepository.importAll(json)).rejects.toThrow('备份文件不是合法的 JSON')

      expect(await tableCounts()).toEqual(SEEDED_COUNTS)
    },
  )

  it('合法备份：空数组与整表缺失都按「空」处理，正常完成导入', async () => {
    await seedFullJourney()

    // patients / sessions / bloodPressures 给空数组；其余四张表整个字段缺失
    await expect(
      localRepository.importAll(
        JSON.stringify({ version: 1, exportedAt: 0, patients: [], sessions: [], bloodPressures: [] }),
      ),
    ).resolves.toBeUndefined()

    expect(await tableCounts()).toEqual({
      patients: 0,
      dryWeights: 0,
      sessions: 0,
      bloodPressures: 0,
      bloodGlucoses: 0,
      bloodFlows: 0,
      adverseReactions: 0,
    })
  })

  it('成功导入后再导出：除 exportedAt 外与导入内容 deep equal（旧格式 session 顺带被补齐默认字段）', async () => {
    const patient = makePatient({ id: P2, name: '李四' })
    const legacy = makeSession({ id: 's-legacy', patientId: P2, date: '2023-12-01' })
    delete (legacy as Partial<typeof legacy>).status
    delete (legacy as Partial<typeof legacy>).abortedAt
    delete (legacy as Partial<typeof legacy>).abortTags
    delete (legacy as Partial<typeof legacy>).abortReason

    await localRepository.importAll(JSON.stringify({ version: 1, exportedAt: 0, patients: [patient], sessions: [legacy] }))

    const { exportedAt, ...rest } = JSON.parse(await localRepository.exportAll()) as Record<string, unknown>

    expect(typeof exportedAt).toBe('number') // 只有它每次都变
    expect(rest).toEqual({
      version: 1,
      patients: [patient],
      dryWeights: [],
      sessions: [{ ...legacy, status: 'ongoing', abortedAt: null, abortTags: [], abortReason: null }],
      bloodPressures: [],
      bloodGlucoses: [],
      bloodFlows: [],
      adverseReactions: [],
    })
  })
})

describe('本地旅程 · 删除记录（级联与隔离）', () => {
  /** 造两条各自带子数据的记录，返回它们的 id */
  async function seedTwoSessions() {
    await localRepository.savePatient(makePatient({ id: P1 }))
    await localRepository.saveSession(makeSession({ id: S1, patientId: P1, date: '2024-01-15' }))
    await localRepository.saveSession(makeSession({ id: S2, patientId: P1, date: '2024-01-22' }))

    await localRepository.saveBloodPressure(makeBp({ id: 'bp-s1a', sessionId: S1, measuredAt: 1 }))
    await localRepository.saveBloodPressure(makeBp({ id: 'bp-s1b', sessionId: S1, measuredAt: 2 }))
    await localRepository.saveBloodGlucose(makeBg({ id: 'bg-s1', sessionId: S1, measuredAt: 1 }))
    await localRepository.saveBloodFlow(makeBf({ id: 'bf-s1', sessionId: S1, measuredAt: 1 }))
    await localRepository.replaceAdverseReactions(S1, [makeReaction({ id: 'ar-s1', sessionId: S1, recordedAt: 1 })])

    await localRepository.saveBloodPressure(makeBp({ id: 'bp-s2', sessionId: S2, measuredAt: 1 }))
    await localRepository.saveBloodGlucose(makeBg({ id: 'bg-s2', sessionId: S2, measuredAt: 1 }))
    await localRepository.saveBloodFlow(makeBf({ id: 'bf-s2', sessionId: S2, measuredAt: 1 }))
    await localRepository.replaceAdverseReactions(S2, [makeReaction({ id: 'ar-s2', sessionId: S2, recordedAt: 1 })])
  }

  it('删除一条记录：它的四类子数据全没了，另一条记录的子数据完好', async () => {
    await seedTwoSessions()

    await localRepository.deleteSession(S1)

    expect(await localRepository.getSession(S1)).toBeUndefined()
    await expect(localRepository.listBloodPressures(S1)).resolves.toEqual([])
    await expect(localRepository.listBloodGlucoses(S1)).resolves.toEqual([])
    await expect(localRepository.listBloodFlows(S1)).resolves.toEqual([])
    await expect(localRepository.listAdverseReactions(S1)).resolves.toEqual([])

    // 另一条记录（含它的子数据）完全不受影响
    expect(await localRepository.getSession(S2)).toBeDefined()
    expect((await localRepository.listBloodPressures(S2)).map((b) => b.id)).toEqual(['bp-s2'])
    expect((await localRepository.listBloodGlucoses(S2)).map((b) => b.id)).toEqual(['bg-s2'])
    expect((await localRepository.listBloodFlows(S2)).map((b) => b.id)).toEqual(['bf-s2'])
    expect((await localRepository.listAdverseReactions(S2)).map((a) => a.id)).toEqual(['ar-s2'])

    // 表级计数也对得上
    expect(await db.bloodPressures.count()).toBe(1)
    expect(await db.adverseReactions.count()).toBe(1)
  })

  it('删除不存在的记录不抛错，也不影响已有数据', async () => {
    await seedTwoSessions()

    await expect(localRepository.deleteSession('不存在')).resolves.toBeUndefined()

    expect(await localRepository.listSessions(P1)).toHaveLength(2)
    expect(await db.bloodPressures.count()).toBe(3)
  })
})

describe('本地旅程 · 跨病人隔离', () => {
  async function seedTwoPatients() {
    await localRepository.savePatient(makePatient({ id: P1, name: '张三' }))
    await localRepository.savePatient(makePatient({ id: P2, name: '李四' }))
    await localRepository.saveSession(makeSession({ id: S1, patientId: P1, date: '2024-01-15' }))
    await localRepository.saveSession(makeSession({ id: S2, patientId: P2, date: '2024-02-15' }))
    await localRepository.saveDryWeight(
      makeDryWeight({ id: 'dw-p1', patientId: P1, value: 60, effectiveDate: '2024-01-01' }),
    )
    await localRepository.saveDryWeight(
      makeDryWeight({ id: 'dw-p2', patientId: P2, value: 55, effectiveDate: '2024-01-01' }),
    )
    await localRepository.saveBloodPressure(makeBp({ id: 'bp-p1', sessionId: S1, measuredAt: 1 }))
    await localRepository.saveBloodPressure(makeBp({ id: 'bp-p2', sessionId: S2, measuredAt: 1 }))
  }

  it('两个病人的 session / 干体重 / 子数据互不可见', async () => {
    await seedTwoPatients()

    expect((await localRepository.listSessions(P1)).map((s) => s.id)).toEqual([S1])
    expect((await localRepository.listSessions(P2)).map((s) => s.id)).toEqual([S2])

    expect((await localRepository.listDryWeights(P1)).map((d) => d.id)).toEqual(['dw-p1'])
    expect((await localRepository.listDryWeights(P2)).map((d) => d.id)).toEqual(['dw-p2'])

    expect(getEffectiveDryWeight(await localRepository.listDryWeights(P1), '2024-06-01')).toBe(60)
    expect(getEffectiveDryWeight(await localRepository.listDryWeights(P2), '2024-06-01')).toBe(55)

    expect((await localRepository.listBloodPressures(S1)).map((b) => b.id)).toEqual(['bp-p1'])
    expect((await localRepository.listBloodPressures(S2)).map((b) => b.id)).toEqual(['bp-p2'])
  })

  it('删除一个病人的记录不影响另一个病人', async () => {
    await seedTwoPatients()

    await localRepository.deleteSession(S1)

    expect(await localRepository.listSessions(P1)).toEqual([])
    expect((await localRepository.listSessions(P2)).map((s) => s.id)).toEqual([S2])
    expect((await localRepository.listDryWeights(P1)).map((d) => d.id)).toEqual(['dw-p1'])
    expect(await db.bloodPressures.count()).toBe(1)
  })

  it('默认病人 id（本地单机）与云端 uuid 形态的病人可以共存于同一张表', async () => {
    await localRepository.savePatient(makePatient({ id: DEFAULT_PATIENT_ID, name: '本机档案' }))
    await localRepository.savePatient(makePatient({ id: '9f1c2f7e-0000-4000-8000-000000000001', name: '云端档案' }))
    await localRepository.saveSession(makeSession({ id: 's-local', patientId: DEFAULT_PATIENT_ID, date: todayStr() }))

    expect(await db.patients.count()).toBe(2)
    expect((await localRepository.listSessions(DEFAULT_PATIENT_ID)).map((s) => s.id)).toEqual(['s-local'])
    expect(await localRepository.listSessions('9f1c2f7e-0000-4000-8000-000000000001')).toEqual([])
    expect(dateStr(combineDateTime(todayStr(), '00:00'))).toBe(todayStr())
  })
})

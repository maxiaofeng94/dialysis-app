/**
 * cloudRepository（Supabase 云端仓储）测试
 *
 * 用 tests/helpers/fakeSupabase.ts 的可编程 PostgREST 替身注入 `src/lib/supabase`。
 * 注入方式：mock 工厂返回的模块里 `supabase` 是 getter，读的是 hoisted 容器里的当前
 * fake client —— 这样既能在每个用例里换一份干净的表数据，也能模拟「云端未配置」
 * （容器置 null → requireClient 抛错）。
 *
 * 断言重点：snake_case ↔ camelCase 双向映射、排序/过滤参数、写方法必须把错误抛出来、
 * 不良反应整体替换的调用顺序（先读旧 id → 再 upsert → 最后删列表外的），
 * 以及病人档案走 upsert（回归：曾经用 update + eq(id)，命中 0 行时静默丢失改动）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fakeSupabaseModule, makeQuery, makeAuthClient } from '../helpers/cloud'
import { makeFakeSupabase, type FakeSupabase, type FakeSupabaseOptions } from '../helpers/fakeSupabase'
import { makePatient, makeDryWeight, makeSession, makeBp, makeBg, makeBf, makeReaction } from '../helpers/factories'

const hoisted = vi.hoisted(() => {
  const state: { client: unknown } = { client: null }
  /** 转发到当前 fake client 的代理：cloudRepository 只在调用时才读 supabase */
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        const c = state.client as Record<string, unknown> | null
        if (!c) throw new Error('fake supabase 未初始化')
        const v = c[prop as string]
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(c) : v
      },
    },
  )
  return { state, proxy }
})

vi.mock('../../src/lib/supabase', () => {
  const mod = fakeSupabaseModule({ configure: true, client: hoisted.proxy as object })
  Object.defineProperty(mod, 'supabase', {
    get: () => (hoisted.state.client ? (hoisted.proxy as object) : null),
    configurable: true,
    enumerable: true,
  })
  return mod
})

import { cloudRepository } from '../../src/lib/cloudRepository'

interface OrderCall {
  table: string
  col: string
  ascending: boolean | undefined
}
interface SelectCall {
  table: string
  cols: string
}

/** 在 fake client 上挂一层记录：把 select 的列清单与 order 的参数记下来（fake 自身不记录） */
function instrument(client: any, log: { orders: OrderCall[]; selects: SelectCall[] }) {
  const origFrom = client.from.bind(client)
  client.from = (table: string) => {
    const builder = origFrom(table)
    const origSelect = builder.select.bind(builder)
    const origOrder = builder.order.bind(builder)
    builder.select = (cols = '*', o?: unknown) => {
      log.selects.push({ table, cols })
      return origSelect(cols, o)
    }
    builder.order = (col: string, o?: { ascending?: boolean }) => {
      log.orders.push({ table, col, ascending: o?.ascending })
      return origOrder(col, o)
    }
    return builder
  }
}

/** 每个用例换一份干净的 fake，并把「当前 client」指过去 */
function setupFake(opts: FakeSupabaseOptions = {}): {
  fake: FakeSupabase
  log: { orders: OrderCall[]; selects: SelectCall[] }
} {
  const fake = makeFakeSupabase(opts)
  const log = { orders: [] as OrderCall[], selects: [] as SelectCall[] }
  instrument(fake.client, log)
  hoisted.state.client = fake.client
  return { fake, log }
}

/** 让当前登录用户是 u1（saveSession 会读它填 operator_id） */
function loginAs(fake: FakeSupabase, id = 'u1') {
  fake.client.auth.getUser.mockResolvedValue({ data: { user: id ? { id } : null }, error: null })
}

beforeEach(() => {
  hoisted.state.client = null
})

describe('cloudRepository · 病人映射（snake_case → camelCase）', () => {
  const row = {
    id: 'p1',
    name: '张三',
    birthday: '1950-06-01',
    wheelchair_weight: 20.5,
    rinse_back_volume: 300,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-02-01T00:00:00.000Z',
  }

  it('下划线列名映射成驼峰字段，时间字符串映射成毫秒时间戳', async () => {
    const { fake } = setupFake({ tables: { patients: [row] } })

    const p = await cloudRepository.getPatient('p1')

    expect(p).toEqual({
      id: 'p1',
      name: '张三',
      birthday: '1950-06-01',
      wheelchairWeight: 20.5,
      rinseBackVolume: 300,
      createdAt: new Date('2024-01-01T00:00:00.000Z').getTime(),
      updatedAt: new Date('2024-02-01T00:00:00.000Z').getTime(),
    })
    expect(fake.lastCall('patients')!.filters).toEqual([{ col: 'id', val: 'p1' }])
  })

  it('缺 birthday 时映射为空串（不是 undefined）', async () => {
    setupFake({ tables: { patients: [{ ...row, birthday: null }] } })

    const p = await cloudRepository.getPatient('p1')
    expect(p?.birthday).toBe('')
  })

  it('缺 wheelchair_weight / rinse_back_volume 时用默认值 0 / 300', async () => {
    setupFake({
      tables: {
        patients: [
          { id: 'p1', name: '张三', birthday: '1950-06-01', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
        ],
      },
    })
    const p = await cloudRepository.getPatient('p1')
    expect(p?.wheelchairWeight).toBe(0)
    expect(p?.rinseBackVolume).toBe(300)
  })

  it('数值列是字符串时也转成 number（PostgREST numeric 返回字符串的场景）', async () => {
    setupFake({ tables: { patients: [{ ...row, wheelchair_weight: '21.5', rinse_back_volume: '250' }] } })

    const p = await cloudRepository.getPatient('p1')
    expect(p?.wheelchairWeight).toBe(21.5)
    expect(p?.rinseBackVolume).toBe(250)
  })

  it('maybeSingle 查不到数据时返回 undefined', async () => {
    setupFake({ tables: { patients: [] } })

    expect(await cloudRepository.getPatient('不存在')).toBeUndefined()
  })
})

describe('cloudRepository · 记录人显示名', () => {
  /** 造一条带 operator 关联的行 */
  function sessionRow(operator: unknown) {
    return {
      id: 's1',
      patient_id: 'p1',
      date: '2024-05-01',
      pre_weight_measured: 80,
      post_weight_measured: null,
      wheelchair_weight_used: 20,
      rinse_back_volume_used: 300,
      doctor_uf: null,
      status: 'ongoing',
      aborted_at: null,
      abort_tags: [],
      abort_reason: null,
      notes: null,
      created_at: '2024-05-01T08:00:00.000Z',
      updated_at: '2024-05-01T09:00:00.000Z',
      operator,
    }
  }

  it('operator.name 优先显示', async () => {
    setupFake({ tables: { sessions: [sessionRow({ name: '李护士', phone: '13800000000' })] } })

    expect((await cloudRepository.getSession('s1'))?.operator).toBe('李护士')
  })

  it('name 为空串时退回手机号', async () => {
    setupFake({ tables: { sessions: [sessionRow({ name: '', phone: '13800000000' })] } })

    expect((await cloudRepository.getSession('s1'))?.operator).toBe('13800000000')
  })

  it('name 为 null 时退回手机号', async () => {
    setupFake({ tables: { sessions: [sessionRow({ name: null, phone: '13900000000' })] } })

    expect((await cloudRepository.getSession('s1'))?.operator).toBe('13900000000')
  })

  it('没有关联到用户（operator 为 null）时是 null', async () => {
    setupFake({ tables: { sessions: [sessionRow(null)] } })

    expect((await cloudRepository.getSession('s1'))?.operator).toBeNull()
  })

  it('关联到了用户但姓名与手机号都为空时也是 null', async () => {
    setupFake({ tables: { sessions: [sessionRow({ name: null, phone: null })] } })

    expect((await cloudRepository.getSession('s1'))?.operator).toBeNull()
  })
})

describe('cloudRepository · session 字段映射', () => {
  it('date / 中止字段 / 体重的空值映射', async () => {
    setupFake({
      tables: {
        sessions: [
          {
            id: 's1',
            patient_id: 'p1',
            date: '2024-05-01',
            pre_weight_measured: null,
            post_weight_measured: '78.5',
            wheelchair_weight_used: null,
            rinse_back_volume_used: null,
            doctor_uf: '2.5',
            status: 'aborted',
            aborted_at: '2024-05-01T10:30:00.000Z',
            abort_tags: ['hypotension', 'other'],
            abort_reason: '血压掉到 80/50',
            notes: '备注',
            created_at: '2024-05-01T08:00:00.000Z',
            updated_at: '2024-05-01T10:30:00.000Z',
            operator: null,
          },
        ],
      },
    })

    const s = await cloudRepository.getSession('s1')

    expect(s).toMatchObject({
      id: 's1',
      patientId: 'p1',
      date: '2024-05-01',
      preWeightMeasured: null,
      postWeightMeasured: 78.5,
      wheelchairWeightUsed: 0, // 该列为 null 时退回 0
      rinseBackVolumeUsed: 300, // 该列为 null 时退回 300
      doctorUf: 2.5,
      status: 'aborted',
      abortedAt: new Date('2024-05-01T10:30:00.000Z').getTime(),
      abortTags: ['hypotension', 'other'],
      abortReason: '血压掉到 80/50',
      notes: '备注',
      createdAt: new Date('2024-05-01T08:00:00.000Z').getTime(),
      updatedAt: new Date('2024-05-01T10:30:00.000Z').getTime(),
    })
  })

  it('pre_weight_measured = 0 时保留 0（不能被当成空值）', async () => {
    setupFake({
      tables: {
        sessions: [
          {
            id: 's0',
            patient_id: 'p1',
            date: '2024-05-01',
            pre_weight_measured: 0,
            post_weight_measured: 0,
            wheelchair_weight_used: 0,
            rinse_back_volume_used: 0,
            doctor_uf: 0,
            status: 'completed',
            aborted_at: null,
            abort_tags: [],
            abort_reason: null,
            notes: null,
            created_at: '2024-05-01T08:00:00.000Z',
            updated_at: '2024-05-01T08:00:00.000Z',
            operator: null,
          },
        ],
      },
    })

    const s = await cloudRepository.getSession('s0')
    expect(s?.preWeightMeasured).toBe(0)
    expect(s?.postWeightMeasured).toBe(0)
    expect(s?.doctorUf).toBe(0)
  })

  it('aborted_at 为 null 时映射成 null（不是 NaN）', async () => {
    setupFake({
      tables: {
        sessions: [
          {
            id: 's1',
            patient_id: 'p1',
            date: '2024-05-01',
            pre_weight_measured: 80,
            post_weight_measured: null,
            wheelchair_weight_used: 20,
            rinse_back_volume_used: 300,
            doctor_uf: null,
            status: 'ongoing',
            aborted_at: null,
            abort_tags: [],
            abort_reason: null,
            notes: null,
            created_at: '2024-05-01T08:00:00.000Z',
            updated_at: '2024-05-01T08:00:00.000Z',
            operator: null,
          },
        ],
      },
    })

    const s = await cloudRepository.getSession('s1')
    expect(s?.abortedAt).toBeNull()
    expect(s?.abortReason).toBeNull()
  })

  it('abort_tags 不是数组（历史脏数据）时映射为空数组', async () => {
    setupFake({
      tables: {
        sessions: [
          {
            id: 's-dirty',
            patient_id: 'p1',
            date: '2024-05-01',
            pre_weight_measured: 80,
            post_weight_measured: null,
            wheelchair_weight_used: 20,
            rinse_back_volume_used: 300,
            doctor_uf: null,
            status: 'aborted',
            aborted_at: null,
            abort_tags: 'hypotension',
            abort_reason: null,
            notes: null,
            created_at: '2024-05-01T08:00:00.000Z',
            updated_at: '2024-05-01T08:00:00.000Z',
            operator: null,
          },
        ],
      },
    })

    const s = await cloudRepository.getSession('s-dirty')
    expect(s?.abortTags).toEqual([])
  })

  it('getSession 查不到返回 undefined；列表查空返回 []', async () => {
    setupFake({ tables: { sessions: [] } })

    expect(await cloudRepository.getSession('s404')).toBeUndefined()
    expect(await cloudRepository.listSessions('p1')).toEqual([])
  })

  it('listSessions 带出记录人关联列，并按 patient_id 过滤', async () => {
    const { fake, log } = setupFake({ tables: { sessions: [] } })

    await cloudRepository.listSessions('p1')

    expect(log.selects).toEqual([{ table: 'sessions', cols: '*, operator:users(name, phone)' }])
    expect(fake.lastCall('sessions')!.filters).toEqual([{ col: 'patient_id', val: 'p1' }])
  })

  it('listSessions 请求 date 倒序，且被 fake 真实应用（乱序数据 → 降序结果）', async () => {
    const base = {
      patient_id: 'p1',
      pre_weight_measured: 80,
      post_weight_measured: null,
      wheelchair_weight_used: 20,
      rinse_back_volume_used: 300,
      doctor_uf: null,
      status: 'ongoing',
      aborted_at: null,
      abort_tags: [],
      abort_reason: null,
      notes: null,
      created_at: '2024-05-01T08:00:00.000Z',
      updated_at: '2024-05-01T08:00:00.000Z',
      operator: null,
    }
    const { log } = setupFake({
      tables: {
        sessions: [
          { ...base, id: 's-mid', date: '2024-03-01' },
          { ...base, id: 's-new', date: '2024-06-01' },
          { ...base, id: 's-old', date: '2024-01-01' },
        ],
      },
    })

    const list = await cloudRepository.listSessions('p1')

    // 主键 date 倒序 + 二级键 created_at 倒序（与本地 localRepository.listSessions 同口径：
    // 同一天的多条记录两边顺序必须一致，否则用户会觉得记录在「跳」）
    expect(log.orders).toEqual([
      { table: 'sessions', col: 'date', ascending: false },
      { table: 'sessions', col: 'created_at', ascending: false },
    ])
    expect(list.map((s) => s.id)).toEqual(['s-new', 's-mid', 's-old'])
  })

  it('同一天的多条记录按 created_at 倒序（新记的在前）', async () => {
    const row = (id: string, createdAt: string) => ({
      id,
      patient_id: 'p1',
      date: '2024-06-01',
      pre_weight_measured: 80,
      post_weight_measured: null,
      wheelchair_weight_used: 20,
      rinse_back_volume_used: 300,
      doctor_uf: null,
      status: 'ongoing',
      aborted_at: null,
      abort_tags: [],
      abort_reason: null,
      notes: null,
      created_at: createdAt,
      updated_at: createdAt,
      operator: null,
    })
    setupFake({
      tables: {
        sessions: [
          row('s-early', '2024-06-01T08:00:00.000Z'),
          row('s-late', '2024-06-01T20:00:00.000Z'),
        ],
      },
    })

    const list = await cloudRepository.listSessions('p1')

    expect(list.map((s) => s.id)).toEqual(['s-late', 's-early'])
  })
})

describe('cloudRepository · saveSession 写入行', () => {
  it('operator_id 取当前登录用户，aborted_at 转 ISO 字符串，updated_at 被刷新', async () => {
    const { fake } = setupFake({ tables: { sessions: [] } })
    loginAs(fake, 'u1')
    const before = Date.now()

    await cloudRepository.saveSession(
      makeSession({
        id: 's1',
        patientId: 'p1',
        status: 'aborted',
        abortedAt: 1_700_000_500_000,
        abortTags: ['cramp'],
        abortReason: '抽筋',
        postWeightMeasured: 78.5,
      }),
    )

    const call = fake.lastCall('sessions')!
    expect(call.op).toBe('upsert')
    const row = call.payload
    expect(row).toMatchObject({
      id: 's1',
      patient_id: 'p1',
      operator_id: 'u1',
      status: 'aborted',
      abort_tags: ['cramp'],
      abort_reason: '抽筋',
      aborted_at: new Date(1_700_000_500_000).toISOString(),
      pre_weight_measured: 80,
      post_weight_measured: 78.5,
    })
    expect(Date.parse(row.updated_at)).toBeGreaterThanOrEqual(before)
    expect(row.updated_at).toBe(new Date(row.updated_at).toISOString())
  })

  it('未中止时 aborted_at 写 null', async () => {
    const { fake } = setupFake({ tables: { sessions: [] } })
    loginAs(fake, 'u1')

    await cloudRepository.saveSession(makeSession({ id: 's1', status: 'ongoing', abortedAt: null }))

    expect(fake.lastCall('sessions')!.payload.aborted_at).toBeNull()
  })

  it('abortTags 缺失（历史数据）时写空数组而不是 undefined', async () => {
    const { fake } = setupFake({ tables: { sessions: [] } })
    loginAs(fake, 'u1')

    await cloudRepository.saveSession(makeSession({ id: 's1', abortTags: undefined as unknown as string[] }))

    expect(fake.lastCall('sessions')!.payload.abort_tags).toEqual([])
  })

  it('未登录（getUser 拿不到用户）时 operator_id 写 null，不抛错', async () => {
    const { fake } = setupFake({ tables: { sessions: [] } })
    fake.client.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })

    await expect(cloudRepository.saveSession(makeSession({ id: 's1' }))).resolves.toBeUndefined()

    expect(fake.lastCall('sessions')!.payload.operator_id).toBeNull()
  })

  it('云端报错时 saveSession 必须抛出来（不能静默丢数据）', async () => {
    setupFake({
      failOn: (call) => (call.table === 'sessions' && call.op === 'upsert' ? { message: 'RLS 拒绝' } : null),
    })

    await expect(cloudRepository.saveSession(makeSession({ id: 's1' }))).rejects.toMatchObject({ message: 'RLS 拒绝' })
  })
})

describe('cloudRepository · 子表映射与排序', () => {
  it('血压：session_id → sessionId，measured_at → 时间戳，按 measured_at 升序', async () => {
    const { log } = setupFake({
      tables: {
        blood_pressures: [
          { id: 'bp-late', session_id: 's1', measured_at: '2024-05-01T10:00:00.000Z', systolic: 150, diastolic: 90, note: '高' },
          { id: 'bp-early', session_id: 's1', measured_at: '2024-05-01T08:00:00.000Z', systolic: 120, diastolic: 70, note: null },
        ],
      },
    })

    const list = await cloudRepository.listBloodPressures('s1')

    expect(list.map((b) => b.id)).toEqual(['bp-early', 'bp-late'])
    expect(list[0]).toEqual({
      id: 'bp-early',
      sessionId: 's1',
      measuredAt: new Date('2024-05-01T08:00:00.000Z').getTime(),
      systolic: 120,
      diastolic: 70,
      note: null,
    })
    expect(log.orders).toEqual([{ table: 'blood_pressures', col: 'measured_at', ascending: true }])
  })

  it('血糖：value 转数字，按 measured_at 升序', async () => {
    setupFake({
      tables: {
        blood_glucoses: [
          { id: 'bg2', session_id: 's1', measured_at: '2024-05-01T11:00:00.000Z', value: '7.2', note: null },
          { id: 'bg1', session_id: 's1', measured_at: '2024-05-01T09:00:00.000Z', value: '5.6', note: '空腹' },
        ],
      },
    })

    const list = await cloudRepository.listBloodGlucoses('s1')
    expect(list.map((g) => g.id)).toEqual(['bg1', 'bg2'])
    expect(list[1].value).toBe(7.2)
    expect(list[0].note).toBe('空腹')
  })

  it('血流量：value 转数字，按 measured_at 升序', async () => {
    setupFake({
      tables: {
        blood_flows: [
          { id: 'bf2', session_id: 's1', measured_at: '2024-05-01T11:00:00.000Z', value: '250', note: null },
          { id: 'bf1', session_id: 's1', measured_at: '2024-05-01T09:00:00.000Z', value: '200', note: null },
        ],
      },
    })

    const list = await cloudRepository.listBloodFlows('s1')
    expect(list.map((f) => f.id)).toEqual(['bf1', 'bf2'])
    expect(list[0].value).toBe(200)
  })

  it('不良反应：recorded_at → recordedAt，按 recorded_at 升序', async () => {
    const { log } = setupFake({
      tables: {
        adverse_reactions: [
          { id: 'ar2', session_id: 's1', type: 'vomit', detail: null, severity: 'severe', recorded_at: '2024-05-01T11:00:00.000Z' },
          { id: 'ar1', session_id: 's1', type: 'cramp', detail: '小腿', severity: 'mild', recorded_at: '2024-05-01T09:00:00.000Z' },
        ],
      },
    })

    const list = await cloudRepository.listAdverseReactions('s1')
    expect(list.map((a) => a.id)).toEqual(['ar1', 'ar2'])
    expect(list[0]).toEqual({
      id: 'ar1',
      sessionId: 's1',
      type: 'cramp',
      detail: '小腿',
      severity: 'mild',
      recordedAt: new Date('2024-05-01T09:00:00.000Z').getTime(),
    })
    expect(log.orders).toEqual([{ table: 'adverse_reactions', col: 'recorded_at', ascending: true }])
  })

  it('干体重：patient_id/effective_date 映射，按 effective_date 倒序', async () => {
    const { log } = setupFake({
      tables: {
        dry_weights: [
          { id: 'd-old', patient_id: 'p1', value: '61', effective_date: '2024-01-01', note: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
          { id: 'd-new', patient_id: 'p1', value: '59.5', effective_date: '2024-06-01', note: '下调', created_at: '2024-06-01T00:00:00Z', updated_at: '2024-06-01T00:00:00Z' },
        ],
      },
    })

    const list = await cloudRepository.listDryWeights('p1')

    expect(list.map((d) => d.id)).toEqual(['d-new', 'd-old'])
    expect(list[0]).toMatchObject({ patientId: 'p1', value: 59.5, effectiveDate: '2024-06-01', note: '下调' })
    expect(log.orders).toEqual([{ table: 'dry_weights', col: 'effective_date', ascending: false }])
    expect(log.selects).toEqual([{ table: 'dry_weights', cols: '*' }])
  })
})

describe('cloudRepository · 写方法与错误传播', () => {
  it('savePatient 走 upsert，birthday 空串写 null，updated_at 刷新', async () => {
    const { fake } = setupFake({
      tables: {
        patients: [
          { id: 'p1', name: '旧名', birthday: '1950-06-01', wheelchair_weight: 20, rinse_back_volume: 300, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
        ],
      },
    })
    const before = Date.now()

    await cloudRepository.savePatient(makePatient({ id: 'p1', name: '新名', birthday: '' }))

    expect(fake.callsOn('patients')).toHaveLength(1)
    const call = fake.lastCall('patients')!
    // 回归：曾经是 update().eq('id', …)，命中 0 行（行不存在 / 被 RLS 静默过滤）时 PostgREST 不报错，
    // 档案改动会「看起来保存成功，其实没写进去」——现在改成 upsert，主键冲突交给数据库仲裁
    expect(call.op).toBe('upsert')
    expect(call.filters).toEqual([]) // 不再有 eq('id', …) 过滤
    expect(call.payload).toEqual({
      id: 'p1',
      name: '新名',
      birthday: null,
      wheelchair_weight: 20,
      rinse_back_volume: 300,
      updated_at: expect.any(String),
    })
    expect(Date.parse(call.payload.updated_at)).toBeGreaterThanOrEqual(before)
    expect(call.payload.updated_at).toBe(new Date(call.payload.updated_at).toISOString())
    // 原有那一行被就地更新，而不是又插一行
    expect(fake.tables.patients).toHaveLength(1)
    expect(fake.tables.patients[0]).toMatchObject({ id: 'p1', name: '新名', birthday: null })
  })

  it('savePatient 对库中还不存在的档案也会真的写进去（回归：曾经 update 命中 0 行 → 静默丢弃）', async () => {
    const { fake } = setupFake({ tables: { patients: [] } })

    await cloudRepository.savePatient(makePatient({ id: 'p-new', name: '新档案' }))

    const call = fake.lastCall('patients')!
    expect(call.op).toBe('upsert')
    expect(call.filters).toEqual([])
    expect(fake.tables.patients).toEqual([expect.objectContaining({ id: 'p-new', name: '新档案' })])
  })

  it('savePatient 报错时抛出', async () => {
    setupFake({
      failOn: (call) => (call.table === 'patients' && call.op === 'upsert' ? { message: '无权限修改' } : null),
    })

    await expect(cloudRepository.savePatient(makePatient({ id: 'p1' }))).rejects.toMatchObject({ message: '无权限修改' })
  })

  it('saveDryWeight 走 upsert，字段映射为 snake_case 且 updated_at 刷新', async () => {
    const { fake } = setupFake({ tables: { dry_weights: [] } })

    await cloudRepository.saveDryWeight(
      makeDryWeight({ id: 'd1', patientId: 'p1', value: 59.5, effectiveDate: '2024-06-01', note: '下调' }),
    )

    const call = fake.lastCall('dry_weights')!
    expect(call.op).toBe('upsert')
    expect(call.payload).toMatchObject({
      id: 'd1',
      patient_id: 'p1',
      value: 59.5,
      effective_date: '2024-06-01',
      note: '下调',
    })
    expect(Number.isNaN(Date.parse(call.payload.updated_at))).toBe(false)
  })

  it('saveBloodPressure 把 measuredAt 转成 ISO 字符串', async () => {
    const { fake } = setupFake({ tables: { blood_pressures: [] } })

    await cloudRepository.saveBloodPressure(makeBp({ id: 'bp1', sessionId: 's1', measuredAt: 1_700_000_100_000 }))

    expect(fake.lastCall('blood_pressures')!.payload).toEqual({
      id: 'bp1',
      session_id: 's1',
      measured_at: new Date(1_700_000_100_000).toISOString(),
      systolic: 130,
      diastolic: 80,
      note: null,
    })
  })

  it('saveBloodGlucose / saveBloodFlow 走 upsert 且字段映射正确', async () => {
    const { fake } = setupFake({ tables: { blood_glucoses: [], blood_flows: [] } })

    await cloudRepository.saveBloodGlucose(makeBg({ id: 'bg1', sessionId: 's1', measuredAt: 1_700_000_100_000 }))
    await cloudRepository.saveBloodFlow(makeBf({ id: 'bf1', sessionId: 's1', measuredAt: 1_700_000_100_000 }))

    expect(fake.lastCall('blood_glucoses')!.payload).toMatchObject({
      id: 'bg1',
      session_id: 's1',
      measured_at: new Date(1_700_000_100_000).toISOString(),
      value: 6.5,
    })
    expect(fake.lastCall('blood_flows')!.payload).toMatchObject({
      id: 'bf1',
      session_id: 's1',
      value: 250,
    })
  })

  it('三个写操作（干体重/血压/血糖）出错都必须抛出', async () => {
    setupFake({ failOn: (call) => (call.op === 'upsert' ? { message: '写入失败' } : null) })

    await expect(cloudRepository.saveDryWeight(makeDryWeight())).rejects.toMatchObject({ message: '写入失败' })
    await expect(cloudRepository.saveBloodPressure(makeBp())).rejects.toMatchObject({ message: '写入失败' })
    await expect(cloudRepository.saveBloodGlucose(makeBg())).rejects.toMatchObject({ message: '写入失败' })
    await expect(cloudRepository.saveBloodFlow(makeBf())).rejects.toMatchObject({ message: '写入失败' })
  })

  it('删除方法都走 delete + eq(id) + select(id)，且错误抛出', async () => {
    const { fake } = setupFake({
      tables: {
        dry_weights: [{ id: 'd1' }],
        blood_pressures: [{ id: 'bp1' }],
        blood_glucoses: [{ id: 'bg1' }],
        blood_flows: [{ id: 'bf1' }],
        sessions: [{ id: 's1' }],
      },
    })

    await cloudRepository.deleteDryWeight('d1')
    await cloudRepository.deleteBloodPressure('bp1')
    await cloudRepository.deleteBloodGlucose('bg1')
    await cloudRepository.deleteBloodFlow('bf1')
    await cloudRepository.deleteSession('s1')

    expect(fake.lastCall('dry_weights')).toMatchObject({ op: 'delete', filters: [{ col: 'id', val: 'd1' }] })
    expect(fake.lastCall('blood_pressures')!.filters).toEqual([{ col: 'id', val: 'bp1' }])
    expect(fake.lastCall('blood_glucoses')!.filters).toEqual([{ col: 'id', val: 'bg1' }])
    expect(fake.lastCall('blood_flows')!.filters).toEqual([{ col: 'id', val: 'bf1' }])
    expect(fake.lastCall('sessions')!.filters).toEqual([{ col: 'id', val: 's1' }])

    setupFake({ failOn: (call) => (call.op === 'delete' ? { message: '删除被 RLS 拦截' } : null) })
    await expect(cloudRepository.deleteSession('s1')).rejects.toMatchObject({ message: '删除被 RLS 拦截' })
    await expect(cloudRepository.deleteDryWeight('d1')).rejects.toMatchObject({ message: '删除被 RLS 拦截' })
    await expect(cloudRepository.deleteBloodPressure('bp1')).rejects.toMatchObject({ message: '删除被 RLS 拦截' })
    await expect(cloudRepository.deleteBloodGlucose('bg1')).rejects.toMatchObject({ message: '删除被 RLS 拦截' })
    await expect(cloudRepository.deleteBloodFlow('bf1')).rejects.toMatchObject({ message: '删除被 RLS 拦截' })
  })

  it('删除命中 0 行（RLS 静默过滤 / 已被他人删除）→ 抛错，绝不假装删成功', async () => {
    // 回归：RLS 把无权限的删除过滤掉时同样返回 204、error 为 null，
    // 前端曾据此清缓存并跳回首页 —— 几秒后记录又「复活」。
    setupFake({ tables: { sessions: [], dry_weights: [], blood_pressures: [], blood_glucoses: [], blood_flows: [] } })

    await expect(cloudRepository.deleteSession('not-mine')).rejects.toThrow('删除记录失败：可能没有修改权限')
    await expect(cloudRepository.deleteDryWeight('not-mine')).rejects.toThrow('删除干体重失败')
    await expect(cloudRepository.deleteBloodPressure('not-mine')).rejects.toThrow('删除血压失败')
    await expect(cloudRepository.deleteBloodGlucose('not-mine')).rejects.toThrow('删除血糖失败')
    await expect(cloudRepository.deleteBloodFlow('not-mine')).rejects.toThrow('删除血流量失败')
  })
})

describe('cloudRepository · 读接口必须区分「查询失败」与「没有数据」', () => {
  it('所有读方法在查询报错时抛错（不能静默返回空，否则界面显示「记录全没了」）', async () => {
    setupFake({ failOn: (call) => (call.op === 'select' ? { message: '连接超时' } : null) })

    await expect(cloudRepository.getPatient('p1')).rejects.toThrow('连接超时')
    await expect(cloudRepository.listDryWeights('p1')).rejects.toThrow('连接超时')
    await expect(cloudRepository.listSessions('p1')).rejects.toThrow('连接超时')
    await expect(cloudRepository.getSession('s1')).rejects.toThrow('连接超时')
    await expect(cloudRepository.listBloodPressures('s1')).rejects.toThrow('连接超时')
    await expect(cloudRepository.listBloodGlucoses('s1')).rejects.toThrow('连接超时')
    await expect(cloudRepository.listBloodFlows('s1')).rejects.toThrow('连接超时')
    await expect(cloudRepository.listAdverseReactions('s1')).rejects.toThrow('连接超时')
  })

  it('exportAll 只要有一张表查询失败就抛错（不能静默产出空备份）', async () => {
    setupFake({ failOn: (call) => (call.table === 'blood_pressures' ? { message: 'boom' } : null) })

    await expect(cloudRepository.exportAll()).rejects.toThrow('导出失败（血压）：boom')
  })
})

describe('cloudRepository · replaceAdverseReactions', () => {
  /** 库里已有的一行（默认属于 s1；传 s2 用来验证「只动本次 session」） */
  const oldRow = (id: string, sessionId = 's1') => ({
    id,
    session_id: sessionId,
    type: 'vomit',
    detail: null,
    severity: 'mild',
    recorded_at: '2024-01-01T00:00:00Z',
  })

  it('顺序是「读旧 id → upsert 新列表 → 只删列表外的旧记录」', async () => {
    const { fake, log } = setupFake({
      tables: { adverse_reactions: [oldRow('old'), oldRow('other', 's2')] },
    })

    await cloudRepository.replaceAdverseReactions('s1', [
      makeReaction({ id: 'a1', sessionId: 's1', type: 'cramp', recordedAt: 1_700_000_100_000 }),
      makeReaction({ id: 'a2', sessionId: 's1', type: 'dizziness', recordedAt: 1_700_000_200_000 }),
    ])

    const calls = fake.callsOn('adverse_reactions')
    // 回归：曾经是「先 delete 全删、再 insert」，insert 一失败原有不良反应就整批丢掉；顺序已改成读 → 写 → 删
    expect(calls.map((c) => c.op)).toEqual(['select', 'upsert', 'delete'])
    // 1. 先读旧 id：只取 id 列，按 session_id 过滤
    expect(log.selects).toEqual([{ table: 'adverse_reactions', cols: 'id' }])
    expect(calls[0].filters).toEqual([{ col: 'session_id', val: 's1' }])
    // 2. 再整体写新列表（upsert，不是 insert）
    expect(calls[1].payload).toEqual([
      { id: 'a1', session_id: 's1', type: 'cramp', detail: null, severity: 'mild', recorded_at: new Date(1_700_000_100_000).toISOString() },
      { id: 'a2', session_id: 's1', type: 'dizziness', detail: null, severity: 'mild', recorded_at: new Date(1_700_000_200_000).toISOString() },
    ])
    // 3. 最后才删「旧的、且这次不在列表里」的那条：按 id 列表（.in），不再按 session_id 全删
    expect(calls[2].filters).toEqual([])
    // 'old' 被删、'a1'/'a2' 留下，另一条 session 的记录不受影响
    expect(fake.tables.adverse_reactions.map((r) => r.id)).toEqual(['other', 'a1', 'a2'])
  })

  it('upsert 失败时一条旧记录都不能被删（回归：曾经先全删再插入，写失败即丢光）', async () => {
    const { fake } = setupFake({
      tables: { adverse_reactions: [oldRow('old-a'), oldRow('old-b')] },
      failOn: (call) => (call.table === 'adverse_reactions' && call.op === 'upsert' ? { message: '写入失败' } : null),
    })

    await expect(
      cloudRepository.replaceAdverseReactions('s1', [makeReaction({ id: 'a1', sessionId: 's1' })]),
    ).rejects.toMatchObject({ message: '写入失败' })

    // 连 delete 都没发出：旧数据一条不少地留在库里
    expect(fake.callsOn('adverse_reactions').map((c) => c.op)).toEqual(['select', 'upsert'])
    expect(fake.tables.adverse_reactions.map((r) => r.id)).toEqual(['old-a', 'old-b'])
  })

  it('传空数组时不 upsert，但把该 session 的旧记录全删掉（别的 session 不动）', async () => {
    const { fake } = setupFake({
      tables: { adverse_reactions: [oldRow('old-a'), oldRow('old-b'), oldRow('other', 's2')] },
    })

    await cloudRepository.replaceAdverseReactions('s1', [])

    expect(fake.callsOn('adverse_reactions').map((c) => c.op)).toEqual(['select', 'delete'])
    expect(fake.tables.adverse_reactions.map((r) => r.id)).toEqual(['other'])
  })

  it('新列表里保留的 id 不会被删，且它的内容会被新值覆盖', async () => {
    const { fake } = setupFake({ tables: { adverse_reactions: [oldRow('keep'), oldRow('drop')] } })

    await cloudRepository.replaceAdverseReactions('s1', [
      makeReaction({ id: 'keep', sessionId: 's1', type: 'headache', severity: 'severe', detail: '持续了半小时' }),
      makeReaction({ id: 'new', sessionId: 's1', type: 'cramp' }),
    ])

    expect(fake.callsOn('adverse_reactions').map((c) => c.op)).toEqual(['select', 'upsert', 'delete'])
    // 只删了 'drop'；'keep' 留下且被覆盖成新内容，'new' 是新增的
    expect(fake.tables.adverse_reactions.map((r) => r.id)).toEqual(['keep', 'new'])
    expect(fake.tables.adverse_reactions[0]).toMatchObject({
      id: 'keep',
      type: 'headache',
      severity: 'severe',
      detail: '持续了半小时',
    })
  })

  it('没有旧记录时不发多余的 delete（新记录 / 空库）', async () => {
    const { fake } = setupFake({ tables: { adverse_reactions: [] } })

    await cloudRepository.replaceAdverseReactions('s1', [makeReaction({ id: 'a1', sessionId: 's1' })])

    expect(fake.callsOn('adverse_reactions').map((c) => c.op)).toEqual(['select', 'upsert'])
    expect(fake.tables.adverse_reactions.map((r) => r.id)).toEqual(['a1'])
  })

  it('读旧 id 阶段报错时直接抛出，一个新字节都不写', async () => {
    const { fake } = setupFake({
      tables: { adverse_reactions: [oldRow('old')] },
      failOn: (call) => (call.table === 'adverse_reactions' && call.op === 'select' ? { message: '读取失败' } : null),
    })

    await expect(
      cloudRepository.replaceAdverseReactions('s1', [makeReaction({ id: 'a1', sessionId: 's1' })]),
    ).rejects.toMatchObject({ message: '读取失败' })

    expect(fake.callsOn('adverse_reactions').map((c) => c.op)).toEqual(['select'])
    expect(fake.tables.adverse_reactions.map((r) => r.id)).toEqual(['old'])
  })

  it('删除阶段报错时抛出（新数据已写入，旧记录还在，等下次重试）', async () => {
    const { fake } = setupFake({
      tables: { adverse_reactions: [oldRow('old')] },
      failOn: (call) => (call.table === 'adverse_reactions' && call.op === 'delete' ? { message: '删除失败' } : null),
    })

    await expect(
      cloudRepository.replaceAdverseReactions('s1', [makeReaction({ id: 'a1', sessionId: 's1' })]),
    ).rejects.toMatchObject({ message: '删除失败' })

    expect(fake.callsOn('adverse_reactions').map((c) => c.op)).toEqual(['select', 'upsert', 'delete'])
    expect(fake.tables.adverse_reactions.map((r) => r.id)).toEqual(['old', 'a1'])
  })
})

describe('cloudRepository · 导出与导入', () => {
  it('exportAll 输出与本地模式一致的结构（version/exportedAt + 各表 camelCase 数组）', async () => {
    setupFake({
      tables: {
        patients: [
          { id: 'p1', name: '张三', birthday: '1950-06-01', wheelchair_weight: 20, rinse_back_volume: 300, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z' },
        ],
        dry_weights: [
          { id: 'd1', patient_id: 'p1', value: 60, effective_date: '2024-01-01', note: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
        ],
        sessions: [
          {
            id: 's1',
            patient_id: 'p1',
            date: '2024-05-01',
            pre_weight_measured: 80,
            post_weight_measured: null,
            wheelchair_weight_used: 20,
            rinse_back_volume_used: 300,
            doctor_uf: null,
            status: 'ongoing',
            aborted_at: null,
            abort_tags: [],
            abort_reason: null,
            notes: null,
            created_at: '2024-05-01T08:00:00Z',
            updated_at: '2024-05-01T09:00:00Z',
            operator: { name: '李护士', phone: '13800000000' },
          },
        ],
        blood_pressures: [
          { id: 'bp1', session_id: 's1', measured_at: '2024-05-01T09:00:00Z', systolic: 130, diastolic: 80, note: null },
        ],
        blood_glucoses: [
          { id: 'bg1', session_id: 's1', measured_at: '2024-05-01T09:00:00Z', value: 6.5, note: null },
        ],
        blood_flows: [{ id: 'bf1', session_id: 's1', measured_at: '2024-05-01T09:00:00Z', value: 250, note: null }],
        adverse_reactions: [
          { id: 'ar1', session_id: 's1', type: 'cramp', detail: null, severity: 'mild', recorded_at: '2024-05-01T09:00:00Z' },
        ],
      },
    })
    const before = Date.now()

    const data = JSON.parse(await cloudRepository.exportAll())

    expect(data.version).toBe(1)
    expect(data.exportedAt).toBeGreaterThanOrEqual(before)
    expect(data.patients[0]).toMatchObject({ id: 'p1', wheelchairWeight: 20, rinseBackVolume: 300 })
    expect(data.dryWeights[0]).toMatchObject({ id: 'd1', patientId: 'p1', effectiveDate: '2024-01-01' })
    expect(data.sessions[0]).toMatchObject({ id: 's1', patientId: 'p1', operator: '李护士', status: 'ongoing' })
    expect(data.bloodPressures[0]).toMatchObject({ id: 'bp1', sessionId: 's1' })
    expect(data.bloodGlucoses[0]).toMatchObject({ id: 'bg1', value: 6.5 })
    expect(data.bloodFlows[0]).toMatchObject({ id: 'bf1', value: 250 })
    expect(data.adverseReactions[0]).toMatchObject({ id: 'ar1', type: 'cramp', severity: 'mild' })
    // 导出的是领域对象（camelCase），不应残留任何 snake_case 列名
    expect(JSON.stringify(data)).not.toContain('session_id')
    expect(JSON.stringify(data)).not.toContain('patient_id')
  })

  it('exportAll 在空库时各表为空数组（不是 null）', async () => {
    setupFake()

    const data = JSON.parse(await cloudRepository.exportAll())

    expect(data.patients).toEqual([])
    expect(data.dryWeights).toEqual([])
    expect(data.sessions).toEqual([])
    expect(data.bloodPressures).toEqual([])
    expect(data.bloodGlucoses).toEqual([])
    expect(data.bloodFlows).toEqual([])
    expect(data.adverseReactions).toEqual([])
  })

  it('importAll 一律抛错（云端模式不支持导入）', async () => {
    setupFake()

    await expect(cloudRepository.importAll('{}')).rejects.toThrow('云端模式无需导入，数据已保存在云端')
  })
})

describe('cloudRepository · PostgREST 返回 data:null 时的兜底', () => {
  /** 让所有查询都解析成 { data: null }（PostgREST 在某些情况下会这样返回） */
  function setupNullDataClient() {
    hoisted.state.client = { ...makeAuthClient(), from: () => makeQuery({ data: null }) }
  }

  it('列表接口一律返回空数组，不能把 null 抛给页面', async () => {
    setupNullDataClient()

    expect(await cloudRepository.listDryWeights('p1')).toEqual([])
    expect(await cloudRepository.listSessions('p1')).toEqual([])
    expect(await cloudRepository.listBloodPressures('s1')).toEqual([])
    expect(await cloudRepository.listBloodGlucoses('s1')).toEqual([])
    expect(await cloudRepository.listBloodFlows('s1')).toEqual([])
    expect(await cloudRepository.listAdverseReactions('s1')).toEqual([])
  })

  it('单条查询返回 undefined', async () => {
    setupNullDataClient()

    expect(await cloudRepository.getPatient('p1')).toBeUndefined()
    expect(await cloudRepository.getSession('s1')).toBeUndefined()
  })

  it('exportAll 各表为空数组（备份文件结构仍然完整）', async () => {
    setupNullDataClient()

    const data = JSON.parse(await cloudRepository.exportAll())

    expect(data).toMatchObject({
      version: 1,
      patients: [],
      dryWeights: [],
      sessions: [],
      bloodPressures: [],
      bloodGlucoses: [],
      bloodFlows: [],
      adverseReactions: [],
    })
  })
})

describe('cloudRepository · 未配置云端', () => {
  it('supabase 为 null 时任意方法都抛「云端未配置」', async () => {
    hoisted.state.client = null

    await expect(cloudRepository.getPatient('p1')).rejects.toThrow('云端未配置')
    await expect(cloudRepository.listSessions('p1')).rejects.toThrow('云端未配置')
    await expect(cloudRepository.saveSession(makeSession())).rejects.toThrow('云端未配置')
    await expect(cloudRepository.deleteSession('s1')).rejects.toThrow('云端未配置')
    await expect(cloudRepository.exportAll()).rejects.toThrow('云端未配置')
    await expect(cloudRepository.importAll('{}')).rejects.toThrow('云端模式无需导入，数据已保存在云端')
  })
})

describe('cloudRepository · 本地默认 id（云端不可能存在）', () => {
  // 回归：实测（Playwright 打测试库）发现，新注册账号的 currentPatientId 还是本地默认值
  // `patient-default`，拿它查库会被 PostgREST 拒成 400（invalid input syntax for type uuid）；
  // 读接口现在会把 error 抛出来，于是首页把「这个账号还没有病人」显示成了「加载失败，请重试」。
  it('getPatient(patient-default) 直接判空，不发请求', async () => {
    const { fake } = setupFake({ tables: { patients: [] } })

    await expect(cloudRepository.getPatient('patient-default')).resolves.toBeUndefined()
    expect(fake.callsOn('patients')).toHaveLength(0)
  })

  it('各列表读方法用 patient-default 时返回空且完全不发请求', async () => {
    const { fake } = setupFake({ tables: {} })

    await expect(cloudRepository.listSessions('patient-default')).resolves.toEqual([])
    await expect(cloudRepository.listDryWeights('patient-default')).resolves.toEqual([])
    await expect(cloudRepository.listBloodPressures('patient-default')).resolves.toEqual([])
    await expect(cloudRepository.listBloodGlucoses('patient-default')).resolves.toEqual([])
    await expect(cloudRepository.listBloodFlows('patient-default')).resolves.toEqual([])
    await expect(cloudRepository.listAdverseReactions('patient-default')).resolves.toEqual([])
    await expect(cloudRepository.getSession('patient-default')).resolves.toBeUndefined()

    expect(fake.calls).toHaveLength(0)
  })

  it('空 id / 纯空白 id 同样直接判空', async () => {
    const { fake } = setupFake({ tables: {} })

    await expect(cloudRepository.getPatient('')).resolves.toBeUndefined()
    await expect(cloudRepository.listSessions('   ')).resolves.toEqual([])
    expect(fake.calls).toHaveLength(0)
  })

  it('正常的云端 uuid 照常查询（别把短路写成「所有非 uuid 都不查」）', async () => {
    const { fake } = setupFake({ tables: { patients: [] } })

    await expect(cloudRepository.getPatient('11111111-1111-4111-8111-111111111111')).resolves.toBeUndefined()
    expect(fake.callsOn('patients')).toHaveLength(1)
  })
})

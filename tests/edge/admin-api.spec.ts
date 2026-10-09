// @vitest-environment node
/**
 * admin-api Edge Function 测试（后台唯一入口，权限最敏感的一块）
 *
 * 覆盖四条主线：
 *   1. 鉴权链：网关 token → getUser → 查 public.admins；whoami 对任何登录用户开放，
 *      其余 action 非管理员一律 403，且**不得产生任何写操作**；
 *   2. 读接口的聚合正确性（用构造数据手算期望值，不照抄实现）；
 *   3. 写接口「写对表/写对字段 + 成功后落一条审计」；审计写入失败时接口仍成功但带 warning；
 *   4. 安全不变量：不能删自己/禁用自己/撤自己、唯一 owner 不能被降级或移除、
 *      删除类操作必须 confirm 手机号/姓名、审计与隐私边界（不读任何病历明细）。
 *
 * 说明：tests/helpers/fakeSupabase.ts 的查询构造器没有实现 gte，而 stats.overview 的
 * 「近 7 天新增」需要它。helpers 不允许改，于是本文件在测试侧给 client.from 打了一层
 * 只补 gte 的代理（见 patchGte），语义与 PostgREST 的 head+count 查询一致。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadEdgeFunction, edgeRequest, readResult, type EdgeHarness } from '../helpers/edge'
import { makeFakeSupabase, type FakeSupabase, type FakeSupabaseOptions, type Row } from '../helpers/fakeSupabase'

const ADMIN_TOKEN = 'tok-admin'
const USER_TOKEN = 'tok-user'
const ADMIN_ID = 'u-admin'
const USER_ID = 'u-owner' // 普通用户（不是管理员）

const DAY = 864e5
/** 固定「现在」，保证同一个用例里多次调用 ago() 得到完全相同的字符串 */
const NOW = Date.now()
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()
const inDays = (days: number) => new Date(NOW + days * DAY).toISOString()

// ---------------------------------------------------------------- 测试数据

/** 病人一（p-1）有 4 个成员；病人二（p-2）没有任何成员 */
function fixtureTables(): Record<string, Row[]> {
  return {
    users: [
      { id: ADMIN_ID, name: '管理员甲', phone: '13800000001', created_at: ago(40) },
      { id: USER_ID, name: '张三', phone: '13800000002', created_at: ago(3) },
      { id: 'u-care', name: '护工乙', phone: '13800000003', created_at: ago(2) },
      { id: 'u-lonely', name: '孤独丙', phone: '13800000004', created_at: ago(30) },
      { id: 'u-banned', name: '被封丁', phone: '13800000005', created_at: ago(20) },
    ],
    patients: [
      {
        id: 'p-1',
        name: '病人一',
        birthday: '1950-03-02',
        wheelchair_weight: 20000,
        rinse_back_volume: 400,
        created_at: ago(30),
        updated_at: ago(5),
      },
      {
        id: 'p-2',
        name: '病人二',
        birthday: '',
        wheelchair_weight: 0,
        rinse_back_volume: 300,
        created_at: ago(10),
        updated_at: ago(10),
      },
    ],
    patient_members: [
      { id: 'm-1', patient_id: 'p-1', user_id: USER_ID, role: 'owner', created_at: ago(30) },
      { id: 'm-2', patient_id: 'p-1', user_id: 'u-care', role: 'caregiver', created_at: ago(20) },
      { id: 'm-3', patient_id: 'p-1', user_id: 'u-banned', role: 'viewer', created_at: ago(1) },
      // 病人已被删除，成员关系还在：用于验证「（病人已删除）」兜底
      { id: 'm-4', patient_id: 'p-deleted', user_id: 'u-banned', role: 'viewer', created_at: ago(15) },
      // 只有 auth 账号、没有资料行的成员：用于验证 profileMissing
      { id: 'm-5', patient_id: 'p-1', user_id: 'u-ghost', role: 'caregiver', created_at: ago(0.5) },
    ],
    admins: [{ user_id: ADMIN_ID }],
    admin_audit_logs: [
      {
        id: 1,
        admin_id: ADMIN_ID,
        action: 'user.rename',
        target_type: 'user',
        target_id: USER_ID,
        detail: { from: '旧名', to: '张三' },
        created_at: ago(1),
      },
    ],
    // 病历明细表：后台只允许 count（绝不读内容），这里塞上 notes 用于「读了就会露馅」的防守
    sessions: [
      { id: 's-1', patient_id: 'p-1', created_at: ago(1), notes: '这是病历明细，后台不该读' },
      { id: 's-2', patient_id: 'p-1', created_at: ago(2) },
      { id: 's-3', patient_id: 'p-1', created_at: ago(30) },
      { id: 's-4', patient_id: 'p-2', created_at: ago(40) },
    ],
  }
}

/** auth.users 列表：u-ghost 只有账号没有资料行；u-care 被禁用（未来时间）；u-lonely 的禁用时间已过期 */
function fixtureAuthUsers(): Row[] {
  return [
    { id: ADMIN_ID, email: '13800000001@phone.local', created_at: ago(40), last_sign_in_at: ago(0.5), banned_until: null },
    { id: USER_ID, email: '13800000002@phone.local', created_at: ago(3), last_sign_in_at: null, banned_until: null },
    { id: 'u-care', email: '13800000003@phone.local', created_at: ago(2), last_sign_in_at: ago(3), banned_until: inDays(1) },
    { id: 'u-lonely', email: '13800000004@phone.local', created_at: ago(30), last_sign_in_at: ago(9), banned_until: ago(1) },
    { id: 'u-banned', email: '13800000005@phone.local', created_at: ago(20), last_sign_in_at: ago(4), banned_until: null },
    { id: 'u-ghost', email: 'ghost@phone.local', created_at: ago(100), last_sign_in_at: ago(50), banned_until: null },
  ]
}

/** admin_patient_stats 聚合：只有条数与首末日期，没有病历内容 */
function fixtureStats(): Row[] {
  return [
    { patient_id: 'p-1', session_count: 3, first_date: ago(30).slice(0, 10), last_date: ago(1).slice(0, 10) },
    { patient_id: 'p-2', session_count: 0, first_date: null, last_date: null },
  ]
}

// ---------------------------------------------------------------- 装载与补丁

/**
 * 给 fake 的查询构造器打两个补丁（helpers 不允许改，只能在这里补齐语义）：
 *
 * 1. gte：admin-api 用 .gte('created_at', since) 做「近 7 天新增」的 head+count 查询，
 *    fake 没实现 → 这里按字符串比较自己算 count（与 PostgREST 的 head+count 一致）。
 * 2. 读结果深拷贝：fake 的 select 直接返回表内对象引用，而真实 PostgREST 返回的是
 *    JSON 新对象。不拷贝的话，先 select 拿到 profile、再 update 同一行，会让产品代码里
 *    提前取好的审计字段（如 from: profile.name）被后续写操作"穿透"污染 —— 那是假象，
 *    不是产品缺陷。这里统一 clone，保证与线上语义一致。
 */
function patchFake(fake: FakeSupabase): void {
  const clone = <T>(v: T): T => (v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)))
  const cloneResult = (res: any) => (res && typeof res === 'object' && 'data' in res ? { ...res, data: clone(res.data) } : res)

  const rawFrom = fake.client.from.bind(fake.client)
  fake.client.from = (table: string) => {
    const raw = rawFrom(table)
    let gte: { col: string; val: any } | null = null

    const proxy: any = new Proxy(raw, {
      get(target, prop) {
        if (prop === 'gte') {
          return (col: string, val: any) => {
            gte = { col, val }
            return proxy
          }
        }
        const value = Reflect.get(target, prop, target)
        if (typeof value !== 'function') return value

        if (prop === 'then') {
          return (onF: any, onR: any) => {
            if (gte) {
              const cond = gte
              const rows = (fake.tables[table] ?? []).filter(
                (r) => String(r[cond.col] ?? '') >= String(cond.val),
              )
              fake.calls.push({ table, op: 'select', filters: [], count: true })
              return Promise.resolve({ data: null, error: null, count: rows.length }).then(onF, onR)
            }
            // 先拿到原始结果（onF 用恒等函数），clone 后再交给调用方
            return value
              .call(target, (r: any) => r, undefined)
              .then(cloneResult)
              .then(onF, onR)
          }
        }

        return (...args: any[]) => {
          const out = value.apply(target, args)
          if (out === target) return proxy
          // single() / maybeSingle() 直接返回 Promise<{data}>
          if (out && typeof out.then === 'function') return Promise.resolve(out).then(cloneResult)
          return out
        }
      },
    })
    return proxy
  }
}

type LoadOptions = Omit<FakeSupabaseOptions, 'tokens'> & { tokens?: Record<string, Row | null> }

/** 装载 admin-api：默认带管理员/普通用户两个 token 与全套构造数据 */
async function load(overrides: LoadOptions = {}): Promise<EdgeHarness> {
  const fake = makeFakeSupabase({
    tables: overrides.tables ?? fixtureTables(),
    authUsers: overrides.authUsers ?? fixtureAuthUsers(),
    rpc: { admin_patient_stats: () => fixtureStats(), ...(overrides.rpc ?? {}) },
    failOn: overrides.failOn,
    tokens: {
      [ADMIN_TOKEN]: { id: ADMIN_ID },
      [USER_TOKEN]: { id: USER_ID },
      ...(overrides.tokens ?? {}),
    },
  })
  patchFake(fake)
  return loadEdgeFunction(() => import('../../supabase/functions/admin-api/index.ts'), { fake })
}

/** 发一次 admin-api 调用 */
async function call(
  h: EdgeHarness,
  action: string,
  payload: Row = {},
  token: string | null = ADMIN_TOKEN,
) {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
  return readResult(await h.handle(edgeRequest({ action, payload }, { headers })))
}

/** 审计插入调用（一次写操作应当恰好新增一条） */
const auditInserts = (h: EdgeHarness) =>
  h.fake.callsOn('admin_audit_logs').filter((c) => c.op === 'insert')

/** 除 select 之外的一切调用（用于断言「被拒绝时什么都没写」） */
const mutations = (h: EdgeHarness) => h.fake.calls.filter((c) => c.op !== 'select')

const snapshot = (h: EdgeHarness) => JSON.parse(JSON.stringify(h.fake.tables))

// ================================================================ 入口与鉴权

describe('admin-api · 入口与方法', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('OPTIONS 预检 → 200 且带白名单 CORS 头', async () => {
    const h = await load()
    const res = await h.handle(
      edgeRequest(null, { method: 'OPTIONS', origin: 'https://dialysis-admin.pages.dev' }),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://dialysis-admin.pages.dev')
  })

  it('GET → 405，且不查库', async () => {
    const h = await load()
    const { status, body } = await readResult(await h.handle(edgeRequest(null, { method: 'GET' })))
    expect(status).toBe(405)
    expect(body.error).toBe('Method Not Allowed')
    expect(h.fake.calls).toHaveLength(0)
  })

  it('没有 Authorization 头 → 401「未登录」', async () => {
    const h = await load()
    const { status, body } = await call(h, 'whoami', {}, null)
    expect(status).toBe(401)
    expect(body.error).toBe('未登录')
    expect(h.fake.client.auth.getUser).not.toHaveBeenCalled()
  })

  it('token 无效 → 401「登录已过期，请重新登录」', async () => {
    const h = await load()
    const { status, body } = await call(h, 'stats.overview', {}, 'not-a-real-token')
    expect(status).toBe(401)
    expect(body.error).toBe('登录已过期，请重新登录')
    // 未识别调用者时连资料表都不该读
    expect(h.fake.callsOn('users')).toHaveLength(0)
  })

  it('请求体不是合法 JSON → 按 {} 处理（管理员 → 400 缺少 action，不 500）', async () => {
    const h = await load()
    const req = new Request('https://test-project.supabase.co/functions/v1/admin-api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: '{不是json',
    })
    const { status, body } = await readResult(await h.handle(req))
    expect(status).toBe(400)
    expect(body.error).toBe('缺少 action')
  })

  it('action 缺失 / 纯空白 → 400「缺少 action」', async () => {
    const h = await load()
    for (const action of ['', '   ']) {
      const { status, body } = await call(h, action)
      expect(status).toBe(400)
      expect(body.error).toBe('缺少 action')
    }
    expect(mutations(h)).toHaveLength(0)
  })

  it('未知 action → 400「未知操作：xxx」', async () => {
    const h = await load()
    const { status, body } = await call(h, 'user.explode')
    expect(status).toBe(400)
    expect(body.error).toBe('未知操作：user.explode')
    expect(mutations(h)).toHaveLength(0)
  })

  it('payload 不是对象时按空对象处理（不抛异常）', async () => {
    const h = await load()
    const res = await h.handle(
      edgeRequest(
        { action: 'user.rename', payload: 'not-an-object' },
        { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } },
      ),
    )
    const { status, body } = await readResult(res)
    expect(status).toBe(400)
    expect(body.error).toBe('缺少用户参数')
  })
})

describe('admin-api · whoami（唯一对非管理员开放的 action）', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('管理员调用 → isAdmin=true，带姓名与手机号', async () => {
    const h = await load()
    const { status, body } = await call(h, 'whoami')
    expect(status).toBe(200)
    expect(body).toEqual({
      ok: true,
      data: { userId: ADMIN_ID, isAdmin: true, name: '管理员甲', phone: '13800000001' },
    })
  })

  it('普通用户调用 → 200 且 isAdmin=false（前端据此提示「没有后台权限」）', async () => {
    const h = await load()
    const { status, body } = await call(h, 'whoami', {}, USER_TOKEN)
    expect(status).toBe(200)
    expect(body.data).toEqual({
      userId: USER_ID,
      isAdmin: false,
      name: '张三',
      phone: '13800000002',
    })
  })

  it('isAdmin 只认 public.admins：把自己的 user_id 放进 admins 才有效', async () => {
    const h = await load({ tables: { ...fixtureTables(), admins: [{ user_id: USER_ID }] } })
    const { body } = await call(h, 'whoami', {}, USER_TOKEN)
    expect(body.data.isAdmin).toBe(true)
  })

  it('有账号无资料行的用户 → whoami 仍可调用，姓名/手机号为空', async () => {
    const h = await load({ tokens: { 'tok-ghost': { id: 'u-ghost' } } })
    const { status, body } = await call(h, 'whoami', {}, 'tok-ghost')
    expect(status).toBe(200)
    expect(body.data).toEqual({ userId: 'u-ghost', isAdmin: false, name: null, phone: null })
  })
})

describe('admin-api · 非管理员越权（403 且零写入）', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it.each([
    'stats.overview',
    'user.list',
    'user.get',
    'patient.list',
    'patient.get',
    'audit.list',
    'user.rename',
    'user.setBanned',
    'user.resetPassword',
    'user.create',
    'user.delete',
    'admin.grant',
    'admin.revoke',
    'member.add',
    'member.setRole',
    'member.remove',
    'patient.update',
    'patient.transferOwner',
    'patient.delete',
  ])('普通用户调用 %s → 403「无后台权限」', async (action) => {
    const h = await load()
    const before = snapshot(h)

    const { status, body } = await call(h, action, { userId: USER_ID, patientId: 'p-1' }, USER_TOKEN)

    expect(status).toBe(403)
    expect(body.error).toBe('无后台权限')
    // 不变量：被拒的请求什么都没改（连审计都不写）
    expect(snapshot(h)).toEqual(before)
    expect(mutations(h)).toHaveLength(0)
  })

  it('非管理员伪造 isAdmin / role=admin 字段无效', async () => {
    const h = await load()
    const { status } = await call(h, 'stats.overview', { isAdmin: true, role: 'admin' }, USER_TOKEN)
    expect(status).toBe(403)
  })

  it('普通用户的 token 换成管理员的也不行（token 与 user 严格对应）', async () => {
    const h = await load()
    const { status, body } = await call(h, 'stats.overview', {}, 'forged-token')
    expect(status).toBe(401)
    expect(body.error).toBe('登录已过期，请重新登录')
  })
})

// ================================================================ 隐私边界

describe('admin-api · 隐私边界（静态守卫，后台不得触碰病历明细）', () => {
  const SRC = readFileSync('supabase/functions/admin-api/index.ts', 'utf8')
  const MEDICAL_TABLES = [
    'sessions',
    'blood_pressures',
    'blood_glucoses',
    'blood_flows',
    'adverse_reactions',
    'dry_weights',
  ]

  it.each(MEDICAL_TABLES)('源码里不存在对病历表 %s 的 from(...) 查询', (table) => {
    expect(SRC).not.toContain(`from('${table}')`)
    expect(SRC).not.toContain(`from("${table}")`)
    expect(SRC).not.toMatch(new RegExp(`from\\(\\s*['"\`]${table}['"\`]`))
  })

  it('所有 from(\'…\') 的表名都在元数据表白名单内', () => {
    const allowed = new Set(['users', 'patients', 'patient_members', 'admins', 'admin_audit_logs'])
    const used = [...SRC.matchAll(/from\(\s*'([^']+)'\s*\)/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(0)
    expect(used.filter((t) => !allowed.has(t))).toEqual([])
  })

  it('所有 .select(...) 的列清单都不含病历字段', () => {
    const selects = [...SRC.matchAll(/\.select\(([^)]*)\)/g)].map((m) => m[1])
    expect(selects.length).toBeGreaterThan(0)
    for (const s of selects) {
      expect(s).not.toMatch(/notes|systolic|diastolic|glucose|flow|adverse|detail|remark/i)
    }
  })

  it('唯一的 RPC 是聚合函数 admin_patient_stats', () => {
    const rpcs = [...SRC.matchAll(/\.rpc\(\s*'([^']+)'/g)].map((m) => m[1])
    expect(rpcs).toEqual(['admin_patient_stats'])
  })

  it('sessions 只以 countRows（行数统计）出现，绝不作为可读表', () => {
    const lines = SRC.split('\n').filter((l) => l.includes("'sessions'"))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l).toMatch(/countRows\(\s*'sessions'/)
  })

  it('运行时：概览/病人详情里出现的是聚合数字，不含任何病历内容', async () => {
    const h = await load()
    const overview = await call(h, 'stats.overview')
    expect(JSON.stringify(overview.body)).not.toContain('这是病历明细')
    expect(overview.body.data.sessionCount).toBe(4)

    const detail = await call(h, 'patient.get', { patientId: 'p-1' })
    expect(JSON.stringify(detail.body)).not.toContain('这是病历明细')
    expect(detail.body.data).not.toHaveProperty('sessions')
  })
})

// ================================================================ 读接口

describe('admin-api · stats.overview', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('各项聚合数字与手算期望一致', async () => {
    const h = await load()
    const { status, body } = await call(h, 'stats.overview')

    expect(status).toBe(200)
    expect(body.data).toEqual({
      userCount: 5, // public.users 5 行
      patientCount: 2,
      sessionCount: 4, // sessions 表 4 行（只数条数）
      newUsers7d: 2, // u-owner(-3d) / u-care(-2d) 在 7 天内
      newSessions7d: 2, // s-1(-1d) / s-2(-2d)
      adminCount: 1,
      usersWithoutPatient: 2, // u-admin / u-lonely 没有任何成员关系
      patientsWithoutMember: 1, // p-2 无成员
      activePatients7d: 1, // 只有 p-1 的 last_date 在近 7 天内（p-2 无记录）
      missingProfile: 1, // u-ghost 只有 auth 账号
    })
  })

  it('只查聚合：没有把 sessions 的内容读出来（fake 里塞了 notes 也不该出现在响应里）', async () => {
    const h = await load()
    const { body } = await call(h, 'stats.overview')
    expect(JSON.stringify(body)).not.toContain('notes')
    // 病历表只发生 head+count 查询（data 为 null），不可能是普通 select
    expect(h.fake.calls.filter((c) => c.table === 'sessions').every((c) => c.count === true)).toBe(true)
  })

  it('空库 → 全 0，不抛异常', async () => {
    // 只保留 admins（否则调用者自己就不是管理员，会先吃 403）；聚合 RPC 也返回空
    const h = await load({
      tables: { admins: [{ user_id: ADMIN_ID }] },
      authUsers: [],
      rpc: { admin_patient_stats: () => [] },
    })
    const { status, body } = await call(h, 'stats.overview')
    expect(status).toBe(200)
    expect(body.data).toEqual({
      userCount: 0,
      patientCount: 0,
      sessionCount: 0,
      newUsers7d: 0,
      newSessions7d: 0,
      adminCount: 1, // 调用者自己必须是管理员，所以 admins 里至少留了他一个
      usersWithoutPatient: 0,
      patientsWithoutMember: 0,
      activePatients7d: 0,
      missingProfile: 0,
    })
  })

  it('统计 RPC 报错 → 500 且说明读取记录统计失败', async () => {
    const h = await load({ rpc: { admin_patient_stats: () => ({ error: { message: 'permission denied' } }) } })
    const { status, body } = await call(h, 'stats.overview')
    expect(status).toBe(500)
    expect(body.error).toContain('读取记录统计失败')
  })

  it('账号列表读取失败 → 500', async () => {
    const h = await load()
    h.fake.client.auth.admin.listUsers.mockResolvedValueOnce({ data: null, error: { message: 'auth down' } })
    const { status, body } = await call(h, 'stats.overview')
    expect(status).toBe(500)
    expect(body.error).toContain('读取账号列表失败')
  })
})

describe('admin-api · user.list', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('默认分页与行内容：手机号/姓名/时间/角色聚合都齐', async () => {
    const h = await load()
    const { status, body } = await call(h, 'user.list')

    expect(status).toBe(200)
    expect(body.data.page).toBe(1)
    expect(body.data.size).toBe(20)
    expect(body.data.total).toBe(6) // 5 个资料行 + 1 个只有账号的 ghost

    const owner = body.data.rows.find((r: Row) => r.id === USER_ID)
    expect(owner).toMatchObject({
      phone: '13800000002',
      name: '张三',
      isAdmin: false,
      banned: false,
      profileMissing: false,
      patientCount: 1,
    })
    expect(owner.roles).toEqual([{ patientId: 'p-1', patientName: '病人一', role: 'owner' }])
    expect(owner.createdAt).toBeTruthy()
  })

  it('isBanned 只看未来时间：未来的 banned_until 才是已禁用，过去的不算', async () => {
    const h = await load()
    const { body } = await call(h, 'user.list')
    const rows: Row[] = body.data.rows

    const care = rows.find((r) => r.id === 'u-care')
    expect(care.banned).toBe(true)
    expect(care.bannedUntil).toBeTruthy()

    const lonely = rows.find((r) => r.id === 'u-lonely')
    expect(lonely.banned).toBe(false) // banned_until 已是过去
    expect(lonely.bannedUntil).toBeTruthy()

    const noBan = rows.find((r) => r.id === USER_ID)
    expect(noBan.banned).toBe(false)
    expect(noBan.bannedUntil).toBeNull()
  })

  it('profileMissing：auth 有账号但 public.users 无行 —— 手机号/姓名给空值，但成员关系照实显示', async () => {
    const h = await load()
    const { body } = await call(h, 'user.list')
    const ghost = body.data.rows.find((r: Row) => r.id === 'u-ghost')

    expect(ghost).toMatchObject({
      phone: null,
      name: null,
      profileMissing: true,
      // 回归：这里曾硬编码 patientCount: 0 / roles: []，
      // 于是「列表显示 0 个病人、点进详情却列得出来」，自相矛盾
      patientCount: 1,
      roles: [{ patientId: 'p-1', patientName: '病人一', role: 'caregiver' }],
      isAdmin: false,
      lastSignInAt: ago(50),
    })
  })

  it('isAdmin 来自 admins 表', async () => {
    const h = await load()
    const { body } = await call(h, 'user.list')
    expect(body.data.rows.find((r: Row) => r.id === ADMIN_ID).isAdmin).toBe(true)
    expect(body.data.rows.find((r: Row) => r.id === USER_ID).isAdmin).toBe(false)
  })

  it('病人已被删除时角色里给「（病人已删除）」兜底', async () => {
    const h = await load()
    const { body } = await call(h, 'user.list')
    const banned = body.data.rows.find((r: Row) => r.id === 'u-banned')
    expect(banned.patientCount).toBe(2)
    expect(banned.roles).toEqual(
      expect.arrayContaining([
        { patientId: 'p-deleted', patientName: '（病人已删除）', role: 'viewer' },
        { patientId: 'p-1', patientName: '病人一', role: 'viewer' },
      ]),
    )
  })

  it('search 同时匹配手机号与姓名（不区分大小写），无结果时 total=0', async () => {
    const h = await load()

    const byName = await call(h, 'user.list', { search: '张三' })
    expect(byName.body.data.total).toBe(1)
    expect(byName.body.data.rows[0].id).toBe(USER_ID)

    const byPhone = await call(h, 'user.list', { search: '13800000003' })
    expect(byPhone.body.data.total).toBe(1)
    expect(byPhone.body.data.rows[0].id).toBe('u-care')

    const byPhonePart = await call(h, 'user.list', { search: '138' })
    expect(byPhonePart.body.data.total).toBe(5) // 5 个有资料行的用户都带 138 号段

    const none = await call(h, 'user.list', { search: '不存在的关键字' })
    expect(none.body.data.total).toBe(0)
    expect(none.body.data.rows).toEqual([])
  })

  it('search 两端空白被忽略，空字符串等于不过滤', async () => {
    const h = await load()
    const padded = await call(h, 'user.list', { search: '  张三  ' })
    expect(padded.body.data.total).toBe(1)
    const blank = await call(h, 'user.list', { search: '   ' })
    expect(blank.body.data.total).toBe(6)
  })

  it('parsePaging：page 最小 1，size 夹在 5..100，非法值回落默认', async () => {
    const h = await load()

    const cases: [Row, number, number][] = [
      [{ page: 0, size: 20 }, 1, 20],
      [{ page: -5, size: 20 }, 1, 20],
      [{ page: 'abc', size: 20 }, 1, 20],
      [{ page: 2.9, size: 20 }, 2, 20],
      [{ page: 1, size: 2 }, 1, 5], // 低于下限 → 5
      [{ page: 1, size: 500 }, 1, 100], // 高于上限 → 100
      [{ page: 1, size: 0 }, 1, 20], // 0 是 falsy → 默认 20
      [{ page: 1, size: 'abc' }, 1, 20],
      [{}, 1, 20],
    ]
    for (const [payload, page, size] of cases) {
      const { body } = await call(h, 'user.list', payload)
      expect({ page: body.data.page, size: body.data.size }).toEqual({ page, size })
    }
  })

  it('分页切片：size=5 时第 1 页 5 行、第 2 页 1 行，且顺序稳定', async () => {
    const h = await load()
    const p1 = await call(h, 'user.list', { page: 1, size: 5 })
    const p2 = await call(h, 'user.list', { page: 2, size: 5 })

    expect(p1.body.data.total).toBe(6)
    expect(p1.body.data.rows).toHaveLength(5)
    expect(p2.body.data.rows).toHaveLength(1)

    const ids = [...p1.body.data.rows, ...p2.body.data.rows].map((r: Row) => r.id)
    expect(new Set(ids).size).toBe(6)
  })

  it('sort=lastSignIn 生效：按最后登录时间倒序，从未登录的垫底', async () => {
    const h = await load()
    const { body } = await call(h, 'user.list', { sort: 'lastSignIn' })

    // 按 fixtureAuthUsers 的 last_sign_in_at 手算：0.5d > 3d > 4d > 9d > 50d > 从未登录(null)
    const byLastSignInDesc = [ADMIN_ID, 'u-care', 'u-banned', 'u-lonely', 'u-ghost', USER_ID]
    const ids = body.data.rows.map((r: Row) => r.id)

    expect(ids).toEqual(byLastSignInDesc)
    // 回归：曾经排序键写的是行上并不存在的 lastSignIn，取不到值 → 全部并列 → 退化成按 id 升序
    expect(ids).not.toEqual([...byLastSignInDesc].sort((a, b) => a.localeCompare(b)))
  })

  it('sort=lastSignIn + order=asc：与倒序完全相反，从未登录的排最前', async () => {
    const h = await load()
    const { body } = await call(h, 'user.list', { sort: 'lastSignIn', order: 'asc' })
    expect(body.data.rows.map((r: Row) => r.id)).toEqual([
      USER_ID,
      'u-ghost',
      'u-lonely',
      'u-banned',
      'u-care',
      ADMIN_ID,
    ])
  })

  it('sort=lastSignInAt 是 sort=lastSignIn 的别名（白名单里两个键都指向行字段 lastSignInAt）', async () => {
    const h = await load()
    const byFrontKey = await call(h, 'user.list', { sort: 'lastSignIn' })
    const byRowKey = await call(h, 'user.list', { sort: 'lastSignInAt' })

    expect(byRowKey.body.data.rows.map((r: Row) => r.id)).toEqual([
      ADMIN_ID,
      'u-care',
      'u-banned',
      'u-lonely',
      'u-ghost',
      USER_ID,
    ])
    expect(byRowKey.body.data.rows.map((r: Row) => r.id)).toEqual(
      byFrontKey.body.data.rows.map((r: Row) => r.id),
    )
  })

  it('sort=lastSignIn 排的是 lastSignInAt 而不是 id：构造数据里两者顺序完全相反', async () => {
    // id 升序：u-admin < u-banned < u-care < u-ghost < u-lonely < u-owner
    // lastSignInAt 则反向设置：u-admin 最旧（60 天前）→ u-owner 最新（10 天前）
    const ids = ['u-admin', 'u-banned', 'u-care', 'u-ghost', 'u-lonely', 'u-owner']
    const h = await load({
      tables: {
        ...fixtureTables(),
        users: ids.map((id, i) => ({
          id,
          name: id,
          phone: `1380000000${i + 1}`,
          created_at: ago(60 - i * 10),
        })),
      },
      authUsers: ids.map((id, i) => ({
        id,
        email: `${id}@phone.local`,
        created_at: ago(60),
        last_sign_in_at: ago(60 - i * 10),
        banned_until: null,
      })),
    })

    const desc = await call(h, 'user.list', { sort: 'lastSignIn', order: 'desc' })
    const asc = await call(h, 'user.list', { sort: 'lastSignIn', order: 'asc' })

    // 排序真的落在 lastSignInAt 上时，倒序恰好是 id 降序（若退化成按 id 排序，desc 会得到 id 升序）
    expect(desc.body.data.rows.map((r: Row) => r.id)).toEqual([...ids].reverse())
    expect(asc.body.data.rows.map((r: Row) => r.id)).toEqual(ids)
  })

  it('lastSignInAt 并列时按 id 升序（升序与倒序都一样）', async () => {
    const h = await load({
      tables: {
        ...fixtureTables(),
        users: ['u-b', 'u-a', 'u-c'].map((id) => ({ id, name: id, phone: null, created_at: ago(1) })),
      },
      authUsers: [
        { id: 'u-a', email: 'a@phone.local', created_at: ago(1), last_sign_in_at: ago(5), banned_until: null },
        { id: 'u-b', email: 'b@phone.local', created_at: ago(1), last_sign_in_at: ago(5), banned_until: null },
        { id: 'u-c', email: 'c@phone.local', created_at: ago(1), last_sign_in_at: ago(1), banned_until: null },
      ],
    })

    // u-a 与 u-b 的最后登录时间完全相同 → 并列按 id 升序；u-c 最新，倒序时排最前
    const desc = await call(h, 'user.list', { sort: 'lastSignIn' })
    expect(desc.body.data.rows.map((r: Row) => r.id)).toEqual(['u-c', 'u-a', 'u-b'])

    const asc = await call(h, 'user.list', { sort: 'lastSignIn', order: 'asc' })
    expect(asc.body.data.rows.map((r: Row) => r.id)).toEqual(['u-a', 'u-b', 'u-c'])
  })

  it('sort=createdAt 生效：注册时间倒序', async () => {
    const h = await load()
    const { body } = await call(h, 'user.list', { sort: 'createdAt' })
    const createdAts = body.data.rows.map((r: Row) => r.createdAt)
    expect([...createdAts].sort().reverse()).toEqual(createdAts)
    expect(body.data.rows[0].id).toBe('u-care') // ago(2) 最新
  })

  it.each([
    ['不传 sort', {}],
    ['sort=null', { sort: null }],
    ['sort 不在白名单（drop table）', { sort: 'drop table' }],
    ['sort 为空串', { sort: '' }],
    ['sort 为纯空白', { sort: '   ' }],
    ['sort 是数字', { sort: 42 }],
    ['sort 大小写不符（LastSignIn）', { sort: 'LastSignIn' }],
  ])('sort %s → 回落到 createdAt 倒序', async (_label, payload) => {
    const h = await load()
    const { body } = await call(h, 'user.list', payload)

    // createdAt 倒序手算：u-care(-2d) 最新 → u-ghost(-100d) 最旧
    expect(body.data.rows.map((r: Row) => r.id)).toEqual([
      'u-care',
      USER_ID,
      'u-banned',
      'u-lonely',
      ADMIN_ID,
      'u-ghost',
    ])
  })

  it('只有显式 order=asc 才升序（与倒序完全相反），"sideways" / "ASC" / 空值仍按倒序', async () => {
    const h = await load()
    const asc = await call(h, 'user.list', { order: 'asc' })
    const ascIds = asc.body.data.rows.map((r: Row) => r.id)
    expect(ascIds).toEqual(['u-ghost', ADMIN_ID, 'u-lonely', 'u-banned', USER_ID, 'u-care'])

    for (const order of [undefined, 'desc', 'sideways', 'ASC', '', 1]) {
      const { body } = await call(h, 'user.list', { order })
      expect(body.data.rows.map((r: Row) => r.id)).toEqual([...ascIds].reverse())
    }
  })

  it('sort=phone 生效：按手机号倒序，没有手机号的（profileMissing）垫底', async () => {
    const h = await load()
    const desc = await call(h, 'user.list', { sort: 'phone' })
    expect(desc.body.data.rows.map((r: Row) => r.id)).toEqual([
      'u-banned',
      'u-lonely',
      'u-care',
      USER_ID,
      ADMIN_ID,
      'u-ghost',
    ])

    const asc = await call(h, 'user.list', { sort: 'phone', order: 'asc' })
    expect(asc.body.data.rows.map((r: Row) => r.id)).toEqual([
      'u-ghost',
      ADMIN_ID,
      USER_ID,
      'u-care',
      'u-lonely',
      'u-banned',
    ])
  })

  it('sort=name 生效：按姓名倒序（UTF-16 码元序），无姓名的垫底', async () => {
    const h = await load()
    const { body } = await call(h, 'user.list', { sort: 'name' })

    // 码元大小：被(U+88AB) > 管(U+7BA1) > 护(U+62A4) > 张(U+5F20) > 孤(U+5B64) > null('')
    expect(body.data.rows.map((r: Row) => r.id)).toEqual([
      'u-banned',
      ADMIN_ID,
      'u-care',
      USER_ID,
      'u-lonely',
      'u-ghost',
    ])
  })

  it('sort=patientCount 生效：按病人数倒序，并列时按 id 升序', async () => {
    const h = await load()
    // 病人数：u-banned 2（p-1 + 已删除的 p-deleted）；u-care / u-ghost / u-owner 各 1；u-admin / u-lonely 各 0。
    // 注意 u-ghost 虽然缺资料行，成员关系同样计入（与 user.get 保持一致）。
    const desc = await call(h, 'user.list', { sort: 'patientCount' })
    expect(desc.body.data.rows.map((r: Row) => r.id)).toEqual([
      'u-banned',
      'u-care',
      'u-ghost',
      USER_ID,
      ADMIN_ID,
      'u-lonely',
    ])

    // 升序时并列仍按 id 升序，所以不是倒序的简单镜像
    const asc = await call(h, 'user.list', { sort: 'patientCount', order: 'asc' })
    expect(asc.body.data.rows.map((r: Row) => r.id)).toEqual([
      ADMIN_ID,
      'u-lonely',
      'u-care',
      'u-ghost',
      USER_ID,
      'u-banned',
    ])
  })

  it('原型链上的键（__proto__ / constructor / toString…）不算合法排序字段，一律回落 createdAt', async () => {
    const h = await load()
    const fallback = (await call(h, 'user.list')).body.data.rows.map((r: Row) => r.id)

    // 回归：白名单曾写成 `TABLE[key] ?? 'createdAt'`，而 `TABLE['__proto__']` 取到的是
    // 继承来的对象（truthy）→ 行上取不到该字段 → 全部并列 → 又退化成按 id 排序。
    for (const key of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      const res = await call(h, 'user.list', { sort: key })
      expect(res.body.data.rows.map((r: Row) => r.id), `sort=${key} 应回落 createdAt`).toEqual(fallback)
    }
  })

})

describe('admin-api · user.get', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('用户不存在 → 404「用户不存在」', async () => {
    const h = await load()
    const { status, body } = await call(h, 'user.get', { userId: 'u-不存在' })
    expect(status).toBe(404)
    expect(body.error).toBe('用户不存在')
  })

  it('缺少 userId → 400「缺少用户参数」', async () => {
    const h = await load()
    const { status, body } = await call(h, 'user.get', {})
    expect(status).toBe(400)
    expect(body.error).toBe('缺少用户参数')
  })

  it('返回用户详情 + 名下病人（含角色中文、记录数、owner 数量）', async () => {
    const h = await load()
    const { status, body } = await call(h, 'user.get', { userId: USER_ID })

    expect(status).toBe(200)
    expect(body.data.user).toMatchObject({
      id: USER_ID,
      phone: '13800000002',
      name: '张三',
      isAdmin: false,
      banned: false,
      profileMissing: false,
      authEmail: '13800000002@phone.local',
      lastSignInAt: null,
    })
    expect(body.data.patients).toEqual([
      {
        patientId: 'p-1',
        patientName: '病人一',
        role: 'owner',
        roleLabel: '创建者',
        joinedAt: ago(30),
        patientCreatedAt: ago(30),
        sessionCount: 3,
        lastSessionDate: ago(1).slice(0, 10),
        ownerCount: 1,
      },
    ])
  })

  it('只有 auth 账号的用户也能打开详情（profileMissing=true，时间取 auth 的）', async () => {
    const h = await load()
    const { status, body } = await call(h, 'user.get', { userId: 'u-ghost' })
    expect(status).toBe(200)
    expect(body.data.user).toMatchObject({
      id: 'u-ghost',
      phone: null,
      name: null,
      profileMissing: true,
      createdAt: ago(100),
      authEmail: 'ghost@phone.local',
    })
    // 他仍可能通过 patient_members 挂在某个病人下（成员关系不依赖资料行）
    expect(body.data.patients).toEqual([
      {
        patientId: 'p-1',
        patientName: '病人一',
        role: 'caregiver',
        roleLabel: '家属/护工',
        joinedAt: ago(0.5),
        patientCreatedAt: ago(30),
        sessionCount: 3,
        lastSessionDate: ago(1).slice(0, 10),
        ownerCount: 1,
      },
    ])
  })

  it('病人已删除的成员关系给兜底名称与 0 记录数', async () => {
    const h = await load()
    const { body } = await call(h, 'user.get', { userId: 'u-banned' })
    const deleted = body.data.patients.find((p: Row) => p.patientId === 'p-deleted')
    expect(deleted).toMatchObject({ patientName: '（病人已删除）', sessionCount: 0, lastSessionDate: null })
  })
})

describe('admin-api · patient.list / patient.get', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('patient.list 汇总成员、创建者与记录数字', async () => {
    const h = await load()
    const { status, body } = await call(h, 'patient.list')

    expect(status).toBe(200)
    expect(body.data.total).toBe(2)
    // 按 createdAt 倒序：p-2(-10d) 在 p-1(-30d) 之前
    expect(body.data.rows.map((r: Row) => r.id)).toEqual(['p-2', 'p-1'])

    const p1 = body.data.rows.find((r: Row) => r.id === 'p-1')
    expect(p1).toMatchObject({
      name: '病人一',
      birthday: '1950-03-02',
      wheelchairWeight: 20000,
      rinseBackVolume: 400,
      memberCount: 4,
      ownerCount: 1,
      owners: ['张三'],
      sessionCount: 3,
    })
    expect(p1.members.map((m: Row) => [m.userId, m.role, m.roleLabel])).toEqual([
      [USER_ID, 'owner', '创建者'],
      ['u-care', 'caregiver', '家属/护工'],
      ['u-banned', 'viewer', '只读'],
      ['u-ghost', 'caregiver', '家属/护工'],
    ])
    // 缺资料行的成员：name/phone 为 null
    expect(p1.members[3]).toMatchObject({ name: null, phone: null })

    const p2 = body.data.rows.find((r: Row) => r.id === 'p-2')
    expect(p2).toMatchObject({ memberCount: 0, ownerCount: 0, owners: [], sessionCount: 0 })
    expect(p2.lastSessionDate).toBeNull()
  })

  it('patient.list 搜索姓名 + 空结果', async () => {
    const h = await load()
    const hit = await call(h, 'patient.list', { search: '病人一' })
    expect(hit.body.data.total).toBe(1)
    expect(hit.body.data.rows[0].id).toBe('p-1')

    const miss = await call(h, 'patient.list', { search: '李四' })
    expect(miss.body.data.total).toBe(0)
    expect(miss.body.data.rows).toEqual([])
  })

  it('patient.get 返回基础配置 + 成员 + 记录统计（没有病历明细）', async () => {
    const h = await load()
    const { status, body } = await call(h, 'patient.get', { patientId: 'p-1' })

    expect(status).toBe(200)
    expect(body.data.patient).toMatchObject({
      id: 'p-1',
      name: '病人一',
      birthday: '1950-03-02',
      wheelchairWeight: 20000,
      rinseBackVolume: 400,
    })
    expect(body.data.members).toHaveLength(4)
    expect(body.data.members.find((m: Row) => m.userId === 'u-ghost').profileMissing).toBe(true)
    expect(body.data.members.find((m: Row) => m.userId === USER_ID)).toMatchObject({
      name: '张三',
      phone: '13800000002',
      roleLabel: '创建者',
      profileMissing: false,
    })
    expect(body.data.stats).toEqual({
      sessionCount: 3,
      firstSessionDate: ago(30).slice(0, 10),
      lastSessionDate: ago(1).slice(0, 10),
    })
    expect(Object.keys(body.data)).toEqual(['patient', 'members', 'stats'])
  })

  it('缺字段默认值：wheelchair_weight 缺省按 0、rinse_back_volume 缺省按 300', async () => {
    const h = await load({
      tables: {
        ...fixtureTables(),
        patients: [{ id: 'p-3', name: '病人三', created_at: ago(1) }],
      },
    })
    const { body } = await call(h, 'patient.get', { patientId: 'p-3' })
    expect(body.data.patient).toMatchObject({ birthday: '', wheelchairWeight: 0, rinseBackVolume: 300 })
    expect(body.data.stats).toEqual({ sessionCount: 0, firstSessionDate: null, lastSessionDate: null })
  })

  it('病人不存在 → 404；缺 patientId → 400', async () => {
    const h = await load()
    const notFound = await call(h, 'patient.get', { patientId: 'p-404' })
    expect(notFound.status).toBe(404)
    expect(notFound.body.error).toBe('病人不存在')

    const missing = await call(h, 'patient.get', {})
    expect(missing.status).toBe(400)
    expect(missing.body.error).toBe('缺少病人参数')
  })
})

describe('admin-api · audit.list', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('读 admin_audit_logs 并关联出操作人姓名/手机号', async () => {
    const h = await load()
    const { status, body } = await call(h, 'audit.list')

    expect(status).toBe(200)
    expect(body.data.total).toBe(1)
    expect(body.data.rows).toEqual([
      {
        id: 1,
        adminId: ADMIN_ID,
        adminName: '管理员甲',
        adminPhone: '13800000001',
        action: 'user.rename',
        targetType: 'user',
        targetId: USER_ID,
        detail: { from: '旧名', to: '张三' },
        createdAt: ago(1),
      },
    ])
  })

  it('操作人已无资料行 → 姓名/手机号为 null（前端回落到 id 前 8 位）', async () => {
    const h = await load({
      tables: {
        ...fixtureTables(),
        users: fixtureTables().users.filter((u) => u.id !== ADMIN_ID),
        admin_audit_logs: [
          { id: 7, admin_id: ADMIN_ID, action: 'user.ban', target_type: 'user', target_id: 'x', detail: null, created_at: ago(2) },
        ],
      },
    })
    const { body } = await call(h, 'audit.list')
    expect(body.data.rows[0]).toMatchObject({ adminName: null, adminPhone: null, detail: {} })
  })

  it('默认每页 30 条，page 从 1 起，size 同样夹在 5..100', async () => {
    const h = await load()
    const { body } = await call(h, 'audit.list')
    expect({ page: body.data.page, size: body.data.size }).toEqual({ page: 1, size: 30 })

    const small = await call(h, 'audit.list', { size: 1 })
    expect(small.body.data.size).toBe(5)

    const big = await call(h, 'audit.list', { size: 1000 })
    expect(big.body.data.size).toBe(100)
  })

  it('按时间倒序 + 分页切片', async () => {
    const logs = [1, 2, 3, 4, 5, 6, 7].map((i) => ({
      id: i,
      admin_id: ADMIN_ID,
      action: 'user.rename',
      target_type: 'user',
      target_id: `u-${i}`,
      detail: {},
      created_at: ago(i),
    }))
    const h = await load({ tables: { ...fixtureTables(), admin_audit_logs: logs } })

    const page1 = await call(h, 'audit.list', { page: 1, size: 5 })
    const page2 = await call(h, 'audit.list', { page: 2, size: 5 })

    expect(page1.body.data.total).toBe(7)
    expect(page1.body.data.rows.map((r: Row) => r.id)).toEqual([1, 2, 3, 4, 5]) // ago(1) 最新
    expect(page2.body.data.rows.map((r: Row) => r.id)).toEqual([6, 7])
  })

  it('日志读取失败 → 500', async () => {
    const h = await load({
      failOn: (c) => (c.table === 'admin_audit_logs' && c.op === 'select' ? { message: 'relation does not exist' } : null),
    })
    const { status, body } = await call(h, 'audit.list')
    expect(status).toBe(500)
    expect(body.error).toContain('读取日志失败')
  })
})

// ================================================================ 写操作

describe('admin-api · 写操作参数校验（requireId / requirePhone / requireRole）', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it.each([
    ['user.rename'],
    ['user.setBanned'],
    ['user.resetPassword'],
    ['user.delete'],
    ['admin.grant'],
    ['admin.revoke'],
    ['member.add'],
    ['member.setRole'],
    ['member.remove'],
    ['patient.update'],
    ['patient.transferOwner'],
    ['patient.delete'],
  ])('%s 缺 id 参数 → 400 且零写入', async (action) => {
    const h = await load()
    const { status, body } = await call(h, action, {})

    expect(status).toBe(400)
    expect(body.error).toMatch(/缺少.+参数/)
    expect(mutations(h)).toHaveLength(0)
  })

  it('id 为纯空白也当作缺失（str 会 trim）', async () => {
    const h = await load()
    const { status, body } = await call(h, 'user.rename', { userId: '   ', name: '张三' })
    expect(status).toBe(400)
    expect(body.error).toBe('缺少用户参数')
  })

  it.each([
    ['member.add', { patientId: 'p-1', phone: '12345' }],
    ['member.add', { patientId: 'p-1', phone: '23800000000' }],
    ['member.add', { patientId: 'p-1', phone: '' }],
    ['user.create', { phone: '1380000000' }],
  ])('%s 手机号非法 → 400「手机号格式不正确」（%j）', async (action, payload) => {
    const h = await load()
    const { status, body } = await call(h, action, payload)
    expect(status).toBe(400)
    expect(body.error).toBe('手机号格式不正确')
    expect(mutations(h)).toHaveLength(0)
  })

  it.each([
    ['member.add', { patientId: 'p-1', phone: '13800000004', role: 'root' }],
    ['member.setRole', { patientId: 'p-1', userId: USER_ID, role: 'admin' }],
    ['member.setRole', { patientId: 'p-1', userId: USER_ID, role: '' }],
  ])('%s 角色非法 → 400「角色不正确」（%j）', async (action, payload) => {
    const h = await load()
    const { status, body } = await call(h, action, payload)
    expect(status).toBe(400)
    expect(body.error).toBe('角色不正确')
    expect(mutations(h)).toHaveLength(0)
  })

  it('member.add 不传角色时默认 caregiver（写库可验）', async () => {
    const h = await load()
    const { status } = await call(h, 'member.add', { patientId: 'p-1', phone: '13800000004' })
    expect(status).toBe(200)
    expect(h.fake.lastCall('patient_members')?.payload).toMatchObject({ role: 'caregiver' })
  })
})

/** 每个写 action 的「成功 + 落一条审计」最小场景（各自用全新数据） */
const AUDIT_CASES: { action: string; payload: Row; audit: string; targetType: string; targetId: string }[] = [
  { action: 'user.rename', payload: { userId: USER_ID, name: '张三丰' }, audit: 'user.rename', targetType: 'user', targetId: USER_ID },
  { action: 'user.setBanned', payload: { userId: 'u-banned', banned: true }, audit: 'user.ban', targetType: 'user', targetId: 'u-banned' },
  { action: 'user.setBanned', payload: { userId: 'u-care', banned: false }, audit: 'user.unban', targetType: 'user', targetId: 'u-care' },
  { action: 'user.resetPassword', payload: { userId: USER_ID, password: 'newpass1' }, audit: 'user.resetPassword', targetType: 'user', targetId: USER_ID },
  { action: 'user.create', payload: { phone: '13800000009', password: 'secret1', name: '新人' }, audit: 'user.create', targetType: 'user', targetId: 'auth-13800000009@phone.local' },
  { action: 'user.delete', payload: { userId: 'u-care', mode: 'detach', confirmPhone: '13800000003' }, audit: 'user.delete', targetType: 'user', targetId: 'u-care' },
  { action: 'admin.grant', payload: { userId: USER_ID }, audit: 'admin.grant', targetType: 'admin', targetId: USER_ID },
  { action: 'member.add', payload: { patientId: 'p-1', phone: '13800000004', role: 'viewer' }, audit: 'member.add', targetType: 'member', targetId: `p-1:u-lonely` },
  { action: 'member.setRole', payload: { patientId: 'p-1', userId: 'u-care', role: 'doctor' }, audit: 'member.setRole', targetType: 'member', targetId: 'p-1:u-care' },
  { action: 'member.remove', payload: { patientId: 'p-1', userId: 'u-care' }, audit: 'member.remove', targetType: 'member', targetId: 'p-1:u-care' },
  { action: 'patient.update', payload: { patientId: 'p-1', name: '病人一号' }, audit: 'patient.update', targetType: 'patient', targetId: 'p-1' },
  { action: 'patient.transferOwner', payload: { patientId: 'p-1', toUserId: 'u-care' }, audit: 'patient.transferOwner', targetType: 'patient', targetId: 'p-1' },
  { action: 'patient.delete', payload: { patientId: 'p-2', confirmName: '病人二' }, audit: 'patient.delete', targetType: 'patient', targetId: 'p-2' },
]

describe('admin-api · 写操作成功后必须落一条审计', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it.each(AUDIT_CASES)('$action → 审计 $audit / $targetType / $targetId', async ({ action, payload, audit, targetType, targetId }) => {
    const h = await load()
    const before = h.fake.tables.admin_audit_logs.length

    const { status, body } = await call(h, action, payload)

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.warning).toBeUndefined()
    expect(h.fake.tables.admin_audit_logs).toHaveLength(before + 1)

    const inserts = auditInserts(h)
    expect(inserts).toHaveLength(1)
    const row = inserts[0].payload
    expect(row).toMatchObject({ admin_id: ADMIN_ID, action: audit, target_type: targetType, target_id: targetId })
    expect(row.detail).toBeTypeOf('object')
  })

  it('审计写入失败 → 接口仍成功（200 + ok）但带 warning 提示', async () => {
    const h = await load({ failOn: (c) => (c.table === 'admin_audit_logs' ? { message: '审计表只读' } : null) })
    const { status, body } = await call(h, 'user.rename', { userId: USER_ID, name: '改名' })

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.warning).toContain('操作已执行，但审计日志写入失败')
    expect(body.warning).toContain('审计表只读')
    // 业务写入没有被回滚
    expect(h.fake.tables.users.find((u) => u.id === USER_ID)?.name).toBe('改名')
  })

  it('不产生审计的动作（member.setRole 目标角色相同）不写审计、不改库', async () => {
    const h = await load()
    const before = snapshot(h)
    const { status, body } = await call(h, 'member.setRole', { patientId: 'p-1', userId: USER_ID, role: 'owner' })

    expect(status).toBe(200)
    expect(body.data).toMatchObject({ unchanged: true })
    expect(auditInserts(h)).toHaveLength(0)
    expect(snapshot(h)).toEqual(before)
  })
})

describe('admin-api · user.rename / setBanned / resetPassword / create', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('user.rename 写 users.name 并审计 from/to', async () => {
    const h = await load()
    const { status, body } = await call(h, 'user.rename', { userId: USER_ID, name: '  张三丰  ' })

    expect(status).toBe(200)
    expect(body.data).toEqual({ userId: USER_ID, name: '张三丰' }) // 已 trim
    const update = h.fake.callsOn('users').find((c) => c.op === 'update')
    expect(update?.payload).toEqual({ name: '张三丰' })
    expect(update?.filters).toEqual([{ col: 'id', val: USER_ID }])
    expect(auditInserts(h)[0].payload.detail).toEqual({ from: '张三', to: '张三丰', phone: '13800000002' })
  })

  it('user.rename 空姓名 / 超长姓名 → 400 且不写库', async () => {
    const h = await load()
    const empty = await call(h, 'user.rename', { userId: USER_ID, name: '   ' })
    expect(empty.status).toBe(400)
    expect(empty.body.error).toBe('姓名不能为空')

    const tooLong = await call(h, 'user.rename', { userId: USER_ID, name: 'x'.repeat(31) })
    expect(tooLong.status).toBe(400)
    expect(tooLong.body.error).toBe('姓名过长')

    expect(mutations(h)).toHaveLength(0)
  })

  it('user.rename 目标没有资料行 → 404', async () => {
    const h = await load()
    const { status, body } = await call(h, 'user.rename', { userId: 'u-ghost', name: '幽灵' })
    expect(status).toBe(404)
    expect(body.error).toBe('用户不存在')
  })

  it('user.setBanned 禁用走 auth.admin.updateUserById + ban_duration=876000h', async () => {
    const h = await load()
    const { status, body } = await call(h, 'user.setBanned', { userId: USER_ID, banned: true })

    expect(status).toBe(200)
    expect(body.data).toMatchObject({ userId: USER_ID, banned: true })
    expect(h.fake.client.auth.admin.updateUserById).toHaveBeenCalledWith(USER_ID, { ban_duration: '876000h' })
    expect(h.fake.callsOn('users').every((c) => c.op === 'select')).toBe(true) // 不改资料表
  })

  it('user.setBanned 解禁走 ban_duration=none', async () => {
    const h = await load()
    const { status } = await call(h, 'user.setBanned', { userId: 'u-care', banned: false })
    expect(status).toBe(200)
    expect(h.fake.client.auth.admin.updateUserById).toHaveBeenCalledWith('u-care', { ban_duration: 'none' })
  })

  it('banned 字段按 Boolean 解释：0 / 空串算解禁，字符串 "false" 算禁用', async () => {
    const h = await load()
    await call(h, 'user.setBanned', { userId: USER_ID, banned: 0 })
    expect(h.fake.client.auth.admin.updateUserById).toHaveBeenLastCalledWith(USER_ID, { ban_duration: 'none' })

    await call(h, 'user.setBanned', { userId: USER_ID, banned: 'false' })
    expect(h.fake.client.auth.admin.updateUserById).toHaveBeenLastCalledWith(USER_ID, { ban_duration: '876000h' })
  })

  it('user.setBanned 目标没有资料行 → 404（先查资料再动 auth）', async () => {
    const h = await load()
    const { status } = await call(h, 'user.setBanned', { userId: 'u-ghost', banned: true })
    expect(status).toBe(404)
    expect(h.fake.client.auth.admin.updateUserById).not.toHaveBeenCalled()
  })

  it('user.resetPassword：管理员指定密码时原样下发', async () => {
    const h = await load()
    const { status, body } = await call(h, 'user.resetPassword', { userId: USER_ID, password: 'newpass1' })
    expect(status).toBe(200)
    expect(body.data).toEqual({ userId: USER_ID, password: 'newpass1' })
    expect(h.fake.client.auth.admin.updateUserById).toHaveBeenCalledWith(USER_ID, { password: 'newpass1' })
    expect(auditInserts(h)[0].payload.detail).toEqual({ phone: '13800000002', generated: false })
  })

  it('user.resetPassword：留空则生成 10 位随机密码，且不含易混字符', async () => {
    const h = await load()
    const { status, body } = await call(h, 'user.resetPassword', { userId: USER_ID })
    expect(status).toBe(200)
    expect(body.data.password).toMatch(/^[abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/)
    expect(h.fake.client.auth.admin.updateUserById).toHaveBeenCalledWith(USER_ID, { password: body.data.password })
    expect(auditInserts(h)[0].payload.detail.generated).toBe(true)
  })

  it('user.resetPassword：指定密码不足 6 位 → 400 且不调用 auth', async () => {
    const h = await load()
    const { status, body } = await call(h, 'user.resetPassword', { userId: USER_ID, password: '12345' })
    expect(status).toBe(400)
    expect(body.error).toBe('密码至少 6 位')
    expect(h.fake.client.auth.admin.updateUserById).not.toHaveBeenCalled()
  })

  it('user.create：建号参数正确（伪邮箱 + 已确认 + user_metadata）', async () => {
    const h = await load()
    const { status, body } = await call(h, 'user.create', { phone: '13800000009', password: 'secret1', name: '新人' })

    expect(status).toBe(200)
    expect(body.data).toMatchObject({ phone: '13800000009', name: '新人' })
    const createUser = h.fake.client.auth.admin.createUser
    expect(createUser).toHaveBeenCalledWith({
      email: '13800000009@phone.local',
      password: 'secret1',
      email_confirm: true,
      user_metadata: { phone: '13800000009', name: '新人' },
    })
  })

  it('user.create：密码不足 6 位 → 400', async () => {
    const h = await load()
    const { status, body } = await call(h, 'user.create', { phone: '13800000009', password: '12345' })
    expect(status).toBe(400)
    expect(body.error).toBe('密码至少 6 位')
    expect(h.fake.client.auth.admin.createUser).not.toHaveBeenCalled()
  })

  it('user.create：手机号已有资料行 → 400「该手机号已注册」且不建号', async () => {
    const h = await load()
    const { status, body } = await call(h, 'user.create', { phone: '13800000002', password: 'secret1', name: '重复' })
    expect(status).toBe(400)
    expect(body.error).toBe('该手机号已注册')
    expect(h.fake.client.auth.admin.createUser).not.toHaveBeenCalled()
  })

  it('user.create：auth 报「已存在」时统一转成 400「该手机号已注册」', async () => {
    const h = await load()
    h.fake.client.auth.admin.createUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'A user with this email address has already been registered' },
    })
    const { status, body } = await call(h, 'user.create', { phone: '13800000009', password: 'secret1', name: '新人' })
    expect(status).toBe(400)
    expect(body.error).toBe('该手机号已注册')
  })

  it('user.create：auth 其它错误原样回传 400', async () => {
    const h = await load()
    h.fake.client.auth.admin.createUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'Password should be at least 6 characters' },
    })
    const { status, body } = await call(h, 'user.create', { phone: '13800000009', password: 'secret1', name: '新人' })
    expect(status).toBe(400)
    expect(body.error).toContain('Password')
  })
})

describe('admin-api · 成员与病人的写操作细节', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('member.add：按手机号找人并插入正确三元组', async () => {
    const h = await load()
    const { status, body } = await call(h, 'member.add', { patientId: 'p-1', phone: '13800000004', role: 'doctor' })

    expect(status).toBe(200)
    expect(body.data).toEqual({ patientId: 'p-1', userId: 'u-lonely', role: 'doctor' })
    expect(h.fake.lastCall('patient_members')?.payload).toEqual({
      patient_id: 'p-1',
      user_id: 'u-lonely',
      role: 'doctor',
    })
    expect(auditInserts(h)[0].payload.detail).toMatchObject({ patient: '病人一', phone: '13800000004', user: '孤独丙', role: 'doctor' })
  })

  it('member.add：病人不存在 → 404；手机号未注册 → 404；已是成员 → 400', async () => {
    const h = await load()

    const noPatient = await call(h, 'member.add', { patientId: 'p-404', phone: '13800000004' })
    expect(noPatient.status).toBe(404)
    expect(noPatient.body.error).toBe('病人不存在')

    const noUser = await call(h, 'member.add', { patientId: 'p-1', phone: '13899999999' })
    expect(noUser.status).toBe(404)
    expect(noUser.body.error).toContain('尚未注册')

    const already = await call(h, 'member.add', { patientId: 'p-1', phone: '13800000003' })
    expect(already.status).toBe(400)
    expect(already.body.error).toBe('该用户已是此病人的成员')

    expect(mutations(h)).toHaveLength(0)
  })

  it('member.setRole：改角色带上 patient_id + user_id 双条件', async () => {
    const h = await load()
    const { status, body } = await call(h, 'member.setRole', { patientId: 'p-1', userId: 'u-care', role: 'viewer' })

    expect(status).toBe(200)
    expect(body.data).toEqual({ patientId: 'p-1', userId: 'u-care', role: 'viewer' })
    const update = h.fake.callsOn('patient_members').find((c) => c.op === 'update')
    expect(update?.payload).toEqual({ role: 'viewer' })
    expect(update?.filters).toEqual([
      { col: 'patient_id', val: 'p-1' },
      { col: 'user_id', val: 'u-care' },
    ])
    expect(auditInserts(h)[0].payload.detail).toMatchObject({ from: 'caregiver', to: 'viewer' })
  })

  it('member.setRole：成员不存在 → 404', async () => {
    const h = await load()
    const { status, body } = await call(h, 'member.setRole', { patientId: 'p-1', userId: 'u-lonely', role: 'viewer' })
    expect(status).toBe(404)
    expect(body.error).toBe('该成员不存在')
  })

  it('member.remove：按双条件删除成员', async () => {
    const h = await load()
    const { status } = await call(h, 'member.remove', { patientId: 'p-1', userId: 'u-care' })

    expect(status).toBe(200)
    const del = h.fake.callsOn('patient_members').find((c) => c.op === 'delete')
    expect(del?.filters).toEqual([
      { col: 'patient_id', val: 'p-1' },
      { col: 'user_id', val: 'u-care' },
    ])
    expect(h.fake.tables.patient_members.map((m) => m.id)).toEqual(['m-1', 'm-3', 'm-4', 'm-5'])
  })

  it('patient.update：只改传入字段，附带 updated_at，并记录 from/to', async () => {
    const h = await load()
    const { status, body } = await call(h, 'patient.update', {
      patientId: 'p-1',
      name: '病人一号',
      wheelchairWeight: 21500,
    })

    expect(status).toBe(200)
    const patch = body.data.patch
    expect(patch).toMatchObject({ name: '病人一号', wheelchair_weight: 21500 })
    expect(patch.birthday).toBeUndefined() // 没传就不动
    expect(patch.updated_at).toBeTruthy()

    const update = h.fake.callsOn('patients').find((c) => c.op === 'update')
    expect(update?.filters).toEqual([{ col: 'id', val: 'p-1' }])
    expect(auditInserts(h)[0].payload.detail.changes).toEqual({
      name: { from: '病人一', to: '病人一号' },
      wheelchairWeight: { from: 20000, to: 21500 },
    })
  })

  it('patient.update：生日空串写成 null，格式非法 → 400', async () => {
    const h = await load()
    const cleared = await call(h, 'patient.update', { patientId: 'p-1', birthday: '' })
    expect(cleared.status).toBe(200)
    expect(cleared.body.data.patch.birthday).toBeNull()

    const bad = await call(h, 'patient.update', { patientId: 'p-1', birthday: '1950/03/02' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('出生日期格式应为 YYYY-MM-DD')
  })

  it.each([
    ['姓名空', { name: '  ' }, '病人姓名不能为空'],
    ['姓名过长', { name: 'x'.repeat(31) }, '病人姓名过长'],
    ['轮椅重量为负', { wheelchairWeight: -1 }, '轮椅重量必须是不小于 0 的数字'],
    ['回水量非数字', { rinseBackVolume: 'abc' }, '回水量必须是不小于 0 的数字'],
  ])('patient.update 字段非法（%s）→ 400 且不写库', async (_label, patch, message) => {
    const h = await load()
    const { status, body } = await call(h, 'patient.update', { patientId: 'p-1', ...patch })
    expect(status).toBe(400)
    expect(body.error).toBe(message)
    expect(mutations(h)).toHaveLength(0)
  })

  it('patient.update：什么都没传 → 400「没有需要修改的内容」', async () => {
    const h = await load()
    const { status, body } = await call(h, 'patient.update', { patientId: 'p-1' })
    expect(status).toBe(400)
    expect(body.error).toBe('没有需要修改的内容')
  })

  it('patient.update：病人不存在 → 404', async () => {
    const h = await load()
    const { status } = await call(h, 'patient.update', { patientId: 'p-404', name: 'x' })
    expect(status).toBe(404)
  })

  it('patient.delete：清掉病人行，返回移除的成员数与记录数', async () => {
    const h = await load()
    const { status, body } = await call(h, 'patient.delete', { patientId: 'p-1', confirmName: '病人一' })

    expect(status).toBe(200)
    expect(body.data).toEqual({ patientId: 'p-1', removedMembers: 4, removedSessions: 3 })
    expect(h.fake.tables.patients.map((p) => p.id)).toEqual(['p-2'])
    expect(auditInserts(h)[0].payload).toMatchObject({
      action: 'patient.delete',
      target_type: 'patient',
      target_id: 'p-1',
    })
  })

  it('patient.delete：confirmName 不匹配 → 400 且病人还在', async () => {
    const h = await load()
    const { status, body } = await call(h, 'patient.delete', { patientId: 'p-1', confirmName: '病人二' })
    expect(status).toBe(400)
    expect(body.error).toBe('确认姓名不匹配，请输入该病人的完整姓名')
    expect(h.fake.tables.patients).toHaveLength(2)
    expect(mutations(h)).toHaveLength(0)
  })

  it('patient.delete：多数值型 confirmName 不匹配（String 比较）', async () => {
    const h = await load()
    const { status } = await call(h, 'patient.delete', { patientId: 'p-2', confirmName: 123 })
    expect(status).toBe(400)
  })
})

describe('admin-api · 管理员授予 / 撤销', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('admin.grant：写 admins（含 created_by 与 note）', async () => {
    const h = await load()
    const { status } = await call(h, 'admin.grant', { userId: USER_ID, note: '临时帮忙' })

    expect(status).toBe(200)
    const insert = h.fake.callsOn('admins').find((c) => c.op === 'insert')
    expect(insert?.payload).toEqual({ user_id: USER_ID, created_by: ADMIN_ID, note: '临时帮忙' })
    expect(h.fake.tables.admins.map((a) => a.user_id)).toEqual([ADMIN_ID, USER_ID])
  })

  it('admin.grant：note 空白写成 null', async () => {
    const h = await load()
    await call(h, 'admin.grant', { userId: USER_ID, note: '   ' })
    expect(h.fake.callsOn('admins').find((c) => c.op === 'insert')?.payload.note).toBeNull()
  })

  it('admin.grant：目标用户不存在 → 404，不写 admins', async () => {
    const h = await load()
    const { status, body } = await call(h, 'admin.grant', { userId: 'u-ghost' })
    expect(status).toBe(404)
    expect(body.error).toContain('用户不存在')
    expect(h.fake.callsOn('admins').every((c) => c.op === 'select')).toBe(true)
  })

  it('admin.grant：重复授予（duplicate key）被容忍，仍返回 200', async () => {
    const h = await load({
      failOn: (c) => (c.table === 'admins' && c.op === 'insert' ? { message: 'duplicate key value violates unique constraint' } : null),
    })
    const { status, body } = await call(h, 'admin.grant', { userId: USER_ID })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
  })

  it('admin.grant：其它数据库错误 → 400', async () => {
    const h = await load({
      failOn: (c) => (c.table === 'admins' && c.op === 'insert' ? { message: 'permission denied for relation admins' } : null),
    })
    const { status, body } = await call(h, 'admin.grant', { userId: USER_ID })
    expect(status).toBe(400)
    expect(body.error).toContain('permission denied')
  })

  it('admin.revoke：撤掉另一位管理员（写 admins + 审计）', async () => {
    const h = await load({ tables: { ...fixtureTables(), admins: [{ user_id: ADMIN_ID }, { user_id: USER_ID }] } })
    const { status, body } = await call(h, 'admin.revoke', { userId: USER_ID })

    expect(status).toBe(200)
    expect(body.data).toEqual({ userId: USER_ID })
    expect(h.fake.callsOn('admins').find((c) => c.op === 'delete')?.filters).toEqual([
      { col: 'user_id', val: USER_ID },
    ])
    expect(h.fake.tables.admins.map((a) => a.user_id)).toEqual([ADMIN_ID])
  })

  it('admin.revoke：撤掉最后一名「其他」管理员仍然成功，只有撤销自己会被拒', async () => {
    const h = await load({ tables: { ...fixtureTables(), admins: [{ user_id: ADMIN_ID }, { user_id: USER_ID }] } })

    // 撤掉另一位管理员后，库里只剩调用者一名管理员 —— 这一步不该被任何「至少保留一名管理员」的检查拦住
    const other = await call(h, 'admin.revoke', { userId: USER_ID })
    expect(other.status).toBe(200)
    expect(other.body.data).toEqual({ userId: USER_ID })
    expect(h.fake.tables.admins.map((a) => a.user_id)).toEqual([ADMIN_ID])

    // 「撤销后至少还剩一名管理员」真正的依据是这条：不能撤销自己
    const self = await call(h, 'admin.revoke', { userId: ADMIN_ID })
    expect(self.status).toBe(400)
    expect(self.body.error).toContain('不能撤销自己')
    expect(h.fake.tables.admins.map((a) => a.user_id)).toEqual([ADMIN_ID])
  })

  it('admin.revoke：目标不是管理员 → 400', async () => {
    const h = await load()
    const { status, body } = await call(h, 'admin.revoke', { userId: USER_ID })
    expect(status).toBe(400)
    expect(body.error).toBe('该用户不是管理员')
    expect(mutations(h)).toHaveLength(0)
  })

  it('admin.revoke：数据库删除失败 → 400', async () => {
    const h = await load({
      tables: { ...fixtureTables(), admins: [{ user_id: ADMIN_ID }, { user_id: USER_ID }] },
      failOn: (c) => (c.table === 'admins' && c.op === 'delete' ? { message: 'deadlock detected' } : null),
    })
    const { status, body } = await call(h, 'admin.revoke', { userId: USER_ID })
    expect(status).toBe(400)
    expect(body.error).toBe('deadlock detected')
  })
})

// ================================================================ 安全不变量

describe('admin-api · 安全不变量', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('user.setBanned：不能禁用自己', async () => {
    const h = await load()
    const { status, body } = await call(h, 'user.setBanned', { userId: ADMIN_ID, banned: true })
    expect(status).toBe(400)
    expect(body.error).toBe('不能禁用自己')
    expect(h.fake.client.auth.admin.updateUserById).not.toHaveBeenCalled()
  })

  it('user.delete：不能删除自己', async () => {
    const h = await load()
    const { status, body } = await call(h, 'user.delete', {
      userId: ADMIN_ID,
      mode: 'purge',
      confirmPhone: '13800000001',
    })
    expect(status).toBe(400)
    expect(body.error).toBe('不能删除自己')
    expect(h.fake.client.auth.admin.deleteUser).not.toHaveBeenCalled()
  })

  it('user.delete：confirmPhone 与目标手机号不一致 → 400（detach 与 purge 都要过这一关）', async () => {
    const h = await load()
    for (const mode of ['detach', 'purge']) {
      const { status, body } = await call(h, 'user.delete', { userId: USER_ID, mode, confirmPhone: '13800000003' })
      expect(status).toBe(400)
      expect(body.error).toBe('确认手机号不匹配，请输入该用户的完整手机号')
    }
    expect(h.fake.client.auth.admin.deleteUser).not.toHaveBeenCalled()
  })

  it('user.delete：缺 confirmPhone → 400', async () => {
    const h = await load()
    const { status } = await call(h, 'user.delete', { userId: USER_ID, mode: 'detach' })
    expect(status).toBe(400)
  })

  it('user.delete(detach)：是某病人唯一创建者时拒绝，并点名病人', async () => {
    const h = await load()
    const { status, body } = await call(h, 'user.delete', {
      userId: USER_ID,
      mode: 'detach',
      confirmPhone: '13800000002',
    })
    expect(status).toBe(400)
    expect(body.error).toContain('病人一')
    expect(body.error).toContain('唯一创建者')
    expect(h.fake.client.auth.admin.deleteUser).not.toHaveBeenCalled()
    expect(h.fake.tables.patients).toHaveLength(2)
  })

  it('user.delete(detach)：不是唯一创建者时只删账号，病人数据保留', async () => {
    const h = await load()
    const { status, body } = await call(h, 'user.delete', {
      userId: 'u-care',
      mode: 'detach',
      confirmPhone: '13800000003',
    })
    expect(status).toBe(200)
    expect(body.data).toEqual({ userId: 'u-care', mode: 'detach', deletedPatients: [] })
    expect(h.fake.client.auth.admin.deleteUser).toHaveBeenCalledWith('u-care')
    expect(h.fake.tables.patients.map((p) => p.id)).toEqual(['p-1', 'p-2'])
    expect(h.fake.callsOn('patients').every((c) => c.op === 'select')).toBe(true)
  })

  it('user.delete(purge)：连带删除他作为唯一创建者的病人，并在返回与审计里列出', async () => {
    const h = await load()
    const { status, body } = await call(h, 'user.delete', {
      userId: USER_ID,
      mode: 'purge',
      confirmPhone: '13800000002',
    })

    expect(status).toBe(200)
    expect(body.data).toEqual({ userId: USER_ID, mode: 'purge', deletedPatients: ['病人一'] })
    const del = h.fake.callsOn('patients').find((c) => c.op === 'delete')
    expect(del?.filters).toEqual([]) // .in('id', [...]) 用的是 in 过滤
    expect(h.fake.tables.patients.map((p) => p.id)).toEqual(['p-2'])
    expect(auditInserts(h)[0].payload.detail).toMatchObject({ mode: 'purge', deletedPatients: ['病人一'] })
  })

  it('user.delete：mode 非 purge 一律按 detach 处理', async () => {
    const h = await load()
    const { body } = await call(h, 'user.delete', {
      userId: 'u-care',
      mode: 'PURGE',
      confirmPhone: '13800000003',
    })
    expect(body.data.mode).toBe('detach')
  })

  it('user.delete：目标没有资料行 → 404', async () => {
    const h = await load()
    const { status, body } = await call(h, 'user.delete', { userId: 'u-ghost', mode: 'detach', confirmPhone: '' })
    expect(status).toBe(404)
    expect(body.error).toBe('用户不存在')
  })

  it('member.setRole：不能把唯一的创建者降级', async () => {
    const h = await load()
    const { status, body } = await call(h, 'member.setRole', { patientId: 'p-1', userId: USER_ID, role: 'caregiver' })

    expect(status).toBe(400)
    expect(body.error).toContain('唯一的创建者')
    expect(h.fake.tables.patient_members.find((m) => m.id === 'm-1')?.role).toBe('owner')
  })

  it('member.setRole：有第二个创建者时可以降级', async () => {
    const h = await load({
      tables: {
        ...fixtureTables(),
        patient_members: [
          ...fixtureTables().patient_members,
          { id: 'm-6', patient_id: 'p-1', user_id: 'u-lonely', role: 'owner', created_at: ago(5) },
        ],
      },
    })
    const { status } = await call(h, 'member.setRole', { patientId: 'p-1', userId: USER_ID, role: 'viewer' })
    expect(status).toBe(200)
    expect(h.fake.tables.patient_members.find((m) => m.id === 'm-1')?.role).toBe('viewer')
  })

  it('member.setRole：创建者之间互改不算降级（owner → owner 视为未变化）', async () => {
    const h = await load({
      tables: {
        ...fixtureTables(),
        patient_members: [
          ...fixtureTables().patient_members,
          { id: 'm-6', patient_id: 'p-1', user_id: 'u-lonely', role: 'owner', created_at: ago(5) },
        ],
      },
    })
    const { status, body } = await call(h, 'member.setRole', { patientId: 'p-1', userId: 'u-lonely', role: 'owner' })
    expect(status).toBe(200)
    expect(body.data.unchanged).toBe(true)
  })

  it('member.remove：不能移除唯一的创建者', async () => {
    const h = await load()
    const { status, body } = await call(h, 'member.remove', { patientId: 'p-1', userId: USER_ID })

    expect(status).toBe(400)
    expect(body.error).toContain('唯一的创建者')
    expect(h.fake.tables.patient_members).toHaveLength(5)
    expect(mutations(h)).toHaveLength(0)
  })

  it('member.remove：非创建者成员可以直接移除', async () => {
    const h = await load()
    const { status } = await call(h, 'member.remove', { patientId: 'p-1', userId: 'u-banned' })
    expect(status).toBe(200)
    // 只删掉 p-1 + u-banned 那一条（m-3），另一病人下的 m-4 不受影响
    expect(h.fake.tables.patient_members.map((m) => m.id)).toEqual(['m-1', 'm-2', 'm-4', 'm-5'])
  })

  it('member.remove：成员不存在 → 404', async () => {
    const h = await load()
    const { status, body } = await call(h, 'member.remove', { patientId: 'p-1', userId: 'u-lonely' })
    expect(status).toBe(404)
    expect(body.error).toBe('该成员不存在')
  })

  it('patient.transferOwner：目标成为创建者，原唯一创建者被降级为家属/护工', async () => {
    const h = await load()
    const { status, body } = await call(h, 'patient.transferOwner', { patientId: 'p-1', toUserId: 'u-care' })

    expect(status).toBe(200)
    expect(body.data).toEqual({ patientId: 'p-1', toUserId: 'u-care', demoted: [USER_ID] })

    const upsert = h.fake.callsOn('patient_members').find((c) => c.op === 'upsert')
    expect(upsert?.payload).toEqual({ patient_id: 'p-1', user_id: 'u-care', role: 'owner' })

    // 注：fake 的 upsert 不认 onConflict（payload 无 id）→ 追加一行，而不是改 m-2；
    // 真实 PostgREST 会按 (patient_id,user_id) 冲突更新。两种情况下 u-care 都是 owner。
    const members = h.fake.tables.patient_members
    expect(
      members.filter((m) => m.patient_id === 'p-1' && m.user_id === 'u-care').map((m) => m.role),
    ).toContain('owner')
    expect(members.find((m) => m.id === 'm-1')?.role).toBe('caregiver') // 原创建者被降级

    expect(auditInserts(h)[0].payload.detail).toMatchObject({ patient: '病人一', demoted: [USER_ID] })
  })

  it('patient.transferOwner：目标还不是成员时同样能提升（upsert 建关系）', async () => {
    const h = await load()
    const { status, body } = await call(h, 'patient.transferOwner', { patientId: 'p-1', toUserId: 'u-lonely' })
    expect(status).toBe(200)
    expect(body.data.demoted).toEqual([USER_ID])
    expect(h.fake.tables.patient_members.find((m) => m.user_id === 'u-lonely')?.role).toBe('owner')
  })

  it('patient.transferOwner：目标已是唯一创建者 → 400「已经是创建者」', async () => {
    const h = await load()
    const { status, body } = await call(h, 'patient.transferOwner', { patientId: 'p-1', toUserId: USER_ID })
    expect(status).toBe(400)
    expect(body.error).toBe('该用户已经是创建者')
    expect(mutations(h)).toHaveLength(0)
  })

  it('patient.transferOwner：病人不存在 / 目标用户不存在 → 404', async () => {
    const h = await load()
    expect((await call(h, 'patient.transferOwner', { patientId: 'p-404', toUserId: USER_ID })).status).toBe(404)
    const noUser = await call(h, 'patient.transferOwner', { patientId: 'p-1', toUserId: 'u-404' })
    expect(noUser.status).toBe(404)
    expect(noUser.body.error).toBe('目标用户不存在')
  })

  it('patient.transferOwner：存在多个创建者时不降级任何人（demoted 为空）', async () => {
    const h = await load({
      tables: {
        ...fixtureTables(),
        patient_members: [
          ...fixtureTables().patient_members,
          { id: 'm-6', patient_id: 'p-1', user_id: 'u-lonely', role: 'owner', created_at: ago(5) },
        ],
      },
    })
    const { status, body } = await call(h, 'patient.transferOwner', { patientId: 'p-1', toUserId: 'u-care' })
    expect(status).toBe(200)
    expect(body.data.demoted).toEqual([])
    expect(h.fake.tables.patient_members.find((m) => m.user_id === USER_ID)?.role).toBe('owner')
  })

  it('写操作失败的数据库错误一律转成 400（不泄露为 500）', async () => {
    const h = await load({
      failOn: (c) => (c.op === 'insert' || c.op === 'update' || c.op === 'delete' ? { message: 'boom' } : null),
    })
    const { status, body } = await call(h, 'user.rename', { userId: USER_ID, name: '张三丰' })
    expect(status).toBe(400)
    expect(body.error).toBe('boom')
  })
})

// ================================================================ 兜底

describe('admin-api · 未预料异常', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('识别调用者时抛异常 → 500', async () => {
    const h = await load()
    h.fake.client.auth.getUser.mockRejectedValueOnce(new Error('auth exploded'))
    const { status, body } = await call(h, 'stats.overview')
    expect(status).toBe(500)
    expect(body.error).toBe('auth exploded')
  })

  it('非 Error 抛出 → 500 且文案为「操作失败」', async () => {
    const h = await load()
    h.fake.client.auth.getUser.mockRejectedValueOnce('字符串异常')
    const { status, body } = await call(h, 'stats.overview')
    expect(status).toBe(500)
    expect(body.error).toBe('操作失败')
  })

  it('fail() 抛出的带 status 的错误按原状态码返回（404/400 不被吞成 500）', async () => {
    const h = await load()
    expect((await call(h, 'patient.get', { patientId: 'p-404' })).status).toBe(404)
    expect((await call(h, 'user.get', { userId: 'u-404' })).status).toBe(404)
    expect((await call(h, 'user.rename', { userId: USER_ID, name: '' })).status).toBe(400)
  })
})

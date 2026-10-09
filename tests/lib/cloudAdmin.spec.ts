/**
 * src/lib/cloudAdmin.ts 单元测试
 *
 * 依赖注入方式：vi.mock 顶层替换 src/lib/supabase，用一个 hoisted 的 state.client 暴露
 * 可写引用 —— 这样工厂里只出现 getter（不引用外部变量），每个用例又能换成新的假客户端。
 *
 * cloudCache 用**真实现**（fake-indexeddb），顺带验证缓存键与「先返回缓存、后台刷新」的语义；
 * beforeEach 里 cacheClear() 保证用例之间不串味。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase, type FakeSupabaseOptions } from '../helpers/fakeSupabase'
import { cacheClear, cacheGet, cacheVersion, FRESH_MS } from '../../src/lib/cloudCache'
import {
  listMyPatients,
  listMembers,
  getMyProfile,
  updateMyName,
  createPatient,
  inviteMember,
  setMemberRole,
  removeMember,
} from '../../src/lib/cloudAdmin'

const SUPABASE_URL = 'https://test-project.supabase.co'
const ANON_KEY = 'test-anon-key'

/** vi.mock 工厂是提升执行的，这里用一个提升出来的可变引用承载「当前假客户端」 */
const state = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('../../src/lib/supabase', () => ({
  isCloudConfigured: true,
  SUPABASE_URL: 'https://test-project.supabase.co',
  SUPABASE_ANON_KEY: 'test-anon-key',
  // getter：cloudAdmin 每次访问都能拿到当前用例安装的假客户端
  get supabase() {
    return state.client
  },
}))

/** 安装一个新的假 Supabase 客户端 */
function installFake(opts: FakeSupabaseOptions = {}): FakeSupabase {
  const fake = makeFakeSupabase(opts)
  state.client = fake.client
  return fake
}

/** 让 auth.getUser() 返回已登录用户 */
function login(fake: FakeSupabase, uid = 'u1') {
  fake.client.auth.getUser.mockResolvedValue({ data: { user: { id: uid } }, error: null })
}

/** 让 auth.getSession() 返回带 access_token 的会话 */
function withSession(fake: FakeSupabase, token: string) {
  fake.client.auth.getSession.mockResolvedValue({ data: { session: { access_token: token } }, error: null })
}

/** fetch 打桩 */
function stubFetch(body: string, status = 200, contentType = 'application/json') {
  const fetchMock = vi.fn(async () => new Response(body, { status, headers: { 'Content-Type': contentType } }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** 一条 patient_members 行（patients 嵌套对象要手工塞，假客户端不做 join） */
function memberRow(patch: Record<string, unknown> = {}) {
  return {
    user_id: 'u1',
    role: 'owner',
    patients: {
      id: 'p1',
      name: '张三',
      birthday: '1950-06-01',
      wheelchair_weight: 20,
      rinse_back_volume: 300,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-02-01T00:00:00.000Z',
    },
    ...patch,
  }
}

beforeEach(async () => {
  await cacheClear() // 清 IndexedDB 缓存，避免上一个用例的 myPatients:/members: 命中
  cacheVersion.value = 0
})

describe('listMyPatients', () => {
  it('未登录（auth.getUser 返回 null）→ 返回 [] 且不发查询', async () => {
    const fake = installFake()

    await expect(listMyPatients()).resolves.toEqual([])

    expect(fake.calls).toHaveLength(0)
  })

  it('首次读取：按 user_id 查 patient_members，映射成 camelCase 病人对象', async () => {
    const fake = installFake({ tables: { patient_members: [memberRow()] } })
    login(fake)

    const list = await listMyPatients()

    const call = fake.lastCall('patient_members')
    expect(call).toMatchObject({ op: 'select' })
    expect(call?.filters).toEqual([{ col: 'user_id', val: 'u1' }])

    expect(list).toEqual([
      {
        patient: {
          id: 'p1',
          name: '张三',
          birthday: '1950-06-01',
          wheelchairWeight: 20,
          rinseBackVolume: 300,
          createdAt: new Date('2024-01-01T00:00:00.000Z').getTime(),
          updatedAt: new Date('2024-02-01T00:00:00.000Z').getTime(),
        },
        role: 'owner',
      },
    ])
  })

  it('结果写入缓存键 myPatients:<uid>', async () => {
    const fake = installFake({ tables: { patient_members: [memberRow()] } })
    login(fake, 'uid-9')

    const list = await listMyPatients()

    const cached = await cacheGet<unknown>('myPatients:uid-9')
    expect(cached).not.toBeNull()
    expect(cached!.value).toEqual(list)
  })

  it('只返回自己的行（按 user_id 过滤生效）', async () => {
    const fake = installFake({
      tables: {
        patient_members: [
          memberRow({ user_id: 'u1' }),
          memberRow({ user_id: 'u2', patients: { id: 'p2', name: '李四' } }),
        ],
      },
    })
    login(fake, 'u1')

    const list = await listMyPatients()

    expect(list.map((i) => i.patient.id)).toEqual(['p1'])
  })

  it('云端缺字段时用默认值兜底（birthday → 空串、轮椅 0、回水 300）', async () => {
    const fake = installFake({
      tables: { patient_members: [memberRow({ patients: { id: 'p2', name: '李四' } })] },
    })
    login(fake)

    const [item] = await listMyPatients()

    expect(item.patient).toMatchObject({ id: 'p2', name: '李四', birthday: '', wheelchairWeight: 0, rinseBackVolume: 300 })
    // 记录实际行为：时间戳缺失时得到 NaN（缓存 JSON 序列化后会变成 null）
    expect(Number.isNaN(item.patient.createdAt)).toBe(true)
  })

  it('缓存过期：先返回旧值，后台刷新完成后 cacheVersion 自增并可读到新值', async () => {
    const fake = installFake({ tables: { patient_members: [memberRow()] } })
    login(fake)

    const realNow = Date.now()
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(realNow)

    const first = await listMyPatients()
    expect(first[0].patient.name).toBe('张三')

    // 云端数据被别处改了，且本地这份缓存已经「过期」（超过 FRESH_MS）
    fake.tables.patient_members[0].patients.name = '李四'
    nowSpy.mockReturnValue(realNow + FRESH_MS + 1)
    const versionBefore = cacheVersion.value

    const second = await listMyPatients()
    expect(second[0].patient.name).toBe('张三') // 先给缓存，不干等网络

    await vi.waitFor(() => expect(cacheVersion.value).toBeGreaterThan(versionBefore))

    const third = await listMyPatients()
    expect(third[0].patient.name).toBe('李四') // 后台刷新已把新数据写回缓存
  })

  it('缓存「新鲜」（FRESH_MS 之内）时不再触发后台刷新 —— 否则 watch(cacheVersion) 会自激成无限请求', async () => {
    const fake = installFake({ tables: { patient_members: [memberRow()] } })
    login(fake)

    await listMyPatients() // 首次读网络并写缓存，此刻缓存是最新鲜的
    const versionBefore = cacheVersion.value
    const callsBefore = fake.callsOn('patient_members').length

    await listMyPatients()
    await listMyPatients()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(cacheVersion.value).toBe(versionBefore)
    expect(fake.callsOn('patient_members').length).toBe(callsBefore)
  })
})

describe('listMembers', () => {
  it('按 patient_id 查询并映射 user_id / role / users.name / users.phone', async () => {
    const fake = installFake({
      tables: {
        patient_members: [
          { patient_id: 'p1', user_id: 'u1', role: 'owner', users: { name: '张三', phone: '13800000000' } },
          { patient_id: 'p1', user_id: 'u2', role: 'viewer', users: { name: '李四', phone: '13900000000' } },
          { patient_id: 'p2', user_id: 'u3', role: 'owner', users: { name: '王五', phone: '13700000000' } },
        ],
      },
    })

    const list = await listMembers('p1')

    expect(fake.lastCall('patient_members')?.filters).toEqual([{ col: 'patient_id', val: 'p1' }])
    expect(list).toEqual([
      { userId: 'u1', name: '张三', phone: '13800000000', role: 'owner' },
      { userId: 'u2', name: '李四', phone: '13900000000', role: 'viewer' },
    ])
  })

  it('users 关联缺失（RLS 静默过滤 / 用户行不存在）→ name、phone 为 null', async () => {
    const fake = installFake({
      tables: {
        patient_members: [
          { patient_id: 'p1', user_id: 'u4', role: 'viewer', users: null },
          { patient_id: 'p1', user_id: 'u5', role: 'viewer', users: {} },
          { patient_id: 'p1', user_id: 'u6', role: 'viewer' },
        ],
      },
    })

    const list = await listMembers('p1')

    expect(list).toEqual([
      { userId: 'u4', name: null, phone: null, role: 'viewer' },
      { userId: 'u5', name: null, phone: null, role: 'viewer' },
      { userId: 'u6', name: null, phone: null, role: 'viewer' },
    ])
  })

  it('写入缓存键 members:<patientId>；缓存过期时先返回缓存再后台刷新', async () => {
    const fake = installFake({
      tables: {
        patient_members: [{ patient_id: 'p1', user_id: 'u1', role: 'owner', users: { name: '张三', phone: '138' } }],
      },
    })

    const realNow = Date.now()
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(realNow)

    const first = await listMembers('p1')
    const cached = await cacheGet<unknown>('members:p1')
    expect(cached!.value).toEqual(first)

    fake.tables.patient_members[0].users.name = '李四'
    nowSpy.mockReturnValue(realNow + FRESH_MS + 1)
    const versionBefore = cacheVersion.value
    const second = await listMembers('p1')

    expect(second[0].name).toBe('张三') // 缓存优先
    await vi.waitFor(() => expect(cacheVersion.value).toBeGreaterThan(versionBefore))
    expect((await listMembers('p1'))[0].name).toBe('李四')
  })

  it('缓存新鲜时不后台刷新（成员页曾因此在 watch(cacheVersion) 上自激）', async () => {
    const fake = installFake({
      tables: {
        patient_members: [{ patient_id: 'p1', user_id: 'u1', role: 'owner', users: { name: '张三', phone: '138' } }],
      },
    })

    await listMembers('p1')
    const versionBefore = cacheVersion.value
    const callsBefore = fake.callsOn('patient_members').length

    await listMembers('p1')
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(cacheVersion.value).toBe(versionBefore)
    expect(fake.callsOn('patient_members').length).toBe(callsBefore)
  })

  it('没有成员时返回空数组', async () => {
    installFake({ tables: { patient_members: [] } })
    await expect(listMembers('p-none')).resolves.toEqual([])
  })
})

describe('getMyProfile', () => {
  it('未登录 → null 且不发查询', async () => {
    const fake = installFake()
    await expect(getMyProfile()).resolves.toBeNull()
    expect(fake.calls).toHaveLength(0)
  })

  it('有数据 → { name, phone }，按当前用户 id 查 users 表', async () => {
    const fake = installFake({
      tables: { users: [{ id: 'u1', name: '张三', phone: '13800000000' }] },
    })
    login(fake)

    await expect(getMyProfile()).resolves.toEqual({ name: '张三', phone: '13800000000' })

    const call = fake.lastCall('users')
    expect(call).toMatchObject({ op: 'select' })
    expect(call?.filters).toEqual([{ col: 'id', val: 'u1' }])
  })

  it('name 为 null 时保留 null（不回退成空串）', async () => {
    const fake = installFake({ tables: { users: [{ id: 'u1', name: null, phone: '13800000000' }] } })
    login(fake)
    await expect(getMyProfile()).resolves.toEqual({ name: null, phone: '13800000000' })
  })

  it('users 表里没有自己那一行 → null', async () => {
    const fake = installFake({ tables: { users: [] } })
    login(fake)
    await expect(getMyProfile()).resolves.toBeNull()
  })
})

describe('updateMyName', () => {
  it('未登录 → { ok: false, error: 未登录 } 且不发写请求', async () => {
    const fake = installFake()
    await expect(updateMyName('张三')).resolves.toEqual({ ok: false, error: '未登录' })
    expect(fake.calls).toHaveLength(0)
  })

  it('空字符串会写成 null（数据库里表示「未填姓名」）', async () => {
    const fake = installFake({ tables: { users: [{ id: 'u1', name: '张三' }] } })
    login(fake)

    const res = await updateMyName('')

    expect(res.ok).toBe(true)
    const call = fake.lastCall('users')
    expect(call).toMatchObject({ op: 'update', payload: { name: null } })
    expect(call?.filters).toEqual([{ col: 'id', val: 'u1' }])
  })

  it('正常姓名原样写入', async () => {
    const fake = installFake({ tables: { users: [{ id: 'u1', name: '张三' }] } })
    login(fake)

    await updateMyName('李四')

    expect(fake.lastCall('users')?.payload).toEqual({ name: '李四' })
  })

  it('写入失败 → { ok: false, error: 错误信息 }', async () => {
    const fake = installFake({
      tables: { users: [{ id: 'u1' }] },
      failOn: (call) => (call.table === 'users' && call.op === 'update' ? { message: 'permission denied' } : null),
    })
    login(fake)

    await expect(updateMyName('张三')).resolves.toEqual({ ok: false, error: 'permission denied' })
  })
})

describe('createPatient（Edge Function）', () => {
  it('POST 到 /functions/v1/create-patient，带当前用户 access_token 与 apikey', async () => {
    const fake = installFake()
    withSession(fake, 'user-access-token')
    const fetchMock = stubFetch(JSON.stringify({ ok: true, patientId: 'p9' }))

    const res = await createPatient('张三', 20, 250)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${SUPABASE_URL}/functions/v1/create-patient`)
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer user-access-token',
      apikey: ANON_KEY,
    })
    expect(JSON.parse(String(init.body))).toEqual({ name: '张三', wheelchairWeight: 20, rinseBackVolume: 250 })
    expect(res).toEqual({ ok: true, data: { ok: true, patientId: 'p9' } })
  })

  it('默认参数：轮椅 0、回水 300', async () => {
    const fake = installFake()
    withSession(fake, 'tok')
    const fetchMock = stubFetch(JSON.stringify({ ok: true }))

    await createPatient('张三')

    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body).toEqual({ name: '张三', wheelchairWeight: 0, rinseBackVolume: 300 })
  })

  it('拿不到 session（未登录 / 令牌过期）时回退用 anon key（设计如此：函数网关还需要 apikey 头识别项目）', async () => {
    const fake = installFake() // getSession 默认返回 session: null
    const fetchMock = stubFetch(JSON.stringify({ ok: true }))

    await createPatient('张三')

    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${ANON_KEY}`)
    expect(headers.apikey).toBe(ANON_KEY)
  })

  it('HTTP 失败时 ok=false，data 仍带响应体', async () => {
    const fake = installFake()
    withSession(fake, 'tok')
    stubFetch(JSON.stringify({ error: '无权限' }), 403)

    await expect(createPatient('张三')).resolves.toEqual({ ok: false, data: { error: '无权限' } })
  })

  it('响应不是 JSON 时不抛错，data 兜底为空对象', async () => {
    const fake = installFake()
    withSession(fake, 'tok')
    stubFetch('<html>502</html>', 502, 'text/html')

    await expect(createPatient('张三')).resolves.toEqual({ ok: false, data: {} })
  })
})

describe('inviteMember（Edge Function）', () => {
  it('POST 到 /functions/v1/invite-member，带 access_token 与 patientId/phone/role', async () => {
    const fake = installFake()
    withSession(fake, 'user-access-token')
    const fetchMock = stubFetch(JSON.stringify({ ok: true }))

    const res = await inviteMember('p1', '13900000000', 'viewer')

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${SUPABASE_URL}/functions/v1/invite-member`)
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer user-access-token',
      apikey: ANON_KEY,
    })
    expect(JSON.parse(String(init.body))).toEqual({ patientId: 'p1', phone: '13900000000', role: 'viewer' })
    expect(res).toEqual({ ok: true, error: undefined })
  })

  it('失败时 ok=false 且 error 取响应体的 error', async () => {
    const fake = installFake()
    withSession(fake, 'tok')
    stubFetch(JSON.stringify({ error: '该手机号尚未注册' }), 400)

    await expect(inviteMember('p1', '13900000000', 'viewer')).resolves.toEqual({
      ok: false,
      error: '该手机号尚未注册',
    })
  })

  it('响应不是 JSON 时不抛错，error 为 undefined（调用方按 ok 判断即可）', async () => {
    const fake = installFake()
    withSession(fake, 'tok')
    stubFetch('<html>502</html>', 502, 'text/html')

    await expect(inviteMember('p1', '13900000000', 'viewer')).resolves.toEqual({ ok: false, error: undefined })
  })
})

describe('setMemberRole / removeMember', () => {
  it('setMemberRole 同时带 patient_id 与 user_id 两个 eq 条件', async () => {
    const fake = installFake({ tables: { patient_members: [{ patient_id: 'p1', user_id: 'u2', role: 'viewer' }] } })

    const res = await setMemberRole('p1', 'u2', 'owner')

    expect(res).toEqual({ ok: true, error: undefined })
    const call = fake.lastCall('patient_members')
    expect(call).toMatchObject({ op: 'update', payload: { role: 'owner' } })
    expect(call?.filters).toEqual([
      { col: 'patient_id', val: 'p1' },
      { col: 'user_id', val: 'u2' },
    ])
    expect(fake.tables.patient_members[0].role).toBe('owner')
  })

  it('setMemberRole 失败 → { ok: false, error }', async () => {
    const fake = installFake({
      tables: { patient_members: [{ patient_id: 'p1', user_id: 'u2', role: 'viewer' }] },
      failOn: (call) => (call.op === 'update' ? { message: '仅 owner 可修改角色' } : null),
    })

    await expect(setMemberRole('p1', 'u2', 'owner')).resolves.toEqual({ ok: false, error: '仅 owner 可修改角色' })
  })

  it('removeMember 同时带 patient_id 与 user_id 两个 eq 条件', async () => {
    const fake = installFake({
      tables: {
        patient_members: [
          { patient_id: 'p1', user_id: 'u2', role: 'viewer' },
          { patient_id: 'p1', user_id: 'u3', role: 'viewer' },
        ],
      },
    })

    const res = await removeMember('p1', 'u2')

    expect(res).toEqual({ ok: true, error: undefined })
    const call = fake.lastCall('patient_members')
    expect(call).toMatchObject({ op: 'delete' })
    expect(call?.filters).toEqual([
      { col: 'patient_id', val: 'p1' },
      { col: 'user_id', val: 'u2' },
    ])
    // 只删掉目标成员，别人的成员关系不受影响
    expect(fake.tables.patient_members).toEqual([{ patient_id: 'p1', user_id: 'u3', role: 'viewer' }])
  })

  it('removeMember 失败（RLS 静默拦截也可能是 0 行）→ { ok: false, error }', async () => {
    const fake = installFake({
      tables: { patient_members: [{ patient_id: 'p1', user_id: 'u2', role: 'viewer' }] },
      failOn: (call) => (call.op === 'delete' ? { message: 'permission denied' } : null),
    })

    await expect(removeMember('p1', 'u2')).resolves.toEqual({ ok: false, error: 'permission denied' })
    expect(fake.tables.patient_members).toHaveLength(1)
  })

  it('setMemberRole 命中 0 行 → 返回失败，不能提示「已更新」（RLS 静默过滤）', async () => {
    // 回归：RLS 把无权限的行过滤掉时同样返回 204、error 为 null，
    // 只看 error 的话界面会提示「角色已更新」，实际什么都没发生。
    installFake({ tables: { patient_members: [] } })

    const res = await setMemberRole('p1', 'u-x', 'viewer')

    expect(res.ok).toBe(false)
    expect(res.error).toContain('修改成员角色失败')
  })

  it('removeMember 命中 0 行 → 返回失败，不能提示「已移除」', async () => {
    installFake({ tables: { patient_members: [] } })

    const res = await removeMember('p1', 'u-x')

    expect(res.ok).toBe(false)
    expect(res.error).toContain('移除成员失败')
  })
})

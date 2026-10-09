// @vitest-environment node
/**
 * invite-member Edge Function 测试
 *
 * 这是「账号 ↔ 病人」关系唯一的写入入口之一，函数用 service_role 绕过 RLS，
 * 因此**函数内的角色校验就是唯一防线**：调用者必须是该病人的 owner。
 * 用例除了成功/失败分支，还专门钉住「非 owner 调用绝不产生任何 insert」这条不变量。
 *
 * 参数归一化：请求体按「可能不是合法 JSON、字段可能不是字符串」处理 —— 非法 JSON、
 * 空白/非字符串 patientId、非字符串或格式不对的手机号都在鉴权之前回 400「参数不正确」，
 * role 只认白名单字符串（空串/null/非字符串回落默认 caregiver，非法字符串回 400）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { loadEdgeFunction, edgeRequest, readResult } from '../helpers/edge'
import type { FakeSupabaseOptions, Row } from '../helpers/fakeSupabase'

const OWNER = { Authorization: 'Bearer tok-owner' }
const ALLOWED_ORIGIN = 'https://dialysis-admin.pages.dev'

/** 每次装载都拿到全新数据，避免用例之间互相污染 */
function freshTables(): Record<string, Row[]> {
  return {
    users: [
      { id: 'user-owner', phone: '13800000000' },
      { id: 'user-caregiver', phone: '13700000000' },
      { id: 'user-target', phone: '13900000000' },
    ],
    patients: [{ id: 'patient-1', name: '张三' }],
    patient_members: [
      { id: 'pm-owner', patient_id: 'patient-1', user_id: 'user-owner', role: 'owner' },
      { id: 'pm-caregiver', patient_id: 'patient-1', user_id: 'user-caregiver', role: 'caregiver' },
    ],
  }
}

const TOKENS: Record<string, Row> = {
  'tok-owner': { id: 'user-owner' },
  'tok-caregiver': { id: 'user-caregiver' },
  'tok-outsider': { id: 'user-outsider' },
}

/** 装载 invite-member；默认数据 = 一个 owner（tok-owner）+ 一个 caregiver */
async function load(overrides: FakeSupabaseOptions = {}) {
  return loadEdgeFunction(() => import('../../supabase/functions/invite-member/index.ts'), {
    fakeOptions: {
      ...overrides,
      tables: overrides.tables ?? freshTables(),
      tokens: { ...TOKENS, ...(overrides.tokens ?? {}) },
    },
  })
}

/** 合法请求体（仅覆盖指定字段） */
function body(overrides: Record<string, unknown> = {}) {
  return { patientId: 'patient-1', phone: '13900000000', role: 'caregiver', ...overrides }
}

describe('invite-member · CORS 与方法', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('OPTIONS 预检 → 200 + CORS 头', async () => {
    const h = await load()
    const res = await h.handle(edgeRequest(null, { method: 'OPTIONS', origin: ALLOWED_ORIGIN }))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN)
  })

  it('GET → 405 且不触碰数据库', async () => {
    const h = await load()
    const { status, body: res } = await readResult(await h.handle(edgeRequest(null, { method: 'GET' })))
    expect(status).toBe(405)
    expect(res.error).toBe('Method Not Allowed')
    expect(h.fake.calls).toHaveLength(0)
  })
})

describe('invite-member · 参数校验（先于鉴权）', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it.each([
    ['缺 patientId', { patientId: undefined }],
    ['patientId 为空串', { patientId: '' }],
    ['patientId 纯空白', { patientId: '   ' }],
    ['patientId 是数字（非字符串）', { patientId: 123 }],
    ['patientId 是对象（非字符串）', { patientId: { id: 'patient-1' } }],
    ['手机号为空', { phone: undefined }],
    ['手机号为 null', { phone: null }],
    ['手机号是数字类型（不再被隐式转成字符串）', { phone: 13900000000 }],
    ['手机号是数组（非字符串）', { phone: ['13900000000'] }],
    ['手机号位数不足', { phone: '1380000000' }],
    ['手机号位数过多', { phone: '138000000000' }],
    ['手机号第二位非法', { phone: '12800000000' }],
    ['手机号带字母', { phone: '1380000000a' }],
    ['手机号中间有空格（只有两端空格会被 trim 掉）', { phone: '138 0000 0000' }],
  ])('%s → 400「参数不正确」且不查库', async (_label, patch) => {
    const h = await load()
    const { status, body: res } = await readResult(
      await h.handle(edgeRequest(body(patch), { headers: OWNER })),
    )
    expect(status).toBe(400)
    expect(res.error).toBe('参数不正确')
    expect(h.fake.callsOn('patient_members')).toHaveLength(0)
    expect(h.fake.client.auth.getUser).not.toHaveBeenCalled()
  })

  // 回归：曾经 patientId 不 trim，'   ' 能过「非空」校验 → 查不到成员关系 → 回 403
  // 「仅创建者可邀请成员」，把「参数没填对」说成了「你没权限」，排查方向被带偏。
  it('patientId 纯空白按参数缺失处理，而不是当成某个「不是成员」的病人 id 回 403', async () => {
    const h = await load()
    const { status, body: res } = await readResult(
      await h.handle(edgeRequest(body({ patientId: '   ' }), { headers: OWNER })),
    )
    expect(status).toBe(400)
    expect(res.error).toBe('参数不正确')
    // 连鉴权都没走到，更没有查过成员关系
    expect(h.fake.client.auth.getUser).not.toHaveBeenCalled()
    expect(h.fake.callsOn('patient_members')).toHaveLength(0)
  })

  it('patientId 前后空格被 trim 后再校验与查询', async () => {
    const h = await load()
    const { status } = await readResult(
      await h.handle(edgeRequest(body({ patientId: '  patient-1  ' }), { headers: OWNER })),
    )
    expect(status).toBe(200)

    // 查成员关系用的 patient_id 是 trim 后的值（用原值查会查不到 → 误判 403）
    const memberSelects = h.fake.callsOn('patient_members').filter((c) => c.op === 'select')
    expect(memberSelects.length).toBeGreaterThan(0)
    for (const q of memberSelects) {
      expect(q.filters.find((f) => f.col === 'patient_id')?.val).toBe('patient-1')
    }
    // 落库同样用 trim 后的 id
    expect(h.fake.lastCall('patient_members')?.payload).toEqual({
      patient_id: 'patient-1',
      user_id: 'user-target',
      role: 'caregiver',
    })
  })

  // 回归：曾经 phone 不 trim、正则直接吃原值，带前后空格的合法号码被判成「参数不正确」；
  // 现在两端空白先被去掉，号码本身合法就按正常邀请流程走。
  it('手机号前后空格被 trim 后按正常流程处理（查用户用的是 trim 后的号码）', async () => {
    const h = await load()
    const { status } = await readResult(
      await h.handle(edgeRequest(body({ phone: '  13900000000  ' }), { headers: OWNER })),
    )
    expect(status).toBe(200)
    expect(h.fake.lastCall('users')?.filters).toEqual([{ col: 'phone', val: '13900000000' }])
    expect(h.fake.lastCall('patient_members')?.payload).toMatchObject({ user_id: 'user-target' })
  })

  // 回归：曾经只判 `role ?? 'caregiver'`，只有 null/undefined 才回落默认值，数字之类的类型错误
  // 会直接撞上白名单变成 400；现在 role 只认「非空字符串」，其余（含数字/布尔）一律回落默认 caregiver，
  // 非法字符串仍然 400「角色不正确」。
  it.each([
    ['未定义（默认 caregiver）', undefined, 'caregiver'],
    ['null（默认 caregiver）', null, 'caregiver'],
    ['空串（默认 caregiver）', '', 'caregiver'],
    ['数字 1（非字符串 → 默认 caregiver，不报错）', 1, 'caregiver'],
    ['布尔 true（非字符串 → 默认 caregiver，不报错）', true, 'caregiver'],
    ['显式 patient 角色', 'patient', null],
    ['大小写不同', 'Owner', null],
    ['中文角色名', '创建者', null],
    ['非法字符串 root', 'root', null],
  ])('角色 %s', async (_label, role, expected) => {
    const h = await load()
    const payload = body(role === undefined ? {} : { role })
    const { status, body: res } = await readResult(await h.handle(edgeRequest(payload, { headers: OWNER })))

    if (expected) {
      // 默认角色 caregiver：正常走到插入
      expect(status).toBe(200)
      expect(h.fake.lastCall('patient_members')?.payload).toMatchObject({ role: expected })
    } else {
      expect(status).toBe(400)
      expect(res.error).toBe('角色不正确')
      expect(h.fake.callsOn('patient_members').every((c) => c.op !== 'insert')).toBe(true)
    }
  })

  it('请求体不是合法 JSON → 400「参数不正确」（按空对象处理，不是 500）', async () => {
    const h = await load()
    const req = new Request('https://test-project.supabase.co/functions/v1/invite-member', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...OWNER },
      body: '{不是json',
    })
    const { status, body: res } = await readResult(await h.handle(req))
    expect(status).toBe(400)
    expect(res.error).toBe('参数不正确')
    expect(h.fake.client.auth.getUser).not.toHaveBeenCalled()
    expect(h.fake.callsOn('patient_members')).toHaveLength(0)
  })

  it('参数校验在鉴权之前：无 token + 非法手机号 → 400 而不是 401', async () => {
    const h = await load()
    const { status } = await readResult(await h.handle(edgeRequest(body({ phone: 'abc' }))))
    expect(status).toBe(400)
    expect(h.fake.client.auth.getUser).not.toHaveBeenCalled()
  })

  it('角色校验也在鉴权之前：无 token + 非法角色 → 400 而不是 401', async () => {
    const h = await load()
    const { status, body: res } = await readResult(await h.handle(edgeRequest(body({ role: 'root' }))))
    expect(status).toBe(400)
    expect(res.error).toBe('角色不正确')
    expect(h.fake.client.auth.getUser).not.toHaveBeenCalled()
  })
})

describe('invite-member · 鉴权', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('无 Authorization 头 → 401「未登录」', async () => {
    const h = await load()
    const { status, body: res } = await readResult(await h.handle(edgeRequest(body())))
    expect(status).toBe(401)
    expect(res.error).toBe('未登录')
    expect(h.fake.callsOn('patient_members')).toHaveLength(0)
  })

  it('token 无效 → 401「登录已过期，请重新登录」', async () => {
    const h = await load()
    const { status, body: res } = await readResult(
      await h.handle(edgeRequest(body(), { headers: { Authorization: 'Bearer bad-token' } })),
    )
    expect(status).toBe(401)
    expect(res.error).toBe('登录已过期，请重新登录')
    expect(h.fake.callsOn('patient_members')).toHaveLength(0)
  })
})

describe('invite-member · 越权拦截（核心）', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('调用者不是该病人的任何成员 → 403「仅创建者可邀请成员」，且无任何写入', async () => {
    const h = await load()
    const before = h.fake.tables.patient_members.length

    const { status, body: res } = await readResult(
      await h.handle(
        edgeRequest(body({ role: 'viewer' }), { headers: { Authorization: 'Bearer tok-outsider' } }),
      ),
    )

    expect(status).toBe(403)
    expect(res.error).toBe('仅创建者可邀请成员')
    expect(h.fake.tables.patient_members).toHaveLength(before)
    expect(h.fake.callsOn('patient_members').every((c) => c.op === 'select')).toBe(true)
  })

  it('调用者是成员但角色为 caregiver → 403，且绝不能发生任何 insert', async () => {
    const h = await load()
    const before = h.fake.tables.patient_members.map((m) => ({ ...m }))

    const { status, body: res } = await readResult(
      await h.handle(
        edgeRequest(body({ role: 'owner' }), { headers: { Authorization: 'Bearer tok-caregiver' } }),
      ),
    )

    expect(status).toBe(403)
    expect(res.error).toBe('仅创建者可邀请成员')
    // 不变量：行数与内容都没变（提权失败不留痕）
    expect(h.fake.tables.patient_members).toEqual(before)
    expect(h.fake.callsOn('patient_members').filter((c) => c.op !== 'select')).toHaveLength(0)
    // 连目标用户的手机号查询都不该发生（更早返回）
    expect(h.fake.callsOn('users')).toHaveLength(0)
  })

  it('owner 身份只对「该病人」有效：在别的病人下不是 owner 照样 403', async () => {
    const h = await load()
    const { status } = await readResult(
      await h.handle(edgeRequest(body({ patientId: 'patient-2' }), { headers: OWNER })),
    )
    expect(status).toBe(403)
    expect(h.fake.callsOn('patient_members').every((c) => c.op === 'select')).toBe(true)
  })

  it('body 里伪造 ownerId / userId 不影响判定（只认 token）', async () => {
    const h = await load()
    const { status } = await readResult(
      await h.handle(
        edgeRequest(
          body({ ownerId: 'user-owner', userId: 'user-owner', callerRole: 'owner' }),
          { headers: { Authorization: 'Bearer tok-outsider' } },
        ),
      ),
    )
    expect(status).toBe(403)
  })
})

describe('invite-member · 目标用户校验与成功路径', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('目标手机号未注册 → 404 且不插入', async () => {
    const h = await load()
    const { status, body: res } = await readResult(
      await h.handle(edgeRequest(body({ phone: '13600000000' }), { headers: OWNER })),
    )
    expect(status).toBe(404)
    expect(res.error).toContain('尚未注册')
    expect(h.fake.callsOn('patient_members').every((c) => c.op === 'select')).toBe(true)
  })

  it('目标已是该病人成员 → 400「该成员已在列表」（以目标自己的手机号邀请）', async () => {
    const h = await load()
    const { status, body: res } = await readResult(
      await h.handle(edgeRequest(body({ phone: '13700000000' }), { headers: OWNER })),
    )
    expect(status).toBe(400)
    expect(res.error).toBe('该成员已在列表')
    expect(h.fake.callsOn('patient_members').every((c) => c.op === 'select')).toBe(true)
  })

  it('同一手机号在别的病人下是成员，不影响添加到本病人', async () => {
    const h = await load({
      tables: {
        ...freshTables(),
        patient_members: [
          ...freshTables().patient_members,
          { id: 'pm-other', patient_id: 'patient-2', user_id: 'user-target', role: 'caregiver' },
        ],
      },
    })
    const { status } = await readResult(await h.handle(edgeRequest(body(), { headers: OWNER })))
    expect(status).toBe(200)
  })

  it('成功：插入 patient_members，user_id 取自手机号查到的用户、patient_id/role 原样写入', async () => {
    const h = await load()
    const { status, body: res } = await readResult(
      await h.handle(edgeRequest(body({ role: 'doctor' }), { headers: OWNER })),
    )

    expect(status).toBe(200)
    expect(res).toEqual({ success: true })

    const call = h.fake.lastCall('patient_members')
    expect(call?.op).toBe('insert')
    expect(call?.payload).toEqual({
      patient_id: 'patient-1',
      user_id: 'user-target',
      role: 'doctor',
    })
    expect(h.fake.tables.patient_members).toHaveLength(3)
  })

  it('不传角色时落库为 caregiver（默认值）', async () => {
    const h = await load()
    await h.handle(edgeRequest({ patientId: 'patient-1', phone: '13900000000' }, { headers: OWNER }))
    expect(h.fake.lastCall('patient_members')?.payload).toMatchObject({ role: 'caregiver' })
  })

  it('插入失败 → 400 原样回传数据库错误', async () => {
    const h = await load({
      failOn: (call) =>
        call.table === 'patient_members' && call.op === 'insert' ? { message: 'duplicate key value' } : null,
    })
    const { status, body: res } = await readResult(await h.handle(edgeRequest(body(), { headers: OWNER })))
    expect(status).toBe(400)
    expect(res.error).toBe('duplicate key value')
  })

  it('用户表查询抛异常 → 500', async () => {
    const h = await load()
    h.fake.client.from = () => {
      throw new Error('db down')
    }
    const { status, body: res } = await readResult(await h.handle(edgeRequest(body(), { headers: OWNER })))
    expect(status).toBe(500)
    expect(res.error).toBe('db down')
  })

  it('未预料的非 Error 抛出 → 500 且给通用文案「邀请失败」', async () => {
    const h = await load()
    h.fake.client.auth.getUser.mockRejectedValueOnce('字符串异常')
    const { status, body: res } = await readResult(await h.handle(edgeRequest(body(), { headers: OWNER })))
    expect(status).toBe(500)
    expect(res.error).toBe('邀请失败')
  })
})

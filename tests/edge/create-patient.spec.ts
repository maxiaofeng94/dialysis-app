// @vitest-environment node
/**
 * create-patient Edge Function 测试
 *
 * 这个函数是「建病人 + 把调用者挂成 owner」的原子操作，重点在：
 *   · 参数校验必须在鉴权之前（白名单顺序）—— 缺名字不该浪费一次 getUser；
 *   · 请求体一律按「可能不是合法 JSON、字段可能不是期望类型」处理：非法 JSON、非字符串
 *     name、负数/非数字的重量与回水量都回 400，绝不因为一个字段类型不对冒 500；
 *   · 服务端用 service_role 绕过 RLS，user_id 只能来自请求头 token，不能来自 body；
 *   · 成员插入失败必须回滚已建的病人，否则会留下「谁也看不到」的孤儿病人。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { loadEdgeFunction, edgeRequest, readResult } from '../helpers/edge'
import type { FakeSupabaseOptions, Row } from '../helpers/fakeSupabase'

const AUTH = { Authorization: 'Bearer tok-1' }
const ALLOWED_ORIGIN = 'https://dialysis-49v.pages.dev'

/** 装载 create-patient；默认带一个可用 token（tok-1 → user-1） */
async function load(overrides: FakeSupabaseOptions = {}) {
  return loadEdgeFunction(() => import('../../supabase/functions/create-patient/index.ts'), {
    fakeOptions: {
      ...overrides,
      tables: overrides.tables ?? {},
      tokens: { 'tok-1': { id: 'user-1' }, ...(overrides.tokens ?? {}) },
    },
  })
}

describe('create-patient · CORS 与方法', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('OPTIONS 预检 → 200 且下发白名单 CORS 头', async () => {
    const h = await load()
    const res = await h.handle(edgeRequest(null, { method: 'OPTIONS', origin: ALLOWED_ORIGIN }))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN)
  })

  it('GET → 405，且不触碰数据库', async () => {
    const h = await load()
    const { status, body } = await readResult(await h.handle(edgeRequest(null, { method: 'GET' })))
    expect(status).toBe(405)
    expect(body.error).toBe('Method Not Allowed')
    expect(h.fake.calls).toHaveLength(0)
  })

  it('非白名单 Origin 的响应不带 ACAO（浏览器侧拦截）', async () => {
    const h = await load()
    const res = await h.handle(
      edgeRequest({ name: '张三' }, { headers: AUTH, origin: 'https://evil.com' }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})

describe('create-patient · 参数校验（先于鉴权）', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  // 回归：曾经直接 `!name?.trim()`，非字符串的 name 会在 `12345.trim` 上抛 TypeError → 500。
  // 现在先判 typeof、非字符串按空串处理，所以下面这一组（含数字/对象/数组/null）一律是 400。
  it.each([
    ['完全缺失', { name: undefined }],
    ['空串', { name: '' }],
    ['纯空白', { name: '   ' }],
    ['只有换行', { name: '\n\t' }],
    ['数字', { name: 12345 }],
    ['对象', { name: { first: '张' } }],
    ['数组', { name: ['张三'] }],
    ['null', { name: null }],
    ['布尔值', { name: true }],
  ])('病人姓名 %s → 400「请填写病人姓名」且不插入任何数据', async (_label, body) => {
    const h = await load()
    const { status, body: res } = await readResult(await h.handle(edgeRequest(body, { headers: AUTH })))
    expect(status).toBe(400)
    expect(res.error).toBe('请填写病人姓名')
    expect(h.fake.callsOn('patients')).toHaveLength(0)
    expect(h.fake.callsOn('patient_members')).toHaveLength(0)
    // 参数校验在最前：还没到识别调用者那一步
    expect(h.fake.client.auth.getUser).not.toHaveBeenCalled()
  })

  it.each([
    ['轮椅重量为负', { wheelchairWeight: -1 }],
    ['轮椅重量非数字', { wheelchairWeight: 'abc' }],
    ['轮椅重量是字符串 NaN', { wheelchairWeight: 'NaN' }],
    ['回水量为负', { rinseBackVolume: -0.5 }],
    ['回水量非数字', { rinseBackVolume: 'abc' }],
    ['回水量是字符串 Infinity', { rinseBackVolume: 'Infinity' }],
  ])('%s → 400「轮椅重量与回水量必须是不小于 0 的数字」且不插库', async (_label, patch) => {
    const h = await load()
    const { status, body: res } = await readResult(
      await h.handle(edgeRequest({ name: '张三', ...patch }, { headers: AUTH })),
    )
    expect(status).toBe(400)
    expect(res.error).toBe('轮椅重量与回水量必须是不小于 0 的数字')
    expect(h.fake.callsOn('patients')).toHaveLength(0)
    expect(h.fake.callsOn('patient_members')).toHaveLength(0)
    // 数值校验同样在鉴权之前
    expect(h.fake.client.auth.getUser).not.toHaveBeenCalled()
  })

  it('姓名过长不做限制（1~30 由前端约束，函数只挡空值）', async () => {
    const h = await load()
    const res = await h.handle(edgeRequest({ name: 'x'.repeat(50) }, { headers: AUTH }))
    expect(res.status).toBe(200)
    // 钉住「函数只挡空值」这一分工，避免前端 30 字上限与后端各说各话
    expect(h.fake.tables.patients[0].name).toHaveLength(50)
  })

  it('请求体不是合法 JSON → 400「请填写病人姓名」（按空对象处理，不是 500）', async () => {
    const h = await load()
    const req = new Request('https://test-project.supabase.co/functions/v1/create-patient', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{不是json',
    })
    const { status, body } = await readResult(await h.handle(req))
    expect(status).toBe(400)
    expect(body.error).toBe('请填写病人姓名')
    expect(h.fake.callsOn('patients')).toHaveLength(0)
  })
})

describe('create-patient · 鉴权', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('没有 Authorization 头 → 401「未登录」，不建病人', async () => {
    const h = await load()
    const { status, body } = await readResult(await h.handle(edgeRequest({ name: '张三' })))
    expect(status).toBe(401)
    expect(body.error).toBe('未登录')
    expect(h.fake.callsOn('patients')).toHaveLength(0)
  })

  it('Authorization 头为空串 → 401「未登录」（token 为空即视为未登录）', async () => {
    const h = await load()
    const { status, body } = await readResult(
      await h.handle(edgeRequest({ name: '张三' }, { headers: { Authorization: '' } })),
    )
    expect(status).toBe(401)
    expect(body.error).toBe('未登录')
    expect(h.fake.callsOn('patients')).toHaveLength(0)
  })

  it('只有 "Bearer" 没带 token 时（运行时已去掉尾空格）按「登录已过期」处理', async () => {
    const h = await load()
    const { status, body } = await readResult(
      await h.handle(edgeRequest({ name: '张三' }, { headers: { Authorization: 'Bearer ' } })),
    )
    expect(status).toBe(401)
    expect(body.error).toBe('登录已过期，请重新登录')
    expect(h.fake.callsOn('patients')).toHaveLength(0)
  })

  it('token 无效（不在 tokens 表里）→ 401「登录已过期，请重新登录」', async () => {
    const h = await load()
    const { status, body } = await readResult(
      await h.handle(edgeRequest({ name: '张三' }, { headers: { Authorization: 'Bearer expired-token' } })),
    )
    expect(status).toBe(401)
    expect(body.error).toBe('登录已过期，请重新登录')
    expect(h.fake.callsOn('patients')).toHaveLength(0)
  })

  it('token 对应用户为空对象（getUser 返回 user 但无 id）→ 401', async () => {
    const h = await load({ tokens: { 'tok-empty': {} } })
    const { status, body } = await readResult(
      await h.handle(edgeRequest({ name: '张三' }, { headers: { Authorization: 'Bearer tok-empty' } })),
    )
    expect(status).toBe(401)
    expect(body.error).toBe('登录已过期，请重新登录')
  })

  it('Bearer 前缀大小写不敏感（bearer / BEARER 都认）', async () => {
    for (const scheme of ['bearer', 'BEARER', 'BeArEr']) {
      const h = await load()
      const res = await h.handle(
        edgeRequest({ name: '张三' }, { headers: { Authorization: `${scheme} tok-1` } }),
      )
      expect(res.status).toBe(200)
      expect(h.fake.tables.patient_members[0].user_id).toBe('user-1')
    }
  })

  it('user_id 只认 token，忽略请求体里伪造的 userId', async () => {
    const h = await load()
    await h.handle(edgeRequest({ name: '张三', userId: 'user-999', user_id: 'user-999' }, { headers: AUTH }))
    expect(h.fake.tables.patient_members[0].user_id).toBe('user-1')
    expect(h.fake.tables.patients[0]).not.toHaveProperty('userId')
  })
})

describe('create-patient · 成功路径', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('建病人 + 挂 owner，name 去空白、默认值 0 / 300，返回 {success, patient}', async () => {
    const h = await load()
    const { status, body } = await readResult(
      await h.handle(edgeRequest({ name: '  张三  ' }, { headers: AUTH })),
    )

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.patient).toMatchObject({ name: '张三', wheelchair_weight: 0, rinse_back_volume: 300 })

    const pCall = h.fake.lastCall('patients')
    expect(pCall?.op).toBe('insert')
    expect(pCall?.payload).toEqual({ name: '张三', wheelchair_weight: 0, rinse_back_volume: 300 })

    const mCall = h.fake.lastCall('patient_members')
    expect(mCall?.op).toBe('insert')
    expect(mCall?.payload).toEqual({
      patient_id: body.patient.id,
      user_id: 'user-1',
      role: 'owner',
    })
  })

  it('传入 wheelchairWeight / rinseBackVolume 时按值写入', async () => {
    const h = await load()
    await h.handle(
      edgeRequest({ name: '李四', wheelchairWeight: 21500, rinseBackVolume: 500 }, { headers: AUTH }),
    )
    expect(h.fake.lastCall('patients')?.payload).toEqual({
      name: '李四',
      wheelchair_weight: 21500,
      rinse_back_volume: 500,
    })
  })

  it('显式传 0 时写 0（?? 只兜 null/undefined，不是 falsy）', async () => {
    const h = await load()
    await h.handle(
      edgeRequest({ name: '李四', wheelchairWeight: 0, rinseBackVolume: 0 }, { headers: AUTH }),
    )
    expect(h.fake.lastCall('patients')?.payload).toEqual({
      name: '李四',
      wheelchair_weight: 0,
      rinse_back_volume: 0,
    })
  })

  it('数字字符串按 Number() 转成数字后写库（不再是原样的字符串）', async () => {
    const h = await load()
    await h.handle(
      edgeRequest({ name: '李四', wheelchairWeight: '21500', rinseBackVolume: ' 500 ' }, { headers: AUTH }),
    )
    // Number(' 500 ') === 500：两端空白与字符串形态都会被归一化成数字
    expect(h.fake.lastCall('patients')?.payload).toEqual({
      name: '李四',
      wheelchair_weight: 21500,
      rinse_back_volume: 500,
    })
  })

  it('传 null 时回落到默认值', async () => {
    const h = await load()
    await h.handle(
      edgeRequest({ name: '李四', wheelchairWeight: null, rinseBackVolume: null }, { headers: AUTH }),
    )
    // 注：JSON 没有 NaN 字面量（JS 的 NaN 会被序列化成 null），所以「传 NaN」在真实请求里
    // 就等于传 null → 同样回落默认值；只有字符串 'NaN' 才会走 400（见上面参数校验那组）
    expect(h.fake.lastCall('patients')?.payload).toEqual({
      name: '李四',
      wheelchair_weight: 0,
      rinse_back_volume: 300,
    })
  })

  it('多人调用互不影响：各自拿到自己的病人与 owner 关系', async () => {
    const h = await load({
      tokens: { 'tok-2': { id: 'user-2' } },
      tables: { patients: [], patient_members: [] },
    })
    const first = await readResult(await h.handle(edgeRequest({ name: '甲' }, { headers: AUTH })))
    const second = await readResult(
      await h.handle(edgeRequest({ name: '乙' }, { headers: { Authorization: 'Bearer tok-2' } })),
    )

    expect(h.fake.tables.patients.map((p: Row) => p.name)).toEqual(['甲', '乙'])
    expect(h.fake.tables.patient_members.map((m: Row) => [m.patient_id, m.user_id])).toEqual([
      [first.body.patient.id, 'user-1'],
      [second.body.patient.id, 'user-2'],
    ])
  })
})

describe('create-patient · 失败与回滚', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('病人插入失败 → 400 原样回传数据库错误，不写成员关系', async () => {
    const h = await load({
      failOn: (call) => (call.table === 'patients' && call.op === 'insert' ? { message: 'duplicate key' } : null),
    })
    const { status, body } = await readResult(await h.handle(edgeRequest({ name: '张三' }, { headers: AUTH })))
    expect(status).toBe(400)
    expect(body.error).toBe('duplicate key')
    expect(h.fake.callsOn('patient_members')).toHaveLength(0)
  })

  it('成员插入失败 → 回滚删除刚建的病人，返回 400 与原始错误', async () => {
    const h = await load({
      failOn: (call) =>
        call.table === 'patient_members' && call.op === 'insert' ? { message: '成员写入失败' } : null,
    })
    const { status, body } = await readResult(await h.handle(edgeRequest({ name: '张三' }, { headers: AUTH })))

    expect(status).toBe(400)
    expect(body.error).toBe('成员写入失败')
    // 关键不变量：patients 表最终为空（不存在孤儿病人）
    expect(h.fake.tables.patients).toHaveLength(0)
    // 且确实是「删掉刚建的那一条」，而不是别的什么操作
    const delCall = h.fake.callsOn('patients').find((c) => c.op === 'delete')
    expect(delCall).toBeDefined()
    expect(delCall?.filters).toEqual([{ col: 'id', val: expect.any(String) }])
  })

  it('鉴权环节抛异常 → 500，不泄露堆栈', async () => {
    const h = await load()
    h.fake.client.auth.getUser.mockRejectedValueOnce(new Error('auth service down'))
    const { status, body } = await readResult(await h.handle(edgeRequest({ name: '张三' }, { headers: AUTH })))
    expect(status).toBe(500)
    expect(body.error).toBe('auth service down')
    expect(h.fake.callsOn('patients')).toHaveLength(0)
  })

  it('未预料的非 Error 抛出 → 500 且给通用文案「创建失败」', async () => {
    const h = await load()
    h.fake.client.auth.getUser.mockRejectedValueOnce('字符串异常')
    const { status, body } = await readResult(await h.handle(edgeRequest({ name: '张三' }, { headers: AUTH })))
    expect(status).toBe(500)
    expect(body.error).toBe('创建失败')
  })
})

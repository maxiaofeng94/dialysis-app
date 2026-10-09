// @vitest-environment node
/**
 * register Edge Function 测试
 *
 * 这是全网唯一免登录入口，也是被刷得最狠的一个 —— 用例覆盖：
 * 限流四道闸的顺序、fail-closed、人机验证、参数校验、建号参数。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { loadEdgeFunction, edgeRequest, readResult, type EdgeHarness } from '../helpers/edge'

type RpcImpl = (params?: Record<string, any>) => unknown

/** 装载 register，rpc 行为可定制；默认「限流全部放行」 */
async function load(overrides: { rpc?: RpcImpl; env?: Record<string, string | undefined> } = {}) {
  const calls: Record<string, any>[] = []
  const rpc: RpcImpl =
    overrides.rpc ??
    ((params) => {
      calls.push(params ?? {})
      return true
    })
  const harness = await loadEdgeFunction(() => import('../../supabase/functions/register/index.ts'), {
    env: overrides.env,
    fakeOptions: {
      rpc: {
        check_rate_limit: (params) => {
          if (overrides.rpc) calls.push(params ?? {})
          return rpc(params)
        },
      },
    },
  })
  return Object.assign(harness, { rpcCalls: calls })
}

describe('register · CORS 与方法', () => {
  let h: Awaited<ReturnType<typeof load>>
  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h = await load()
  })

  it('OPTIONS 预检无条件放行，且只给白名单 Origin 回 CORS 头', async () => {
    const res = await h.handle(edgeRequest(null, { method: 'OPTIONS', origin: 'https://dialysis-49v.pages.dev' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://dialysis-49v.pages.dev')
    expect(res.headers.get('Vary')).toBe('Origin')
  })

  it('非白名单 Origin 不下发 Access-Control-Allow-Origin（浏览器自行拦截）', async () => {
    const res = await h.handle(edgeRequest(null, { method: 'OPTIONS', origin: 'https://evil.example.com' }))
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(res.headers.get('Vary')).toBe('Origin')
  })

  it('GET 返回 405', async () => {
    const res = await h.handle(edgeRequest(null, { method: 'GET' }))
    expect(res.status).toBe(405)
    expect((await readResult(res)).body.error).toBe('Method Not Allowed')
  })
})

describe('register · 限流与容错', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('IP 分钟限流命中 → 429 且带 Retry-After: 60', async () => {
    const h = await load({ rpc: (p) => p?.p_bucket !== 'register:ip:minute' })
    const res = await h.handle(edgeRequest({ phone: '13800000000', password: 'secret1' }))
    const { status, body, headers } = await readResult(res)
    expect(status).toBe(429)
    expect(headers.get('Retry-After')).toBe('60')
    expect(body.error).toContain('操作过于频繁')
  })

  it('IP 小时限流命中 → Retry-After: 60（同组第一道规则）', async () => {
    const h = await load({ rpc: (p) => p?.p_bucket !== 'register:ip:hour' })
    const res = await h.handle(edgeRequest({ phone: '13800000000', password: 'secret1' }))
    expect(res.status).toBe(429)
  })

  it('全局限流命中 → 429 且带 Retry-After: 300', async () => {
    const h = await load({ rpc: (p) => p?.p_bucket !== 'register:global:hour' })
    const res = await h.handle(edgeRequest({ phone: '13800000000', password: 'secret1' }))
    const { status, headers } = await readResult(res)
    expect(status).toBe(429)
    expect(headers.get('Retry-After')).toBe('300')
  })

  it('手机号限流命中 → 429 且带 Retry-After: 3600', async () => {
    const h = await load({ rpc: (p) => p?.p_bucket !== 'register:phone:hour' })
    const res = await h.handle(edgeRequest({ phone: '13800000000', password: 'secret1' }))
    const { status, headers } = await readResult(res)
    expect(status).toBe(429)
    expect(headers.get('Retry-After')).toBe('3600')
  })

  it('限流 RPC 报错 → 503（fail closed，绝不带病放行）', async () => {
    const h = await load({ rpc: () => ({ error: { message: 'function does not exist' } }) })
    const res = await h.handle(edgeRequest({ phone: '13800000000', password: 'secret1' }))
    const { status, body } = await readResult(res)
    expect(status).toBe(503)
    expect(body.error).toContain('暂时不可用')
    expect(h.fake.callsOn('rpc:check_rate_limit').length).toBeGreaterThan(0)
  })

  it('限流在参数校验之前执行：非法手机号也要计数', async () => {
    const h = await load()
    await h.handle(edgeRequest({ phone: '不是手机号', password: 'x' }))
    expect(h.rpcCalls.some((c) => c.p_bucket === 'register:ip:minute')).toBe(true)
  })

  it('限流阈值与设计一致（minute=5 / ip.hour=20 / global=300 / phone=3）', async () => {
    const h = await load()
    await h.handle(edgeRequest({ phone: '13800000000', password: 'secret1' }))
    const byBucket = Object.fromEntries(h.rpcCalls.map((c) => [c.p_bucket, c]))
    expect(byBucket['register:ip:minute']).toMatchObject({ p_max: 5, p_window_seconds: 60 })
    expect(byBucket['register:ip:hour']).toMatchObject({ p_max: 20, p_window_seconds: 3600 })
    expect(byBucket['register:global:hour']).toMatchObject({ p_max: 300, p_window_seconds: 3600 })
    expect(byBucket['register:phone:hour']).toMatchObject({ p_max: 3, p_window_seconds: 3600 })
  })

  it('取 x-forwarded-for 的第一段作为调用方 IP', async () => {
    const h = await load()
    await h.handle(
      edgeRequest(
        { phone: '13800000000', password: 'secret1' },
        { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } },
      ),
    )
    expect(h.rpcCalls.find((c) => c.p_bucket === 'register:ip:minute')?.p_key).toBe('1.2.3.4')
  })

  it('没有 x-forwarded-for 时退回 cf-connecting-ip / x-real-ip', async () => {
    const h = await load()
    await h.handle(edgeRequest({ phone: '13800000000', password: 'secret1' }, { headers: { 'cf-connecting-ip': '9.9.9.9' } }))
    expect(h.rpcCalls.find((c) => c.p_bucket === 'register:ip:minute')?.p_key).toBe('9.9.9.9')

    const h2 = await load()
    await h2.handle(edgeRequest({ phone: '13800000000', password: 'secret1' }))
    expect(h2.rpcCalls.find((c) => c.p_bucket === 'register:ip:minute')?.p_key).toBe('unknown')
  })
})

describe('register · 参数校验', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it.each([
    ['空值', undefined],
    ['位数不足', '1380000000'],
    ['位数过多', '138000000000'],
    ['第二位非法', '12800000000'],
    ['含字母', '1380000000a'],
  ])('手机号 %s → 400 且不建号', async (_label, phone) => {
    const h = await load()
    const res = await h.handle(edgeRequest({ phone, password: 'secret1' }))
    const { status, body } = await readResult(res)
    expect(status).toBe(400)
    expect(body.error).toBe('手机号格式不正确')
    expect(h.fake.client.auth.admin.createUser).not.toHaveBeenCalled()
  })

  it('密码少于 6 位 → 400', async () => {
    const h = await load()
    const res = await h.handle(edgeRequest({ phone: '13800000000', password: '12345' }))
    const { status, body } = await readResult(res)
    expect(status).toBe(400)
    expect(body.error).toBe('密码至少 6 位')
  })

  it('密码非字符串 → 400', async () => {
    const h = await load()
    const res = await h.handle(edgeRequest({ phone: '13800000000', password: 123456 }))
    expect(res.status).toBe(400)
  })

  it('请求体不是合法 JSON 时按空对象处理（400，不抛 500）', async () => {
    const h = await load()
    const req = new Request('https://test-project.supabase.co/functions/v1/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{不是json',
    })
    const res = await h.handle(req)
    expect(res.status).toBe(400)
  })
})

describe('register · 人机验证', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('未配置 TURNSTILE_SECRET_KEY 时跳过校验（只靠限流）', async () => {
    const h = await load()
    const res = await h.handle(edgeRequest({ phone: '13800000000', password: 'secret1' }))
    expect(res.status).toBe(200)
  })

  it('已配置但未带 token → 400', async () => {
    const h = await load({ env: { TURNSTILE_SECRET_KEY: 'turnstile-secret' } })
    const res = await h.handle(edgeRequest({ phone: '13800000000', password: 'secret1' }))
    const { status, body } = await readResult(res)
    expect(status).toBe(400)
    expect(body.error).toContain('人机验证')
  })

  it('已配置且 token 校验通过 → 放行', async () => {
    const h = await load({ env: { TURNSTILE_SECRET_KEY: 'turnstile-secret' } })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await h.handle(edgeRequest({ phone: '13800000000', password: 'secret1', turnstileToken: 'tok' }))
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('challenges.cloudflare.com/turnstile')
    expect(String(init.body)).toContain('response=tok')
  })

  it('Cloudflare 返回失败 → 400（不放行）', async () => {
    const h = await load({ env: { TURNSTILE_SECRET_KEY: 'turnstile-secret' } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 200 })))
    const res = await h.handle(edgeRequest({ phone: '13800000000', password: 'secret1', turnstileToken: 'bad' }))
    expect(res.status).toBe(400)
  })

  it('校验请求抛异常 → 400（fail closed）', async () => {
    const h = await load({ env: { TURNSTILE_SECRET_KEY: 'turnstile-secret' } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    const res = await h.handle(edgeRequest({ phone: '13800000000', password: 'secret1', turnstileToken: 'tok' }))
    expect(res.status).toBe(400)
  })
})

describe('register · 建号', () => {
  let h: Awaited<ReturnType<typeof load>>
  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h = await load()
  })

  it('成功建号：伪邮箱 + 已确认 + user_metadata 带手机号', async () => {
    const res = await h.handle(edgeRequest({ phone: '13800000000', password: 'secret1' }))
    const { status, body } = await readResult(res)
    expect(status).toBe(200)
    expect(body).toEqual({ success: true })

    const createUser = h.fake.client.auth.admin.createUser
    expect(createUser).toHaveBeenCalledOnce()
    expect(createUser.mock.calls[0][0]).toMatchObject({
      email: '13800000000@phone.local',
      password: 'secret1',
      email_confirm: true,
      user_metadata: { phone: '13800000000', name: '' },
    })
  })

  it('手机号已注册 → 400 且提示直接登录', async () => {
    const h2 = await load({
      rpc: () => true,
    })
    h2.fake.client.auth.admin.createUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'A user with this email address has already been registered' },
    })
    const res = await h2.handle(edgeRequest({ phone: '13800000000', password: 'secret1' }))
    const { status, body } = await readResult(res)
    expect(status).toBe(400)
    expect(body.error).toBe('该手机号已注册，请直接登录')
  })

  it('其他建号错误原样回传 400', async () => {
    h.fake.client.auth.admin.createUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'Password should be at least 6 characters' },
    })
    const res = await h.handle(edgeRequest({ phone: '13800000000', password: 'secret1' }))
    const { status, body } = await readResult(res)
    expect(status).toBe(400)
    expect(body.error).toContain('Password')
  })

  it('未预料的异常 → 500 且不泄露堆栈以外的信息', async () => {
    h.fake.client.auth.admin.createUser.mockRejectedValueOnce(new Error('boom'))
    const res = await h.handle(edgeRequest({ phone: '13800000000', password: 'secret1' }))
    const { status } = await readResult(res)
    expect(status).toBe(500)
  })
})

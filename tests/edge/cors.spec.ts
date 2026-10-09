// @vitest-environment node
/**
 * _shared/cors.ts 测试
 *
 * CORS 不是服务端防护，但白名单写错的两个方向都会出事：
 *   · 太松（放行 evil.com 或后缀伪装域名）→ 任意网页能借访客浏览器调我们的接口；
 *   · 太紧（漏掉某个部署域名）→ 前端直接被浏览器拦死，且只在真机/线上才暴露。
 * 所以这里把白名单逐条钉死，并覆盖「不命中时绝不回 * 」这条底线。
 */
import { describe, it, expect } from 'vitest'
import {
  allowedOrigin,
  corsHeaders,
  preflight,
  jsonResponse,
} from '../../supabase/functions/_shared/cors'

/** 造一个带 Origin 的请求（origin 传 undefined / null 表示不带该头） */
function req(origin?: string | null, method = 'POST'): Request {
  const headers: Record<string, string> = {}
  if (origin !== undefined && origin !== null) headers.Origin = origin
  return new Request('https://test-project.supabase.co/functions/v1/any', { method, headers })
}

/** 线上 + 本地开发 + Capacitor WebView：必须原样放行 */
const ALLOWED = [
  'https://dialysis-49v.pages.dev',
  'https://dialysis-admin.pages.dev',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  'https://localhost',
  'capacitor://localhost',
  'http://localhost',
]

describe('cors · allowedOrigin 白名单', () => {
  it.each(ALLOWED)('白名单内的 Origin 原样返回：%s', (origin) => {
    expect(allowedOrigin(req(origin))).toBe(origin)
  })

  it.each([
    ['App 预览域名', 'https://abc123.dialysis-49v.pages.dev'],
    ['后台预览域名', 'https://x.dialysis-admin.pages.dev'],
    ['多级子域也算预览', 'https://pre.fix.dialysis-49v.pages.dev'],
  ])('Cloudflare Pages 预览域名放行（%s）：%s', (_label, origin) => {
    expect(allowedOrigin(req(origin))).toBe(origin)
  })

  it('预览域名必须是 https：http 一律拒绝', () => {
    expect(allowedOrigin(req('http://abc.dialysis-49v.pages.dev'))).toBeNull()
    expect(allowedOrigin(req('http://x.dialysis-admin.pages.dev'))).toBeNull()
  })

  it('没有 Origin 头 → null（curl / 服务端调用照常处理，只是不下发 CORS 头）', () => {
    expect(allowedOrigin(req(undefined))).toBeNull()
    expect(allowedOrigin(req(null))).toBeNull()
  })

  it('Origin 为空串 → null', () => {
    const r = new Request('https://test-project.supabase.co/functions/v1/any', {
      method: 'POST',
      headers: { Origin: '' },
    })
    expect(allowedOrigin(r)).toBeNull()
  })

  it('无关域名 / 后缀伪装 / 相似域名一律拒绝', () => {
    // 后缀伪装：真正的域名是 evil.com
    expect(allowedOrigin(req('https://dialysis-49v.pages.dev.evil.com'))).toBeNull()
    // 后缀伪装（后台）
    expect(allowedOrigin(req('https://dialysis-admin.pages.dev.evil.com'))).toBeNull()
    // 前缀伪装：没有那一「点」，不构成子域
    expect(allowedOrigin(req('https://evil-dialysis-49v.pages.dev'))).toBeNull()
    // 其它站点
    expect(allowedOrigin(req('https://evil.com'))).toBeNull()
    expect(allowedOrigin(req('https://dialysis-49v.pages.dev:8443'))).toBeNull()
    expect(allowedOrigin(req('https://pages.dev'))).toBeNull()
  })

  it('非法 URL 的 Origin → null（不抛异常）', () => {
    expect(allowedOrigin(req('not-a-url'))).toBeNull()
    expect(allowedOrigin(req('///'))).toBeNull()
    expect(allowedOrigin(req('null'))).toBeNull()
  })

  it('大小写不同不算命中（主机名会被 URL 小写化，但后缀必须带那一「点」）', () => {
    expect(allowedOrigin(req('HTTPS://DIALYSIS-49V.PAGES.DEV'))).toBeNull()
    expect(allowedOrigin(req('HTTPS://DIALYSIS-ADMIN.PAGES.DEV'))).toBeNull()
  })

  it('带路径 / 尾斜杠的 Origin 不命中（Origin 里本不该有路径）', () => {
    expect(allowedOrigin(req('https://dialysis-49v.pages.dev/'))).toBeNull()
    expect(allowedOrigin(req('https://dialysis-49v.pages.dev/app'))).toBeNull()
  })

  it('首尾空白由运行时（Headers）去掉，故等价于白名单条目本身 —— 不是绕过', () => {
    const r = new Request('https://test-project.supabase.co/functions/v1/any', {
      method: 'POST',
      headers: { Origin: ' https://dialysis-49v.pages.dev ' },
    })
    expect(r.headers.get('Origin')).toBe('https://dialysis-49v.pages.dev')
    expect(allowedOrigin(r)).toBe('https://dialysis-49v.pages.dev')
  })
})

describe('cors · corsHeaders', () => {
  it('命中白名单：回三个 Access-Control-* 头 + Vary: Origin', () => {
    const headers = corsHeaders(req('https://dialysis-admin.pages.dev'))
    expect(headers['Access-Control-Allow-Origin']).toBe('https://dialysis-admin.pages.dev')
    expect(headers['Access-Control-Allow-Headers']).toBe(
      'authorization, x-client-info, apikey, content-type',
    )
    expect(headers['Access-Control-Allow-Methods']).toBe('POST, OPTIONS')
    expect(headers.Vary).toBe('Origin')
  })

  it('未命中：只回 Vary: Origin，绝不回 * 或回显 Origin', () => {
    const headers = corsHeaders(req('https://evil.com'))
    expect(headers).toEqual({ Vary: 'Origin' })
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined()
    expect(headers['Access-Control-Allow-Origin']).not.toBe('*')
  })

  it('没有 Origin：同样只回 Vary: Origin', () => {
    expect(corsHeaders(req(undefined))).toEqual({ Vary: 'Origin' })
    expect(corsHeaders(req(null))).toEqual({ Vary: 'Origin' })
  })
})

describe('cors · preflight', () => {
  it('预检固定 200 + ok，且带白名单 CORS 头（浏览器预检不带凭据也要放行）', async () => {
    const res = preflight(req('https://dialysis-49v.pages.dev', 'OPTIONS'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://dialysis-49v.pages.dev')
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS')
    expect(res.headers.get('Vary')).toBe('Origin')
  })

  it('非白名单 Origin 的预检同样 200，但不下发 ACAO', async () => {
    const res = preflight(req('https://evil.com', 'OPTIONS'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(res.headers.get('Vary')).toBe('Origin')
  })
})

describe('cors · jsonResponse', () => {
  it('默认 200 + JSON 头 + 序列化 body，并合并 CORS 头', async () => {
    const res = jsonResponse(req('https://dialysis-49v.pages.dev'), { success: true, n: 1 })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://dialysis-49v.pages.dev')
    expect(await res.json()).toEqual({ success: true, n: 1 })
  })

  it('自定义状态码与 extra 头生效，extra 可覆盖默认头', async () => {
    const res = jsonResponse(req(undefined), { error: '未登录' }, 401, {
      'Retry-After': '60',
      'Content-Type': 'application/json; charset=utf-8',
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('Retry-After')).toBe('60')
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8')
    expect(await res.json()).toEqual({ error: '未登录' })
  })

  it('未命中白名单时响应里没有任何 ACAO（浏览器自行拦截读取）', async () => {
    const res = jsonResponse(req('https://evil.com'), { error: '无后台权限' }, 403)
    expect(res.status).toBe(403)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(res.headers.get('Vary')).toBe('Origin')
    expect(await res.json()).toEqual({ error: '无后台权限' })
  })

  it('没有 Origin 的请求照常返回 body（服务端调用可用）', async () => {
    const res = jsonResponse(req(null), { ok: true })
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(await res.json()).toEqual({ ok: true })
  })
})

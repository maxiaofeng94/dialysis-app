/**
 * Edge Function（Deno）测试装载器。
 *
 * 源码里用了 Deno 专有 API 与 npm: 说明符，直接 import 会炸。这里在 import 之前：
 *   1. 用 vi.stubGlobal 注入最小 Deno 运行时（env.get / serve 捕获入口 handler）；
 *   2. 用 vi.doMock 把 @supabase/supabase-js 换成可编程替身（见 fakeSupabase.ts）。
 *
 * 注意：每次装载都会重新执行模块顶层代码（vi.resetModules），所以同一测试文件里
 * 可以针对不同场景反复装载同一个函数。
 */
import { vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase, type FakeSupabaseOptions } from './fakeSupabase'

export interface EdgeHarness {
  /** 直接调用 Edge Function 的入口（等价于网关把请求交给它） */
  handle: (req: Request) => Promise<Response>
  fake: FakeSupabase
  env: Record<string, string | undefined>
  setEnv: (key: string, value: string | undefined) => void
}

const DEFAULT_ENV: Record<string, string | undefined> = {
  SUPABASE_URL: 'https://test-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
}

export async function loadEdgeFunction(
  importer: () => Promise<unknown>,
  opts: { env?: Record<string, string | undefined>; fakeOptions?: FakeSupabaseOptions; fake?: FakeSupabase } = {},
): Promise<EdgeHarness> {
  const fake = opts.fake ?? makeFakeSupabase(opts.fakeOptions)
  const env: Record<string, string | undefined> = { ...DEFAULT_ENV, ...opts.env }

  let handler: ((req: Request) => Promise<Response>) | null = null

  vi.stubGlobal('Deno', {
    env: {
      get: (k: string) => env[k],
      set: (k: string, v: string) => {
        env[k] = v
      },
      toObject: () => ({ ...env }),
    },
    serve: (h: (req: Request) => Promise<Response>) => {
      handler = h
      return {
        finished: Promise.resolve(),
        shutdown: async () => {},
        ref: () => {},
        unref: () => {},
      }
    },
  })

  vi.resetModules()
  vi.doMock('@supabase/supabase-js', () => ({ createClient: () => fake.client }))
  await importer()

  if (!handler) throw new Error('Edge Function 未调用 Deno.serve()，无法取得入口 handler')

  return {
    handle: handler as unknown as (req: Request) => Promise<Response>,
    fake,
    env,
    setEnv: (k, v) => {
      env[k] = v
    },
  }
}

/** 构造一次 Edge Function 调用请求 */
export function edgeRequest(
  body: unknown,
  init: { method?: string; headers?: Record<string, string>; origin?: string | null; url?: string } = {},
): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...init.headers }
  if (init.origin) headers.Origin = init.origin
  const method = init.method ?? 'POST'
  return new Request(init.url ?? 'https://test-project.supabase.co/functions/v1/test', {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body),
  })
}

/** 读响应体 JSON（失败返回 {}，避免测试因非 JSON 响应挂掉） */
export async function readJson(res: Response): Promise<any> {
  return await res.json().catch(() => ({}))
}

/** 断言用的组合：状态码 + body */
export async function readResult(res: Response): Promise<{ status: number; body: any; headers: Headers }> {
  return { status: res.status, body: await readJson(res), headers: res.headers }
}

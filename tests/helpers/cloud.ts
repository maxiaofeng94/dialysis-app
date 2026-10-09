/**
 * 云端分支测试助手。
 *
 * 测试默认跑在「纯本地模式」（isCloudConfigured=false），要验证云端逻辑时：
 *
 *   vi.mock('../../src/lib/supabase', () => makeSupabaseModule({ configure: true, client: fake }))
 *
 * 注意：vi.mock 会被提升到文件顶部，因此这里的工厂函数必须是**自包含**的
 * （不能引用外部变量），假客户端通过工厂闭包的参数传入。
 */
import { vi } from 'vitest'

/** 造一个链式可 await 的 PostgREST 查询桩 */
export function makeQuery(result: { data?: unknown; error?: unknown; count?: number | null } = {}) {
  const resolved = {
    data: result.data ?? null,
    error: result.error ?? null,
    count: result.count ?? null,
  }
  const q: Record<string, unknown> = {}
  const chain = () => q
  for (const m of ['select', 'eq', 'neq', 'in', 'order', 'limit', 'range', 'update', 'insert', 'upsert', 'delete', 'is', 'or', 'filter', 'match', 'single', 'maybeSingle']) {
    q[m] = chain
  }
  // 让 `await q` 与 `await q.maybeSingle()` 都能拿到结果
  q.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(resolved).then(onFulfilled, onRejected)
  return q
}

/**
 * 生成一个 src/lib/supabase 模块替身。
 * 放在测试文件的 vi.mock 工厂里用（工厂内联，避免提升导致引用未初始化变量）。
 */
export function fakeSupabaseModule(opts: {
  configure?: boolean
  client?: unknown
  url?: string
  anonKey?: string
} = {}) {
  const configure = opts.configure ?? true
  return {
    isCloudConfigured: configure,
    supabase: configure ? (opts.client ?? null) : null,
    SUPABASE_URL: opts.url ?? (configure ? 'https://test-project.supabase.co' : ''),
    SUPABASE_ANON_KEY: opts.anonKey ?? (configure ? 'test-anon-key' : ''),
  }
}

/** 常用的 auth 桩：登录中 / 未登录 */
export function makeAuthClient(overrides: Record<string, unknown> = {}) {
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
      signInWithPassword: vi.fn(async () => ({ data: {}, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      ...overrides,
    },
    from: vi.fn(() => makeQuery()),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  }
}

/**
 * 可编程的 Supabase 客户端替身。
 *
 * 目的：让 supabase/functions/**（Deno）与 src/lib/cloudRepository.ts 的
 * 真实业务逻辑能在 Node 下被测，而不用连真库。
 *
 * 支持 PostgREST 的常用形态：
 *   from(t).select(cols, {count, head}).eq/in/order/range/limit → 可 await 也可 .single()/.maybeSingle()
 *   from(t).insert/update/upsert/delete
 *   rpc(name, params)
 *   auth.getUser(token) / auth.admin.{createUser,listUsers,updateUserById,deleteUser,getUserById}
 *
 * 用法见 tests/edge/*.spec.ts
 */
import { vi } from 'vitest'

export type Row = Record<string, any>

export interface FakeCall {
  table: string
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete'
  payload?: any
  filters: { col: string; val: any }[]
  count?: boolean
}

export interface FakeSupabaseOptions {
  /** 初始表数据，按表名分组；测试中可直接读改（同一引用） */
  tables?: Record<string, Row[]>
  /** rpc 实现：返回 { data } 或 { error }，也可直接返回数据 */
  rpc?: Record<string, (params?: Row) => any>
  /** access token → 用户对象；用于 auth.getUser(token) */
  tokens?: Record<string, Row | null>
  /** auth.admin.listUsers 的数据源 */
  authUsers?: Row[]
  /** 注入错误：返回非空对象则该次调用以 error 结束 */
  failOn?: (call: FakeCall) => { message: string } | null
}

export interface FakeSupabase {
  client: any
  calls: FakeCall[]
  tables: Record<string, Row[]>
  /** 取某张表上最后一次调用 */
  lastCall(table: string): FakeCall | undefined
  callsOn(table: string): FakeCall[]
}

type Mode = 'select' | 'insert' | 'update' | 'upsert' | 'delete'

function tableNameFromEmbed(cols: string): string {
  // 不支持嵌套 select；这里只做防御，返回原字符串便于报错
  return cols
}

/**
 * 深拷贝返回值。
 *
 * 真实 PostgREST 每次响应都是**新解析出来的 JSON 对象**，与「服务端那张表」没有引用关系；
 * 而替身如果直接把表内对象交出去，「先 select 读一行 → 再 update 同一行」的用例里，
 * 先前读到的那份数据会被后续写操作悄悄改掉（真实环境不会），从而把替身假象误判成产品缺陷。
 */
function clone<T>(v: T): T {
  return v == null ? v : (JSON.parse(JSON.stringify(v)) as T)
}

export function makeFakeSupabase(opts: FakeSupabaseOptions = {}): FakeSupabase {
  const tables: Record<string, Row[]> = opts.tables ?? {}
  const calls: FakeCall[] = []

  const ensure = (t: string): Row[] => (tables[t] ??= [])

  function from(table: string) {
    if (!tables[table]) ensure(table)

    let mode: Mode = 'select'
    let payload: any = null
    let filters: { col: string; val: any }[] = []
    let notEqFilters: { col: string; val: any }[] = []
    let inFilters: { col: string; vals: any[] }[] = []
    let isFilters: { col: string; val: any }[] = []
    let cmpFilters: { col: string; op: '>' | '>=' | '<' | '<='; val: any }[] = []
    let orderBys: { col: string; asc: boolean }[] = []
    let rangeFrom: number | null = null
    let rangeTo: number | null = null
    let limitN: number | null = null
    let wantCount = false
    let headOnly = false

    const record = (): FakeCall => {
      const call: FakeCall = { table, op: mode, payload, filters: [...filters], count: wantCount }
      calls.push(call)
      return call
    }

    function applyFilters(rows: Row[]): Row[] {
      let out = rows
      for (const f of filters) out = out.filter((r) => r[f.col] === f.val)
      for (const f of notEqFilters) out = out.filter((r) => r[f.col] !== f.val)
      for (const f of inFilters) out = out.filter((r) => f.vals.includes(r[f.col]))
      for (const f of isFilters) out = out.filter((r) => (r[f.col] ?? null) === f.val)
      for (const f of cmpFilters) {
        out = out.filter((r) => {
          const v = r[f.col]
          if (v == null) return false
          switch (f.op) {
            case '>':
              return v > f.val
            case '>=':
              return v >= f.val
            case '<':
              return v < f.val
            case '<=':
              return v <= f.val
          }
        })
      }
      return out
    }

    function exec(single = false, maybe = false): Promise<{ data: any; error: any; count?: number | null }> {
      const call = record()
      const injected = opts.failOn?.(call)
      if (injected) return Promise.resolve({ data: null, error: injected, count: null })

      const rows = ensure(table)
      let result: Row[]

      if (mode === 'insert') {
        const items = Array.isArray(payload) ? payload : [payload]
        for (const item of items) {
          const row = { id: item.id ?? `fake-${table}-${rows.length + 1}`, ...item }
          rows.push(row)
        }
        result = items.map((_, i) => rows[rows.length - items.length + i])
      } else if (mode === 'upsert') {
        const items = Array.isArray(payload) ? payload : [payload]
        for (const item of items) {
          const idx = item.id ? rows.findIndex((r) => r.id === item.id) : -1
          if (idx >= 0) rows[idx] = { ...rows[idx], ...item }
          else rows.push({ id: item.id ?? `fake-${table}-${rows.length + 1}`, ...item })
        }
        result = items
      } else if (mode === 'update') {
        const matched = applyFilters(rows)
        for (const r of matched) Object.assign(r, payload)
        result = matched
      } else if (mode === 'delete') {
        const matched = applyFilters(rows)
        const keep = rows.filter((r) => !matched.includes(r))
        tables[table] = keep
        result = matched
      } else {
        result = applyFilters(rows)
        if (orderBys.length) {
          // 支持多级排序（PostgREST 的 .order().order() 语义）：前一个键相等时看下一个键
          result = [...result].sort((a, b) => {
            for (const { col, asc } of orderBys) {
              const av = a[col]
              const bv = b[col]
              if (av === bv) continue
              return (av > bv ? 1 : -1) * (asc ? 1 : -1)
            }
            return 0
          })
        }
        const total = result.length
        if (rangeFrom != null) result = result.slice(rangeFrom, rangeTo != null ? rangeTo + 1 : undefined)
        if (limitN != null) result = result.slice(0, limitN)
        if (headOnly) {
          return Promise.resolve({ data: null, error: null, count: wantCount ? total : null })
        }
        if (wantCount) {
          return Promise.resolve({ data: clone(result), error: null, count: total })
        }
      }

      if (single) {
        if (result.length === 0) {
          return Promise.resolve({
            data: null,
            error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' },
            count: null,
          })
        }
        return Promise.resolve({ data: clone(result[0]), error: null, count: null })
      }
      if (maybe) {
        return Promise.resolve({ data: clone(result[0] ?? null), error: null, count: null })
      }
      return Promise.resolve({ data: clone(result), error: null, count: null })
    }

    const builder: any = {
      select(cols = '*', o: Row = {}) {
        tableNameFromEmbed(cols)
        if (o.count) wantCount = true
        if (o.head) headOnly = true
        return builder
      },
      insert(p: any) {
        mode = 'insert'
        payload = p
        return builder
      },
      update(p: any) {
        mode = 'update'
        payload = p
        return builder
      },
      upsert(p: any) {
        mode = 'upsert'
        payload = p
        return builder
      },
      delete() {
        mode = 'delete'
        return builder
      },
      eq(col: string, val: any) {
        filters.push({ col, val })
        return builder
      },
      neq(col: string, val: any) {
        notEqFilters.push({ col, val })
        return builder
      },
      in(col: string, vals: any[]) {
        inFilters.push({ col, vals })
        return builder
      },
      is(col: string, val: any) {
        isFilters.push({ col, val })
        return builder
      },
      gt(col: string, val: any) {
        cmpFilters.push({ col, op: '>', val })
        return builder
      },
      gte(col: string, val: any) {
        cmpFilters.push({ col, op: '>=', val })
        return builder
      },
      lt(col: string, val: any) {
        cmpFilters.push({ col, op: '<', val })
        return builder
      },
      lte(col: string, val: any) {
        cmpFilters.push({ col, op: '<=', val })
        return builder
      },
      order(col: string, o: Row = {}) {
        orderBys.push({ col, asc: o.ascending !== false })
        return builder
      },
      limit(n: number) {
        limitN = n
        return builder
      },
      range(a: number, b: number) {
        rangeFrom = a
        rangeTo = b
        return builder
      },
      single() {
        return exec(true, false)
      },
      maybeSingle() {
        return exec(false, true)
      },
      then(onF: any, onR: any) {
        return exec().then(onF, onR)
      },
    }
    return builder
  }

  const auth = {
    getUser: vi.fn(async (token?: string) => {
      const user = token ? (opts.tokens?.[token] ?? null) : null
      return { data: { user }, error: user ? null : { message: 'invalid token' } }
    }),
    getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
    signInWithPassword: vi.fn(async () => ({ data: {}, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    admin: {
      createUser: vi.fn(async (attrs: Row) => {
        calls.push({ table: 'auth.admin.createUser', op: 'insert', payload: attrs, filters: [] })
        const injected = opts.failOn?.({
          table: 'auth.admin.createUser',
          op: 'insert',
          payload: attrs,
          filters: [],
        })
        if (injected) return { data: { user: null }, error: injected }
        const user = { id: `auth-${attrs.email}`, email: attrs.email, ...attrs }
        ;(opts.authUsers ??= []).push(user)
        return { data: { user }, error: null }
      }),
      listUsers: vi.fn(async ({ page = 1, perPage = 1000 }: Row = {}) => {
        const all = opts.authUsers ?? []
        return { data: { users: all.slice((page - 1) * perPage, page * perPage) }, error: null }
      }),
      updateUserById: vi.fn(async (id: string, attrs: Row) => {
        calls.push({ table: 'auth.admin.updateUserById', op: 'update', payload: { id, ...attrs }, filters: [] })
        const injected = opts.failOn?.({
          table: 'auth.admin.updateUserById',
          op: 'update',
          payload: { id, ...attrs },
          filters: [],
        })
        if (injected) return { data: null, error: injected }
        return { data: { user: { id, ...attrs } }, error: null }
      }),
      getUserById: vi.fn(async (id: string) => {
        const user = (opts.authUsers ?? []).find((u) => u.id === id) ?? null
        return { data: { user }, error: null }
      }),
      deleteUser: vi.fn(async (id: string) => {
        calls.push({ table: 'auth.admin.deleteUser', op: 'delete', payload: { id }, filters: [] })
        const injected = opts.failOn?.({
          table: 'auth.admin.deleteUser',
          op: 'delete',
          payload: { id },
          filters: [],
        })
        if (injected) return { data: null, error: injected }
        opts.authUsers = (opts.authUsers ?? []).filter((u) => u.id !== id)
        return { data: null, error: null }
      }),
    },
  }

  const client = {
    from,
    auth,
    rpc: vi.fn(async (name: string, params?: Row) => {
      calls.push({ table: `rpc:${name}`, op: 'select', payload: params, filters: [] })
      const impl = opts.rpc?.[name]
      if (!impl) return { data: null, error: null }
      const out = impl(params)
      if (out && typeof out === 'object' && ('error' in out || 'data' in out)) {
        return { data: out.data ?? null, error: out.error ?? null }
      }
      return { data: out ?? null, error: null }
    }),
  }

  return {
    client,
    calls,
    tables,
    lastCall: (t: string) => [...calls].reverse().find((c) => c.table === t),
    callsOn: (t: string) => calls.filter((c) => c.table === t),
  }
}

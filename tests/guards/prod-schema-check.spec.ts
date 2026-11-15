/**
 * `scripts/check-prod-schema.mjs` 的完整单测 —— 解析 + 探测 + 退出码。
 *
 * 为什么必须有：这个脚本是「生产库结构与代码不同步」的唯一机械防线。
 * 它自己算错（漏解析某张表 / 把注释里的表当成真的 / 对着测试库报生产库安全）
 * 就等于没有防线，而它的失败是**静默的绿** —— 最危险的一种。
 *
 * ⚠️ 第十一轮独立评审指出：原版只测了 `parseSchema`，
 * `probe()` / `loadEnv()` / 退出码 / 主循环**全在测试之外**，
 * 而「404 PGRST205 → 判缺表 → exit 1」正是这次生产事故唯一依赖的判定链。
 * 改坏了没有任何用例会红 → 等于防线是纸做的。下面把这条链补齐。
 */
import { describe, it, expect } from 'vitest'
// @ts-expect-error 脚本是 .mjs，没有类型声明
import {
  parseSchema,
  dedupeColumns,
  stripSqlComments,
  loadEnv,
  refFromUrl,
  assertProdTarget,
  classify,
  probe,
  runCheck,
} from '../../scripts/check-prod-schema.mjs'

const PROD_URL = 'https://vbamprkcwrpsazkyknjq.supabase.co'
const TEST_URL = 'https://gkrugenqmbimpzkkriml.supabase.co'
const ANON = 'anon-key-fake'

/** 造一个可控的 probe：按 table/column 返回预设结果 */
function fakeProbe(map) {
  return async (_url, _anon, table, column) => {
    const k = column === '*' ? table : `${table}.${column}`
    if (k in map) return map[k]
    // 默认：表存在、列存在
    return { ok: true }
  }
}

const quietLogger = { log() {}, error() {} }

/** 造一个最小的 schema.sql 内容 */
const SMALL_SQL = `
create table if not exists public.users (
  id uuid primary key,
  name text
);
create table if not exists public.blood_pressures (
  id uuid primary key
);
alter table public.blood_pressures add column if not exists pulse int;
`

function envFile(url = PROD_URL, anon = ANON) {
  return `VITE_SUPABASE_URL=${url}\nVITE_SUPABASE_ANON_KEY=${anon}\n`
}

function makeReadFile(files) {
  return (f) => {
    if (f in files) return files[f]
    throw new Error('ENOENT: ' + f)
  }
}

describe('生产库结构检查 · schema.sql 解析', () => {
  it('解析出 create table if not exists 声明的表', () => {
    const sql = `
create table if not exists public.users (
  id uuid primary key,
  name text
);
create table if not exists public.patients (
  id uuid primary key
);
`
    const { tables } = parseSchema(sql)
    expect(tables).toEqual(['users', 'patients'])
  })

  it('解析出 add column if not exists 声明的列', () => {
    const sql = `
alter table public.blood_pressures add column if not exists pulse int;
alter table public.sessions add column if not exists doctor_uf numeric;
`
    const { columns } = parseSchema(sql)
    const keys = columns.map((c) => `${c.table}.${c.column}`)
    expect(keys).toContain('blood_pressures.pulse')
    expect(keys).toContain('sessions.doctor_uf')
  })

  it('解析出建表语句内部的列（表存在但列不全也要能查出来）', () => {
    const sql = `
create table if not exists public.patient_change_logs (
  id uuid primary key,
  patient_id uuid not null,
  old_value numeric,
  new_value numeric
);
`
    const { columns } = parseSchema(sql)
    const keys = columns.map((c) => `${c.table}.${c.column}`)
    expect(keys).toContain('patient_change_logs.old_value')
    expect(keys).toContain('patient_change_logs.new_value')
    expect(keys.some((k) => k.endsWith('.primary'))).toBe(false)
    expect(keys.some((k) => k.endsWith('.constraint'))).toBe(false)
  })

  it('大小写不敏感（CREATE TABLE IF NOT EXISTS 也要认）', () => {
    const sql = `CREATE TABLE IF NOT EXISTS public.admins (id uuid primary key);`
    const { tables } = parseSchema(sql)
    expect(tables).toContain('admins')
  })

  /**
   * 评审问题③：`parseSchema` 不剥注释，注释掉的建表语句被当真。
   * 后果：报出「幽灵表」→ 明明库是对的却 exit 1（假红），
   * 或者反向 —— 注释里的表掩盖了真正缺失的表。
   */
  it('剥掉 SQL 注释：注释里的 create table / add column 不能当真（评审问题③）', () => {
    const sql = `
-- create table if not exists public.disabled_feature (id uuid);
/* create table if not exists public.another_ghost (
     id uuid
   ); */
create table if not exists public.users (
  id uuid primary key,
  -- nickname text,
  name text
);
-- alter table public.users add column if not exists nickname text;
`
    const { tables, columns } = parseSchema(sql)
    expect(tables).toEqual(['users'])
    const keys = columns.map((c) => `${c.table}.${c.column}`)
    // 注释掉的列不能出现
    expect(keys).not.toContain('users.nickname')
    // 真列要在
    expect(keys).toContain('users.name')
  })

  /**
   * 评审问题③续：建表收尾 `);` 的缩进不能影响列解析。
   * 实测（独立评审）：把 `);` 缩进成 `  );`（sqlfluff / prettier-plugin-sql 默认风格）后，
   * 可探测列从 84 静默掉到 5 —— 而「pulse 在列里」那条断言仍然全绿。
   */
  it('建表收尾缩进变化不能丢列（评审：84 列掉到 5 列的静默漏检）', () => {
    const makeSql = (indent) => `
create table if not exists public.demo (
  id uuid primary key,
  a text,
  b text,
  c text,
  d text
${indent});
`
    const flat = parseSchema(makeSql(''))
    const indented = parseSchema(makeSql('  '))
    const count = (r) => r.columns.filter((c) => c.table === 'demo').length
    expect(count(flat)).toBe(5) // id / a / b / c / d
    expect(count(indented)).toBe(count(flat)) // 缩进不能改变结果
  })

  it('真实 schema.sql 必须能解析出本轮依赖的两个结构', async () => {
    const { readFileSync } = await import('node:fs')
    const sql = readFileSync('supabase/schema.sql', 'utf8')
    const { tables, columns } = parseSchema(sql)
    const keys = columns.map((c) => `${c.table}.${c.column}`)
    expect(tables).toContain('patient_change_logs')
    expect(keys).toContain('blood_pressures.pulse')
  })

  it('真实 schema.sql 解析出的表/列数量不能大幅缩水（防静默漏检）', async () => {
    const { readFileSync } = await import('node:fs')
    const sql = readFileSync('supabase/schema.sql', 'utf8')
    const { tables, columns } = parseSchema(sql)
    // 当前是 13 张表 / 89 个列声明（去重后 84）
    // 这里卡下限而不是精确值：加表加列不该红，但漏解析一大片必须红
    expect(tables.length).toBeGreaterThanOrEqual(13)
    expect(dedupeColumns(columns).length).toBeGreaterThanOrEqual(84)
  })
})

describe('生产库结构检查 · 配置读取与目标校验', () => {
  it('loadEnv：.env.production 不存在时返回 error（评审问题①：绝不回退到 .env）', () => {
    const r = loadEnv('.env.production', () => false, makeReadFile({}))
    expect(r.error).toContain('.env.production')
    expect(r.url).toBeUndefined()
  })

  it('loadEnv：文件存在但缺 key 时报错', () => {
    const r = loadEnv('.env.production', () => true, makeReadFile({ '.env.production': 'FOO=1\n' }))
    expect(r.error).toContain('缺少')
  })

  it('loadEnv：正常读取 url 与 anon key', () => {
    const r = loadEnv('.env.production', () => true, makeReadFile({ '.env.production': envFile() }))
    expect(r.url).toBe(PROD_URL)
    expect(r.anon).toBe(ANON)
    expect(r.error).toBeUndefined()
  })

  it('refFromUrl：从 URL 取出 project ref', () => {
    expect(refFromUrl(PROD_URL)).toBe('vbamprkcwrpsazkyknjq')
    expect(refFromUrl('https://example.com')).toBe(null)
  })

  it('assertProdTarget：测试库 ref 必须被拒绝（评审问题①）', () => {
    const err = assertProdTarget(TEST_URL)
    expect(err).toContain('非生产库')
    expect(err).toContain('gkrugenqmbimpzkkriml')
  })

  it('assertProdTarget：未知 ref 也必须被拒绝', () => {
    const err = assertProdTarget('https://someotherref000000.supabase.co')
    expect(err).toContain('不一致')
  })

  it('assertProdTarget：生产库通过', () => {
    expect(assertProdTarget(PROD_URL)).toBe(null)
  })
})

describe('生产库结构检查 · 探测结果分类', () => {
  it('200 → ok', () => {
    expect(classify({ ok: true }, 'table')).toBe('ok')
  })

  it('404 PGRST205 → 缺表（这次事故的直接信号）', () => {
    expect(classify({ ok: false, status: 404, code: 'PGRST205' }, 'table')).toBe('missing-table')
  })

  it('42P01 → 缺表', () => {
    expect(classify({ ok: false, status: 400, code: '42P01' }, 'table')).toBe('missing-table')
  })

  it('400 42703 → 缺列（心率 pulse 那次就是这个）', () => {
    expect(classify({ ok: false, status: 400, code: '42703' }, 'column')).toBe('missing-column')
  })

  it('401/403 → unknown（不能当成结构 OK）', () => {
    expect(classify({ ok: false, status: 401, code: null }, 'table')).toBe('unknown')
    expect(classify({ ok: false, status: 403, code: null }, 'table')).toBe('unknown')
  })

  it('fetch 失败 / 超时 → unknown', () => {
    expect(classify({ ok: null, error: 'fetch failed' }, 'table')).toBe('unknown')
    expect(classify({ ok: null, timeout: true, error: '超时 8000ms' }, 'table')).toBe('unknown')
  })

  it('未知错误码 → unknown（不能猜成 OK）', () => {
    expect(classify({ ok: false, status: 500, code: 'XX000' }, 'table')).toBe('unknown')
  })
})

describe('生产库结构检查 · probe 超时（评审问题④）', () => {
  it('probe 带 AbortSignal 且真的会超时返回（不是无限等）', async () => {
    const origFetch = globalThis.fetch
    let sawSignal = false
    globalThis.fetch = (async (_url, init) => {
      sawSignal = Boolean(init && init.signal)
      // 模拟一个永不 resolve 的请求，但尊重 abort
      return await new Promise((_resolve, reject) => {
        if (init && init.signal) {
          init.signal.addEventListener('abort', () => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          })
        }
      })
    })
    try {
      const t0 = Date.now()
      // 注入 120ms 短超时：既快，又能真正区分「有超时」与「没超时」
      const r = await probe(PROD_URL, ANON, 'users', '*', 120)
      const dt = Date.now() - t0
      expect(sawSignal).toBe(true)
      expect(r.ok).toBe(null)
      expect(r.timeout).toBe(true)
      // 关键断言：必须在超时附近返回。
      // 若去掉 AbortController/setTimeout（变异 M-47），这个 Promise 永不 resolve，
      // 用例会挂在超时上失败 —— 而不是像原来那样「删了超时也照样绿」。
      expect(dt).toBeLessThan(3000)
      expect(dt).toBeGreaterThanOrEqual(100)
    } finally {
      globalThis.fetch = origFetch
    }
  }, 10000)

  it('runCheck 会把 probeTimeoutMs 透传给 probe', async () => {
    const seen = []
    const r = await runCheck({
      readFile: makeReadFile({ '.env.production': envFile(), 'supabase/schema.sql': SMALL_SQL }),
      exists: () => true,
      probeTimeoutMs: 4321,
      probeFn: async (_u, _a, _t, _c, timeoutMs) => {
        seen.push(timeoutMs)
        return { ok: true }
      },
      logger: quietLogger,
    })
    expect(r.code).toBe(0)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((v) => v === 4321)).toBe(true)
  })

  it('probe 正常 200 时返回 ok', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '' })
    try {
      const r = await probe(PROD_URL, ANON, 'users', '*')
      expect(r.ok).toBe(true)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('生产库结构检查 · 退出码（事故依赖的判定链）', () => {
  it('全部通过 → exit 0', async () => {
    const r = await runCheck({
      readFile: makeReadFile({ '.env.production': envFile(), 'supabase/schema.sql': SMALL_SQL }),
      exists: () => true,
      probeFn: fakeProbe({}),
      logger: quietLogger,
    })
    expect(r.code).toBe(0)
    expect(r.okCount).toBeGreaterThan(0)
  })

  /**
   * ⭐ 这是本次生产事故的判定链：缺表 → 必须 exit 1。
   * 原版脚本完全没有这条用例覆盖。
   */
  it('缺表（PGRST205）→ exit 1，并点名缺哪张表', async () => {
    const r = await runCheck({
      readFile: makeReadFile({ '.env.production': envFile(), 'supabase/schema.sql': SMALL_SQL }),
      exists: () => true,
      probeFn: fakeProbe({
        blood_pressures: { ok: false, status: 404, code: 'PGRST205' },
      }),
      logger: quietLogger,
    })
    expect(r.code).toBe(1)
    expect(r.missing.join('\n')).toContain('blood_pressures')
  })

  it('缺列（42703）→ exit 1，并点名缺哪个列', async () => {
    const r = await runCheck({
      readFile: makeReadFile({ '.env.production': envFile(), 'supabase/schema.sql': SMALL_SQL }),
      exists: () => true,
      probeFn: fakeProbe({
        'blood_pressures.pulse': { ok: false, status: 400, code: '42703' },
      }),
      logger: quietLogger,
    })
    expect(r.code).toBe(1)
    expect(r.missing.join('\n')).toContain('blood_pressures.pulse')
  })

  /**
   * ⭐ 评审问题②：anon key 无效 / 主机不可达时全部探测 401 或 fetch failed，
   * 原版把这些全归「无法判定」→ 仍打印 ✅ 且 exit 0。这是最危险的假绿。
   */
  it('全部探测 401 → exit 1（不许报 ✅，评审问题②）', async () => {
    const r = await runCheck({
      readFile: makeReadFile({ '.env.production': envFile(), 'supabase/schema.sql': SMALL_SQL }),
      exists: () => true,
      probeFn: async () => ({ ok: false, status: 401, code: null }),
      logger: quietLogger,
    })
    expect(r.code).toBe(1)
    // ⚠️ 这里不能只断言 code === 1：脚本有**两道**兜底（unknown 分支 + okCount===0），
    // 只关掉 unknown 分支时，okCount===0 仍会返回 1，用例就会「删了代码照样绿」（假绿）。
    // 必须断言「确实走了 unknown 分支并报了原因」，才能钉住这道防线。
    expect(r.unknown.length).toBeGreaterThan(0)
    expect(r.log.join('\n')).toContain('无法判定')
    expect(r.log.join('\n')).not.toContain('✅')
  })

  /**
   * ⭐ 单独钉住「unknown 分支」：部分表探测成功、部分无法判定时，
   * okCount > 0，所以 okCount===0 那道兜底不会触发 ——
   * 只有 unknown 分支本身生效才能 exit 1。这条用例才真正守住评审问题②。
   */
  it('部分成功 + 部分无法判定 → exit 1（okCount>0 时只能靠 unknown 分支兜住）', async () => {
    const r = await runCheck({
      readFile: makeReadFile({ '.env.production': envFile(), 'supabase/schema.sql': SMALL_SQL }),
      exists: () => true,
      probeFn: async (_u, _a, table, column) => {
        // users 表及其列正常，blood_pressures 全部 401
        if (table === 'blood_pressures') return { ok: false, status: 401, code: null }
        return { ok: true }
      },
      logger: quietLogger,
    })
    expect(r.okCount).toBeGreaterThan(0) // 前置条件：确实有成功的
    expect(r.unknown.length).toBeGreaterThan(0)
    expect(r.code).toBe(1)
    expect(r.log.join('\n')).toContain('无法判定')
    expect(r.log.join('\n')).not.toContain('✅')
  })

  it('全部 fetch 失败 → exit 1（不许报 ✅）', async () => {
    const r = await runCheck({
      readFile: makeReadFile({ '.env.production': envFile(), 'supabase/schema.sql': SMALL_SQL }),
      exists: () => true,
      probeFn: async () => ({ ok: null, error: 'fetch failed' }),
      logger: quietLogger,
    })
    expect(r.code).toBe(1)
    expect(r.unknown.length).toBeGreaterThan(0)
    expect(r.log.join('\n')).toContain('无法判定')
    expect(r.log.join('\n')).not.toContain('✅')
  })

  /**
   * ⭐ 评审问题①：.env.production 缺失时绝不能回退到 .env（测试库）后报「生产库一致」。
   */
  it('.env.production 缺失 → exit 1，且不检查任何库（评审问题①）', async () => {
    let probeCalled = false
    const r = await runCheck({
      readFile: makeReadFile({ 'supabase/schema.sql': SMALL_SQL }),
      exists: (f) => f !== '.env.production',
      probeFn: async () => {
        probeCalled = true
        return { ok: true }
      },
      logger: quietLogger,
    })
    expect(r.code).toBe(1)
    expect(probeCalled).toBe(false) // 关键：根本不该去探测
    expect(r.log.join('\n')).toContain('.env.production')
  })

  it('检查对象是测试库 → exit 1（评审问题①）', async () => {
    const r = await runCheck({
      readFile: makeReadFile({
        '.env.production': envFile(TEST_URL),
        'supabase/schema.sql': SMALL_SQL,
      }),
      exists: () => true,
      probeFn: fakeProbe({}),
      logger: quietLogger,
    })
    expect(r.code).toBe(1)
    expect(r.log.join('\n')).toContain('非生产库')
  })

  it('schema.sql 解析不出任何表 → exit 1（解析器坏了不能报一致）', async () => {
    const r = await runCheck({
      readFile: makeReadFile({
        '.env.production': envFile(),
        'supabase/schema.sql': '-- 空文件\n',
      }),
      exists: () => true,
      probeFn: fakeProbe({}),
      logger: quietLogger,
    })
    expect(r.code).toBe(1)
    expect(r.log.join('\n')).toContain('没从 schema.sql 解析出任何表')
  })

  it('读不到 schema.sql → exit 1', async () => {
    const r = await runCheck({
      readFile: makeReadFile({ '.env.production': envFile() }),
      exists: () => true,
      probeFn: fakeProbe({}),
      logger: quietLogger,
    })
    expect(r.code).toBe(1)
  })
})

describe('生产库结构检查 · 真实 schema.sql 端到端（离线 mock 探测）', () => {
  it('用真实 schema.sql + 全绿 mock probe → exit 0', async () => {
    const { readFileSync } = await import('node:fs')
    const sql = readFileSync('supabase/schema.sql', 'utf8')
    const r = await runCheck({
      readFile: makeReadFile({ '.env.production': envFile(), 'supabase/schema.sql': sql }),
      exists: () => true,
      probeFn: fakeProbe({}),
      logger: quietLogger,
    })
    expect(r.code).toBe(0)
    // 13 张表 + 84 列 = 97 项
    expect(r.okCount).toBe(97)
  })

  it('真实 schema.sql + 缺 patient_change_logs → exit 1（复现第十一轮事故）', async () => {
    const { readFileSync } = await import('node:fs')
    const sql = readFileSync('supabase/schema.sql', 'utf8')
    const r = await runCheck({
      readFile: makeReadFile({ '.env.production': envFile(), 'supabase/schema.sql': sql }),
      exists: () => true,
      probeFn: async (_u, _a, table, column) => {
        if (table === 'patient_change_logs') return { ok: false, status: 404, code: 'PGRST205' }
        if (column === 'pulse') return { ok: false, status: 400, code: '42703' }
        return { ok: true }
      },
      logger: quietLogger,
    })
    expect(r.code).toBe(1)
    const text = r.missing.join('\n')
    expect(text).toContain('patient_change_logs')
    expect(text).toContain('blood_pressures.pulse')
  })
})

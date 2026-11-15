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
  splitTopLevel,
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
  })

  /**
   * ⭐ 第十二轮独立评审·轻微-3：原来用 `keys.some(k => k.endsWith(".primary"))` 断言 ——
   * 那是**恒真**的：keys 是 `table.column` 形式，永远不可能以 `.primary` 结尾，
   * 无论解析器好坏都是 false。真正该覆盖的形状是「约束独占一行」
   * （真实 schema.sql 的 `rate_limits` 就是 `primary key (bucket, key, window_start)` 单起一行）。
   * 这里用精确等值，删掉 CONSTRAINT_KEYWORDS 过滤必然变红。
   */
  it('约束独占一行时不能被当成列（精确等值）', () => {
    const sql = `
create table if not exists public.rate_limits (
  bucket text not null,
  key text not null,
  window_start timestamptz not null,
  count int not null,
  primary key (bucket, key, window_start),
  constraint chk_count check (count >= 0),
  unique (bucket, window_start)
);
`
    const cols = parseSchema(sql).columns.map((c) => c.column)
    expect(cols).toEqual(['bucket', 'key', 'window_start', 'count'])
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

  /**
   * ⭐ 第十二轮独立评审 · 中级-1：
   * `stripSqlComments` 用 `replace(/--.*$/gm,'')` 会把**字符串字面量里的 `--`** 当注释，
   * 连行尾的 `)` 一起吞掉 → 括号失衡 → 表体吞掉下一个 create table → 幻影列 `create`。
   * 后果：合法 schema 被判「生产库缺列」，pre-push 假红中止推送。
   * 现在改成词法扫描（识别字符串 / 标识符 / dollar-quote / 注释）。
   */
  it('字符串字面量里的 -- 不能被当成注释（评审中级-1）', () => {
    const sql = `
create table if not exists public.users (
  id uuid primary key,
  name text check (name <> '--')
);
create table if not exists public.patients (
  id uuid primary key,
  name text
);
`
    const { tables, columns } = parseSchema(sql)
    expect(tables).toEqual(['users', 'patients'])
    const keys = columns.map((c) => `${c.table}.${c.column}`)
    expect(keys).toEqual(['users.id', 'users.name', 'patients.id', 'patients.name'])
    // 幻影列（括号失衡后的典型产物）
    expect(keys).not.toContain('users.create')
  })

  it('字符串字面量里的块注释符号与括号不能干扰解析（评审中级-1）', () => {
    const sql = `
create table if not exists public.t (
  id uuid primary key,
  note text default 'a /* b */ c',
  v text default ')',
  w text default '(',
  z int
);
`
    const { columns } = parseSchema(sql)
    const keys = columns.map((c) => `${c.table}.${c.column}`)
    expect(keys).toEqual(['t.id', 't.note', 't.v', 't.w', 't.z'])
  })

  /**
   * ⭐ 第十二轮独立评审 · 中级-2：
   * 标准 SQL 风格的多行外键续行会被逐行匹配当成列 `references` / `on` → 幻影列 → 假红。
   * 现在按**顶层逗号**切片段，整个 constraint 是一个片段。
   */
  it('多行外键续行不能当成列（评审中级-2）', () => {
    const sql = `
create table if not exists public.sessions (
  id uuid primary key,
  patient_id uuid not null,
  constraint fk_patient foreign key (patient_id)
    references public.patients(id)
    on delete cascade
);
`
    const { columns } = parseSchema(sql)
    const keys = columns.map((c) => `${c.table}.${c.column}`)
    expect(keys).toEqual(['sessions.id', 'sessions.patient_id'])
    expect(keys).not.toContain('sessions.references')
    expect(keys).not.toContain('sessions.on')
    expect(keys).not.toContain('sessions.constraint')
  })

  it('dollar-quoted 函数体（含内部注释）不能破坏后续建表解析', () => {
    const sql = `
create or replace function public.f()
returns trigger
as $$
begin
  -- 函数内注释
  insert into public.users (id) values (new.id);
  return new;
end;
$$;
create table if not exists public.after_fn (
  id uuid primary key,
  name text
);
`
    const { tables, columns } = parseSchema(sql)
    expect(tables).toEqual(['after_fn'])
    const keys = columns.map((c) => `${c.table}.${c.column}`)
    expect(keys).toEqual(['after_fn.id', 'after_fn.name'])
  })

  it('表级 unique / primary key 约束不算列', () => {
    const sql = `
create table if not exists public.pm (
  id uuid primary key,
  patient_id uuid not null,
  user_id uuid not null,
  unique (patient_id, user_id)
);
create table if not exists public.rl (
  bucket text not null,
  key text not null,
  count int not null default 0,
  primary key (bucket, key)
);
`
    const { columns } = parseSchema(sql)
    const keys = columns.map((c) => `${c.table}.${c.column}`)
    expect(keys).not.toContain('pm.unique')
    expect(keys).not.toContain('rl.primary')
    expect(keys).toContain('pm.patient_id')
    expect(keys).toContain('rl.bucket')
  })

  it('嵌套块注释', () => {
    const sql = `
/* outer /* inner */ still comment */
create table if not exists public.n1 (
  id uuid primary key
);
`
    const { tables, columns } = parseSchema(sql)
    expect(tables).toEqual(['n1'])
    expect(columns.map((c) => `${c.table}.${c.column}`)).toEqual(['n1.id'])
  })

  /**
   * ⭐ 第十二轮独立评审 · 中级-1 的**加强版**：
   * 只有**一个**字符串含 `--` 时，括号失衡恰好还能被后续 `);` 抵消（变异实测：44 条全绿）；
   * **两个**才会真的丢列。所以这里放两个 —— 这才钉得住「词法剥离」这一层。
   */
  it('多个字符串字面量各含 -- 时列不能丢（加强版，钉住词法剥离）', () => {
    const sql = `
create table if not exists public.t (
  a text check (a <> '--'),
  b text check (b <> '--'),
  c int
);
`
    const { columns } = parseSchema(sql)
    const keys = columns.map((c) => `${c.table}.${c.column}`)
    expect(keys).toEqual(['t.a', 't.b', 't.c'])
  })

  /**
   * ⭐ 第十二轮独立评审：dollar-quote 必须整块识别。
   * 函数体里的**动态 SQL 字符串**如果被当成真 SQL，会解析出「幻影表」——
   * 明明生产库没有这张表，脚本却去探测它，然后报「生产库缺表」（假红中止推送）。
   */
  it('dollar-quote 函数体里的动态 SQL 不能变成幻影表', () => {
    const sql = `
create or replace function public.f() returns void as $$
begin
  execute 'create table if not exists public.ghost (id int)';
end;
$$;
create table if not exists public.real_t (
  id uuid primary key
);
`
    const { tables } = parseSchema(sql)
    expect(tables).toEqual(['real_t'])
    expect(tables).not.toContain('ghost')
  })

  /**
   * 直接钉住 `splitTopLevel`：多行定义必须切成「一个片段」而不是「一行一个」。
   * （评审中级-2 的根因就是逐行匹配；这条用例直接压住切分器本身。）
   */
  it('splitTopLevel 按顶层逗号切分，多行定义不被拆散', () => {
    const body = `id uuid primary key,
patient_id uuid not null
  references public.patients(id)
  on delete cascade,
note text`
    const parts = splitTopLevel(body)
    expect(parts.length).toBe(3)
    expect(parts[0]).toContain('id')
    expect(parts[1]).toContain('references')
    expect(parts[2]).toContain('note')
  })

  it('splitTopLevel 不在括号或字符串内部切分', () => {
    const body = `a numeric check (a in (1, 2)), b text default 'x,y', c int`
    const parts = splitTopLevel(body)
    expect(parts.length).toBe(3)
    expect(parts[0]).toContain('check')
    expect(parts[1]).toContain('x,y')
    expect(parts[2]).toContain('c int')
  })
  /**
   * 真实 schema.sql 里没有幻影列（关键字被当成列名）。
   * 这是「解析器把 SQL 结构误读成列」的总兜底。
   */
  it('真实 schema.sql 解析结果不含任何幻影列', async () => {
    const { readFileSync } = await import('node:fs')
    const sql = readFileSync('supabase/schema.sql', 'utf8')
    const { columns } = parseSchema(sql)
    const bad = [
      'create', 'table', 'constraint', 'primary', 'unique', 'foreign', 'check',
      'references', 'on', 'as', 'begin', 'end', 'return', 'select', 'insert',
      'replace', 'function', 'trigger', 'if', 'then', 'else', 'declare',
      'language', 'security', 'using', 'with', 'not', 'default', 'generated',
    ]
    const phantoms = columns.filter((c) => bad.includes(c.column.toLowerCase()))
    expect(phantoms).toEqual([])
  })
  it('真实 schema.sql 必须能解析出本轮依赖的两个结构', async () => {
    const { readFileSync } = await import('node:fs')
    const sql = readFileSync('supabase/schema.sql', 'utf8')
    const { tables, columns } = parseSchema(sql)
    const keys = columns.map((c) => `${c.table}.${c.column}`)
    expect(tables).toContain('patient_change_logs')
    expect(keys).toContain('blood_pressures.pulse')
  })

  it('真实 schema.sql 解析出的表/列数量必须精确（轻微-5：>= 抓不到「少一列多一列」）', async () => {
    const { readFileSync } = await import('node:fs')
    const sql = readFileSync('supabase/schema.sql', 'utf8')
    const { tables, columns } = parseSchema(sql)
    // ⚠️ 第十二轮评审·轻微-5：原来写 `>= 13` / `>= 84`，于是「删一列加一列」（净数不变）
    // 全绿 —— 而这正是解析器回归最典型的形态。改成精确值。
    //
    // 加表/加列时这里会红，但那是**期望行为**：`schema-baseline.spec.ts` 的手写清单
    // 也要同步改，两处一起更新才说明结构变更是有意的。
    expect(tables.length).toBe(13)
    expect(dedupeColumns(columns).length).toBe(84)
    // 顺带钉住原始声明数（去重前 89，含 alter 的 5 个）
    expect(columns.length).toBe(89)
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
    expect(classify({ ok: true })).toBe('ok')
  })

  it('404 PGRST205 → 缺表（这次事故的直接信号）', () => {
    expect(classify({ ok: false, status: 404, code: 'PGRST205' })).toBe('missing-table')
  })

  it('42P01 → 缺表', () => {
    expect(classify({ ok: false, status: 400, code: '42P01' })).toBe('missing-table')
  })

  it('400 42703 → 缺列（心率 pulse 那次就是这个）', () => {
    expect(classify({ ok: false, status: 400, code: '42703' })).toBe('missing-column')
  })

  it('401/403 → unknown（不能当成结构 OK）', () => {
    expect(classify({ ok: false, status: 401, code: null })).toBe('unknown')
    expect(classify({ ok: false, status: 403, code: null })).toBe('unknown')
  })

  it('fetch 失败 / 超时 → unknown', () => {
    expect(classify({ ok: null, error: 'fetch failed' })).toBe('unknown')
    expect(classify({ ok: null, timeout: true, error: '超时 8000ms' })).toBe('unknown')
  })

  it('未知错误码 → unknown（不能猜成 OK）', () => {
    expect(classify({ ok: false, status: 500, code: 'XX000' })).toBe('unknown')
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
  it('用真实 schema.sql + 全绿 mock probe → exit 0，且探测项数量精确是 97', async () => {
    const { readFileSync } = await import('node:fs')
    const sql = readFileSync('supabase/schema.sql', 'utf8')
    // 收下 probe 实际被问了哪些 (table, column)，用来做**集合**断言
    const asked = []
    const r = await runCheck({
      readFile: makeReadFile({ '.env.production': envFile(), 'supabase/schema.sql': sql }),
      exists: () => true,
      probeFn: async (_u, _a, table, column) => {
        asked.push({ table, column })
        return { ok: true }
      },
      logger: quietLogger,
    })
    expect(r.code).toBe(0)

    // ⚠️ 第十二轮评审·中级-4：这里原来是**自指**的 ——
    // `expected` 由同一个 `parseSchema(sql)` 构造，等于断言 `f(x) == f(x)`，
    // 解析器少解析一张表时两边同时少、仍然相等；`okCount === tables.length + cols.length`
    // 和 `okCount === asked.length` 更是纯算术恒真。
    //
    // 改成**独立的魔数**：97 = 13 张表 + 84 个列。这个数字由
    // `tests/guards/schema-baseline.spec.ts` 的**手写清单**独立钉住（那边每表精确
    // 列出列名），所以这里写死 97 不会变成「改测试而不是信守卫」——
    // 结构真变了，baseline 那条会先红、提醒你两处一起更新。
    expect(asked.length).toBe(97)
    expect(r.okCount).toBe(97)
    // 再点名几个关键探测项，防止「97 个全问同一张表」这种畸形通过
    const askedKeys = asked.map((x) => `${x.table}.${x.column}`)
    expect(askedKeys).toContain('blood_pressures.*')
    expect(askedKeys).toContain('blood_pressures.pulse')
    expect(askedKeys).toContain('patient_change_logs.*')
    expect(askedKeys).toContain('patient_change_logs.old_value')
    expect(askedKeys).toContain('sessions.*')
    expect(askedKeys).toContain('sessions.doctor_uf')
    // 每张表都必须被探测到（不能漏表）
    expect(new Set(asked.map((x) => x.table)).size).toBe(13)
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

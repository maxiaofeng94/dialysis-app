import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
// @ts-expect-error 脚本是 .mjs，没有类型声明
import {
  findUnterminatedSql,
  splitTopLevel,
  parseSchema,
  dedupeColumns,
  ddlCensus,
  probe,
  classify,
  runCheck,
} from '../../scripts/check-prod-schema.mjs'

/** 生产库环境变量文本（供 runCheck 注入，避免依赖真实文件） */
function envText(): string {
  return 'VITE_SUPABASE_URL=https://vbamprkcwrpsazkyknjq.supabase.co\nVITE_SUPABASE_ANON_KEY=fake'
}

/**
 * 第十三轮自查发现的两条**假绿/假红**路径的回归用例。
 *
 * ① 未闭合引号 → 解析器静默丢列 → 生产库真缺那列也不会报（假绿）
 * ② probe 的列名不做 URL 编码 → 列名含 `&`/`#` 时探测对象错位
 */
describe('findUnterminatedSql：语法坏掉的 SQL 必须大声失败', () => {
  it('正常 SQL 没有问题', () => {
    const sql = `
create table if not exists public.a (
  id int,
  name text default 'ok',
  v text default ')'          -- 字符串里的右括号
);
create or replace function public.f() as $$
begin
  execute 'create table if not exists public.ghost (id int)';
end;
$$ language plpgsql;
`
    expect(findUnterminatedSql(sql)).toEqual([])
  })

  it('未闭合单引号必须报出来', () => {
    const sql = `create table if not exists public.a (
  name text default 'oops
);
create table if not exists public.b (id int);
`
    const problems = findUnterminatedSql(sql)
    // 未闭合引号会把后面的括号一起吞掉，所以可能同时报「缺少右括号」——
    // 只要点名了单引号问题就说明抓到了
    expect(problems.some((p) => p.includes('单引号'))).toBe(true)
  })

  it('未闭合双引号标识符必须报出来', () => {
    const problems = findUnterminatedSql(`create table if not exists public.a (id int, "bad text);`)
    expect(problems.some((p) => p.includes('双引号'))).toBe(true)
  })

  it('未闭合 dollar-quote 必须报出来', () => {
    const sql = `create or replace function public.f() as $$
begin
end;
`
    const problems = findUnterminatedSql(sql)
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain('dollar-quote')
  })

  it('带标签的 dollar-quote 能正确配对', () => {
    const sql = `create function f() as $body$ select 1; $body$ language sql;`
    expect(findUnterminatedSql(sql)).toEqual([])
  })

  it('未闭合块注释必须报出来', () => {
    expect(findUnterminatedSql('/* 没有结束').length).toBe(1)
  })

  it('字符串里的 -- 和 /* 不算注释（不能被误报成未闭合）', () => {
    const sql = `create table if not exists public.a (
  a text default '--',
  b text default '/*',
  c text default '*/'
);`
    expect(findUnterminatedSql(sql)).toEqual([])
  })

  // ⭐ 第十二轮评审·轻微-2：Postgres 默认 standard_conforming_strings = on，
  // 普通字符串里 \ 是**普通字符**，只有 E'...' 才启用反斜杠转义。
  it("普通字符串里的反斜杠不是转义：default 'C:\\' 是合法 SQL（不能假红）", () => {
    const sql = `create table if not exists public.a (p text default 'C:\\');`
    expect(findUnterminatedSql(sql)).toEqual([])
  })

  it("E'...' 里反斜杠是转义：E'it\\'s fine' 不应报未闭合", () => {
    const sql = `create table if not exists public.a (v text default E'it\\'s fine');`
    expect(findUnterminatedSql(sql)).toEqual([])
  })

  it("E 字符串后面的列不能被吞掉（假绿）", () => {
    const sql = `create table if not exists public.lab (id uuid, note text default E'it\\'s fine', potassium numeric(4,1), calcium numeric(4,2));`
    const { columns } = parseSchema(sql)
    const cols = dedupeColumns(columns).map((c) => c.column)
    expect(cols).toEqual(['id', 'note', 'potassium', 'calcium'])
  })
})

describe('未闭合 SQL：findUnterminatedSql 必须能提前发现', () => {
  it('未闭合单引号会被 findUnterminatedSql 抓出（runCheck 据此拒绝出结论）', () => {
    const sql = `create table if not exists public.a (
  id int,
  name text default 'oops
);
create table if not exists public.b (id int);`
    // 词法扫描器会把未闭合引号后面的内容都当成字符串内容，
    // 于是后续表/列解析结果不可信 —— 必须由 findUnterminatedSql 拦下来。
    expect(findUnterminatedSql(sql).length).toBeGreaterThan(0)
  })

  it('真实 schema.sql 不应有未闭合语法（否则防线本身有问题）', async () => {
    const { readFileSync } = await import('node:fs')
    const sql = readFileSync('supabase/schema.sql', 'utf8')
    expect(findUnterminatedSql(sql)).toEqual([])
  })
})

describe('probe 的列名必须 URL 编码（防探测对象错位）', () => {
  const PROD_URL = 'https://vbamprkcwrpsazkyknjq.supabase.co'
  const ANON = 'anon'

  function capture(responder) {
    const calls = []
    const orig = globalThis.fetch
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      return responder()
    }
    return { calls, restore: () => { globalThis.fetch = orig } }
  }

  it('普通列名不变（不引入多余转义）', async () => {
    const { calls, restore } = capture(() => ({ ok: true }))
    try {
      await probe(PROD_URL, ANON, 'blood_pressures', 'pulse', 1000)
      expect(calls[0]).toBe(`${PROD_URL}/rest/v1/blood_pressures?select=pulse&limit=0`)
    } finally {
      restore()
    }
  })

  it('含 & 的列名必须被编码，不能变成两个查询参数', async () => {
    const { calls, restore } = capture(() => ({ ok: true }))
    try {
      await probe(PROD_URL, ANON, 'sessions', 'a&b', 1000)
      // 若未编码，URL 会变成 select=a&b&limit=0（b 成了独立参数）
      expect(calls[0]).toContain('select=a%26b')
      expect(calls[0]).not.toContain('select=a&b')
    } finally {
      restore()
    }
  })

  it('表探测的 * 编码后仍是 *（不能变成 %2A）', async () => {
    const { calls, restore } = capture(() => ({ ok: true }))
    try {
      await probe(PROD_URL, ANON, 'users', '*', 1000)
      expect(calls[0]).toBe(`${PROD_URL}/rest/v1/users?select=*&limit=0`)
    } finally {
      restore()
    }
  })
})

/**
 * 第十二轮评审·严重-2：`probe()` 的**错误分支零覆盖** ——
 * 全仓库没有任何一条用例把真实非 200 body 喂进真实 `probe`。
 * `classify` 的用例是直接构造对象喂 `classify`，**绕过了 `probe` 的 code 解析**。
 * 后果：`if (r.ok)` 可以被改成 `if (r.ok || r.status === 404)`（= 第十一轮事故本身：
 * 表不存在却报「结构一致」）而**全绿**。
 *
 * 这里补「真实 probe + 桩 fetch」的用例，把 404/PGRST205、400/42703、401 三条错误
 * 分支都钉住。
 */
/**
 * 第十二轮评审·中级：`findUnterminatedSql` 原来只查引号 / dollar-quote / 块注释，
 * **不查括号配平** —— 而 `parseSchema` 靠括号配平截取建表体。
 *
 * 评审实测的完整假绿链（把 `admins` 的 `(` 改成 `((`）：
 *   parseSchema → 13 表 / 80 列（基线 84，静默少 4 列）
 *   语法自检 → 空数组（放行，因为它原来不查括号）
 *   普查 → found=13 parsed=13 missing=0（只数表，放行）
 *   runCheck → code=0，报「✅ 一致（93 项探测全部通过）」
 *   → 生产库真缺 admins 那 4 列也不报
 *
 * 这里把括号配平钉住，同时钉住「字符串 / dollar-quote / 双引号标识符里的括号
 * 不算数」（否则正常 SQL 会被误报）。
 */
describe('findUnterminatedSql 必须检查括号配平（中级）', () => {
  it('真实 schema.sql 不能误报', () => {
    const sql = readFileSync('supabase/schema.sql', 'utf8')
    expect(findUnterminatedSql(sql)).toEqual([])
  })

  it('缺右括号必须报出来（评审实测的假绿形态：建表体被截断）', () => {
    const problems = findUnterminatedSql('create table if not exists public.t (id int, b text;')
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain('右括号')
  })

  it('多一个左括号必须报出来（真实 schema.sql 上变异 admins 表）', () => {
    const sql = readFileSync('supabase/schema.sql', 'utf8')
    const bad = sql.replace(/(create table if not exists public\.admins \()/, '$1(')
    expect(bad).not.toBe(sql)
    const problems = findUnterminatedSql(bad)
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain('右括号')
  })

  it('多余的右括号必须报出来', () => {
    const problems = findUnterminatedSql('create table if not exists public.t (id int));')
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain('多余')
  })

  it('字符串里的括号不能算（否则正常 SQL 会被误报）', () => {
    expect(findUnterminatedSql("create table if not exists public.t (v text default ')');")).toEqual([])
    expect(findUnterminatedSql("create table if not exists public.t (v text default '(');")).toEqual([])
  })

  it('dollar-quote 里的括号不能算', () => {
    // 写成单行调用：script-signature 守卫的 countArgs 不认 dollar-quote，
    // 多行 + `$$` 里的括号会让它误算成 2 个实参（那条守卫防的是「形参删了测试还在传」，
    // 与这里的语义无关，没必要去改它）。
    const fnSql = 'create or replace function public.f() as $$ begin perform (1); end; $$ language plpgsql;'
    expect(findUnterminatedSql(fnSql)).toEqual([])
    expect(findUnterminatedSql('do $body$ begin perform (1); end $body$;')).toEqual([])
  })

  it('双引号标识符里的括号不能算', () => {
    expect(findUnterminatedSql('create table if not exists public.t ("a(b" int);')).toEqual([])
  })

  it('括号不配平时 runCheck 必须 exit 1 且一个探测都不发（不能报「一致」）', async () => {
    const asked = []
    const sql = readFileSync('supabase/schema.sql', 'utf8')
    const bad = sql.replace(/(create table if not exists public\.admins \()/, '$1(')
    const r = await runCheck({
      envFile: '/x/.env.production',
      sqlFile: '/x/schema.sql',
      exists: () => true,
      readFile: (f) => (f === '/x/schema.sql' ? bad : envText()),
      probeFn: async (...args) => {
        asked.push(args)
        return { ok: true }
      },
      logger: { log() {}, error() {} },
    })
    expect(r.code).toBe(1)
    expect(asked).toEqual([])
    expect(r.log.join('\n')).toContain('语法有问题')
  })
})
describe('probe 的错误分支（严重-2：真实 probe + 桩 fetch）', () => {
  const PROD_URL = 'https://vbamprkcwrpsazkyknjq.supabase.co'
  const ANON = 'anon'

  function stubFetch(responder) {
    const orig = globalThis.fetch
    globalThis.fetch = async () => responder()
    return () => { globalThis.fetch = orig }
  }

  it('404 + PGRST205（表不存在）必须返回 ok:false 且带上 code', async () => {
    const restore = stubFetch(() => ({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ code: 'PGRST205', message: 'relation does not exist' }),
    }))
    try {
      const r = await probe(PROD_URL, ANON, 'ghost_table', '*', 1000)
      // 关键：绝不能被当成「存在」
      expect(r.ok).toBe(false)
      expect(r.status).toBe(404)
      expect(r.code).toBe('PGRST205')
    } finally {
      restore()
    }
  })

  it('400 + 42703（列不存在）必须返回 ok:false 且带上 code', async () => {
    const restore = stubFetch(() => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ code: '42703', message: 'column does not exist' }),
    }))
    try {
      const r = await probe(PROD_URL, ANON, 'blood_pressures', 'ghost_col', 1000)
      expect(r.ok).toBe(false)
      expect(r.status).toBe(400)
      expect(r.code).toBe('42703')
    } finally {
      restore()
    }
  })

  it('401 未授权必须返回 ok:false（不能被当成存在）', async () => {
    const restore = stubFetch(() => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: 'JWT expired' }),
    }))
    try {
      const r = await probe(PROD_URL, ANON, 'users', '*', 1000)
      expect(r.ok).toBe(false)
      expect(r.status).toBe(401)
    } finally {
      restore()
    }
  })

  it('非 JSON body 不能让 probe 抛错（code 为 null）', async () => {
    const restore = stubFetch(() => ({
      ok: false,
      status: 500,
      text: async () => '<html>Internal Server Error</html>',
    }))
    try {
      const r = await probe(PROD_URL, ANON, 'users', '*', 1000)
      expect(r.ok).toBe(false)
      expect(r.code).toBe(null)
    } finally {
      restore()
    }
  })

  it('404 必须被 classify 判成 missing-table（而不是 ok）', async () => {
    const restore = stubFetch(() => ({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ code: 'PGRST205' }),
    }))
    try {
      const r = await probe(PROD_URL, ANON, 'ghost_table', '*', 1000)
      expect(classify(r)).toBe('missing-table')
    } finally {
      restore()
    }
  })

  it('400/42703 必须被 classify 判成 missing-column（而不是 ok）', async () => {
    const restore = stubFetch(() => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ code: '42703' }),
    }))
    try {
      const r = await probe(PROD_URL, ANON, 'x', 'y', 1000)
      expect(classify(r)).toBe('missing-column')
    } finally {
      restore()
    }
  })
})
describe('runCheck 必须在解析前拦截未闭合 SQL（否则会拿残缺结果报「一致」）', () => {
  const PROD_URL = 'https://vbamprkcwrpsazkyknjq.supabase.co'
  const ANON = 'anon'

  /** 造一个「所有探测都成功」的 probe：结构解析错也照样全绿 */
  const allOk = async () => ({ ok: true })

  it('SQL 有未闭合引号 → exit 1，且不发出任何探测', async () => {
    const badSql = `create table if not exists public.a (
  id int,
  name text default 'oops
);`
    const asked = []
    const r = await runCheck({
      envFile: '.env.production',
      readFile: (f) =>
        f.endsWith('.sql')
          ? badSql
          : `VITE_SUPABASE_URL=${PROD_URL}\nVITE_SUPABASE_ANON_KEY=${ANON}\n`,
      exists: () => true,
      probeFn: async (_u, _a, table, column) => {
        asked.push(table + '.' + column)
        return allOk()
      },
      logger: { log() {}, error() {} },
    })
    expect(r.code).toBe(1)
    // 关键：不能先去探测（残缺解析结果不可信）
    expect(asked).toEqual([])
    expect(r.log.join('\n')).toContain('语法有问题')
  })

  it('SQL 语法正常时照常探测并 exit 0', async () => {
    const goodSql = `create table if not exists public.a (id int);`
    const asked = []
    const r = await runCheck({
      envFile: '.env.production',
      readFile: (f) =>
        f.endsWith('.sql')
          ? goodSql
          : `VITE_SUPABASE_URL=${PROD_URL}\nVITE_SUPABASE_ANON_KEY=${ANON}\n`,
      exists: () => true,
      probeFn: async (_u, _a, table, column) => {
        asked.push(table + '.' + column)
        return allOk()
      },
      logger: { log() {}, error() {} },
    })
    expect(r.code).toBe(0)
    expect(asked.length).toBeGreaterThan(0)
  })
})

describe('splitTopLevel：字符串/标识符/dollar-quote 里的逗号不能切（轻微-3）', () => {
  it('普通列定义按顶层逗号切分', () => {
    expect(splitTopLevel('id uuid, name text, value numeric(4,1)')).toEqual([
      'id uuid',
      ' name text',
      ' value numeric(4,1)',
    ])
  })

  it('双引号标识符里的逗号不切："a,b" int 是一段', () => {
    // 未跳过双引号时会切成 ["\"a", "b\" int"] 两段 → 幻影列 "a"
    const parts = splitTopLevel('"a,b" int, c int')
    expect(parts).toEqual(['"a,b" int', ' c int'])
  })

  it("dollar-quote 里的逗号不切：$$a,b$$ 是一段", () => {
    const parts = splitTopLevel('$$a,b$$ int, c int')
    expect(parts).toEqual(['$$a,b$$ int', ' c int'])
  })

  it("带标签的 dollar-quote 里的逗号不切", () => {
    const parts = splitTopLevel('$body$a,b$body$ int, c int')
    expect(parts).toEqual(['$body$a,b$body$ int', ' c int'])
  })

  it("单引号字符串里的逗号不切（去掉该分支会把 'a,b' 切成两段）", () => {
    const SQ = String.fromCharCode(39)
    const parts = splitTopLevel('v text default ' + SQ + 'a,b' + SQ + ', c int')
    expect(parts).toEqual(['v text default ' + SQ + 'a,b' + SQ, ' c int'])
  })

  it("单引号字符串里的右括号不参与配平", () => {
    const SQ = String.fromCharCode(39)
    const parts = splitTopLevel('v text default ' + SQ + ')' + SQ + ', c int')
    // 若字符串里的 ) 参与配平，depth 变负，后面的逗号就不会切分
    expect(parts).toEqual(['v text default ' + SQ + ')' + SQ, ' c int'])
  })
  it("双引号标识符里的逗号不会造出幻影列（端到端）", () => {
    const sql = `create table if not exists public.t ("a,b" int, c int);`
    const { columns } = parseSchema(sql)
    expect(dedupeColumns(columns).map((x) => x.column)).toEqual(['a,b', 'c'])
  })
})

/**
 * 第十二轮评审·严重-1：`parseSchema` 是「尽力解析」，遇到它不认识的 DDL 拼写就
 * **静默跳过**。后果是探测项变少 → 生产库真缺那张表也不报（假绿，正是第十一轮事故
 * 的形态）；而 `schema-baseline.spec.ts` 的期望值也来自同一个 `parseSchema`，
 * 两边同时少仍然相等。
 *
 * 修法有两条，这里都钉住：
 *   ① `parseSchema` 的 DDL 正则放宽到支持 pg_dump 等合法写法（下面 11 个变体）
 *   ② `ddlCensus` 用一条**不依赖 parseSchema 的普查**兜底：文件里有几条
 *      `create table`，就必须解析出几张表，对不上就报错
 */
describe('parseSchema 必须认全合法的 DDL 拼写（严重-1）', () => {
  const BASE = `
create table if not exists public.patients (
  id uuid primary key,
  name text not null
);
alter table public.patients add column if not exists nickname text;
`

  it('基线：1 张表 3 个列', () => {
    const { tables, columns } = parseSchema(BASE)
    expect(tables).toEqual(['patients'])
    expect(dedupeColumns(columns).map((c) => c.column).sort()).toEqual(['id', 'name', 'nickname'])
  })

  it('pg_dump 风格：create table if not exists "public"."x"', () => {
    const sql = BASE + '\ncreate table if not exists "public"."patient_notes" (id uuid, note text);'
    const { tables, columns } = parseSchema(sql)
    expect(tables).toContain('patient_notes')
    expect(dedupeColumns(columns).map((c) => c.column)).toContain('note')
  })

  it('alter table if exists … add column if not exists', () => {
    const sql = BASE + '\nalter table if exists public.patients add column if not exists zz_b text;'
    const cols = dedupeColumns(parseSchema(sql).columns).map((c) => c.column)
    expect(cols).toContain('zz_b')
  })

  it('alter table only … add column', () => {
    const sql = BASE + '\nalter table only public.patients add column if not exists zz_c text;'
    const cols = dedupeColumns(parseSchema(sql).columns).map((c) => c.column)
    expect(cols).toContain('zz_c')
  })

  it('省略 if not exists：create table public.x', () => {
    const sql = BASE + '\ncreate table public.patient_flags (id uuid, flag text);'
    const { tables } = parseSchema(sql)
    expect(tables).toContain('patient_flags')
  })

  it('省略 schema：create table x', () => {
    const sql = BASE + '\ncreate table patient_tags (id uuid, tag text);'
    const { tables } = parseSchema(sql)
    expect(tables).toContain('patient_tags')
  })

  it('create unlogged table / temp table', () => {
    const sql = BASE + '\ncreate unlogged table public.tmp_x (id int);\ncreate temp table tmp_y (id int);'
    const { tables } = parseSchema(sql)
    expect(tables).toContain('tmp_x')
    expect(tables).toContain('tmp_y')
  })

  it('add column (a, b) 一次加多列', () => {
    const sql = BASE + '\nalter table public.patients add column if not exists (zz_d text, zz_e text);'
    const cols = dedupeColumns(parseSchema(sql).columns).map((c) => c.column)
    expect(cols).toContain('zz_d')
    expect(cols).toContain('zz_e')
  })

  it('add 省略 column 关键字', () => {
    const sql = BASE + '\nalter table public.patients add zz_f int;'
    const cols = dedupeColumns(parseSchema(sql).columns).map((c) => c.column)
    expect(cols).toContain('zz_f')
  })

  it('add constraint 不能造出幻影列（真实 schema.sql 里就有这句）', () => {
    const sql =
      BASE +
      '\nalter table public.patients drop constraint if exists patients_pkey;' +
      '\nalter table public.patients add constraint patients_pkey primary key (id);'
    const cols = dedupeColumns(parseSchema(sql).columns).map((c) => c.column)
    expect(cols).not.toContain('constraint')
    expect(cols.sort()).toEqual(['id', 'name', 'nickname'])
  })
})

/**
 * 第十二轮评审·轻微（预防性）：两个词法边界的加固。
 * 当前 `schema.sql` 里 `E'` 出现 0 次、双引号 DDL 标识符 0 处，所以这两条
 * 不是修真实 bug，而是把「以后有人这么写」的坑先堵上。
 */
/**
 * 第十四轮自查发现的两个真实缺陷（都不是评审提的，是我按问 4「如果你是审查者」
 * 自己攻出来的）：
 *
 * ① `alter table t add column a int, add column b int;`（一条语句多个 add，PG 合法）
 *    原来只解析出 a，b **静默丢失** → 探测项变少 → 生产库真缺 b 也不报（假绿）。
 *    根因：正则把 `add ...` 吃进匹配里，全局 exec 从 a 之后继续找，而下一个 add
 *    前面没有 `alter table` 前缀就匹配不上。改成两阶段（先定位语句头，再扫语句体内的 add）。
 *
 * ② `ddlCensus` 的宽正则没遮字符串字面量 → `note text default 'create table x'`
 *    会被多数一次 → `found=2 parsed=1 missing=[...]` → **假红**（合法 SQL 被拦下推送）。
 *    修法：新增 `blankSqlStrings`（连字符串一起遮），普查专用。
 */
describe('alter table 多 add 与字符串字面量（第十四轮自查）', () => {
  it('一条 alter 语句里的多个 add 必须全部解析出来（不能只认第一个）', () => {
    const sql = 'alter table public.t add column a int, add column b int;'
    const cols = dedupeColumns(parseSchema(sql).columns).map((c) => c.table + '.' + c.column)
    // 只解析出 ['t.a'] 就是假绿：生产库缺 b 也发现不了
    expect(cols.sort()).toEqual(['t.a', 't.b'])
  })

  it('多个 alter 语句 + create table 混排都要解析对', () => {
    const sql = 'alter table public.a add column x int; alter table public.b add column y int; create table public.c (z int);'
    const cols = dedupeColumns(parseSchema(sql).columns).map((c) => c.table + '.' + c.column)
    expect(cols.sort()).toEqual(['a.x', 'b.y', 'c.z'])
  })

  it('add constraint 不能造出幻影列（多 add 形态下也要排除）', () => {
    const sql = 'alter table public.t add column a int, add constraint t_pkey primary key (a);'
    const cols = dedupeColumns(parseSchema(sql).columns).map((c) => c.table + '.' + c.column)
    expect(cols).toEqual(['t.a'])
  })

  it('字符串字面量里的 create table 不能被普查多数一次（否则假红）', () => {
    const sql = "create table public.t (note text default 'create table x');"
    const parsed = parseSchema(sql)
    const c = ddlCensus(sql, parsed.tables)
    // 未遮字符串时 found 会是 2 → missing 非空 → runCheck exit 1（合法 SQL 被拦）
    expect(c.found).toBe(1)
    expect(c.missing).toEqual([])
  })

  it('E-string 里的 create table 也不能被多数一次', () => {
    const sql = "create table public.t (note text default E'create table x\\'');"
    const parsed = parseSchema(sql)
    const c = ddlCensus(sql, parsed.tables)
    expect(c.found).toBe(1)
    expect(c.missing).toEqual([])
  })

  it('字符串含 create table 时 runCheck 必须 exit 0（不能假红）', async () => {
    const asked: unknown[] = []
    const sql = "create table if not exists public.users (\n  id uuid primary key,\n  note text default 'create table x'\n);\n"
    const r = await runCheck({
      envFile: '/x/.env.production',
      sqlFile: '/x/schema.sql',
      exists: () => true,
      readFile: (f: string) =>
        f === '/x/schema.sql'
          ? sql
          : 'VITE_SUPABASE_URL=https://vbamprkcwrpsazkyknjq.supabase.co\nVITE_SUPABASE_ANON_KEY=fake',
      probeFn: async (...args: unknown[]) => {
        asked.push(args)
        return { ok: true }
      },
      logger: { log() {}, error() {} },
    })
    expect(r.code).toBe(0)
    expect(asked.length).toBeGreaterThan(0)
  })

  it('字符串里的分号不能截断 alter 语句体（否则后面的 add 丢失 → 假绿）', () => {
    // ⚠️ 这条是变异 M6 逼出来的：若用 `clean`（保留字符串内容）找语句结束分号，
    // `default 'a;b'` 里的分号会被当成语句结束 → 语句体提前截断 → 后面真正的
    // `add column` 全部丢失（假绿：探测项变少，生产库真缺也不报）。
    const sql =
      "alter table public.t add column note text default 'x;y', add column second_col int;"
    const cols = dedupeColumns(parseSchema(sql).columns).map((c) => c.table + '.' + c.column)
    // 截断时只会解析出 t.note，second_col 静默丢失
    expect(cols.sort()).toEqual(['t.note', 't.second_col'])
  })
  it('add column 括号组里的类型括号不能截断（嵌套括号 → 后面的列静默丢失）', () => {
    // ⚠️ 这条是第十三轮补充评审交接的线索，第十四轮复核确认成立：
    // 旧实现用 `(\([^)]*\))` 匹配括号组，`[^)]*` 在 `numeric(4,1)` 的第一个 `)` 处停下
    // → 只解析出 a，b 静默丢失（假绿：探测项变少，生产库真缺 b 也不报）。
    // 真实 schema.sql 里没有 `add column (` 这种形态，但这是**合法 PG 语法**。
    const sql = 'alter table public.t add column (a numeric(4,1), b text);'
    const cols = dedupeColumns(parseSchema(sql).columns).map((c) => c.table + '.' + c.column)
    expect(cols.sort()).toEqual(['t.a', 't.b'])
  })

  it('add 括号组里更长的嵌套类型（varchar(10)）也要解析全', () => {
    const sql = 'alter table public.t add (a numeric(6,2), b varchar(10), c int);'
    const cols = dedupeColumns(parseSchema(sql).columns).map((c) => c.table + '.' + c.column)
    expect(cols.sort()).toEqual(['t.a', 't.b', 't.c'])
  })

  it('表探测成功但列探测报缺表（矛盾态）必须 exit 1，不能静默跳过', async () => {
    // ⚠️ 第十四轮自查（线索来自 rev13b-src 交接）。旧实现里列探测遇到
    // `missing-table` 走 `continue` —— 于是「表 select=* 返回 200（存在）+ 列探测全 PGRST205」
    // 这个自相矛盾的状态下，84 个列探测全部消失、okCount 只剩 13，
    // 脚本照样打印「✅ 生产库结构与 schema.sql 一致」并 exit 0（假绿）。
    // 矛盾态从哪来（第十四轮评审 rev14-src 在测试库实测后纠正了我原来的说法）：
    // 我曾写「apply:schema 刚跑完、cache 未刷新就是矛盾态」—— **实测不成立**：
    // 新建表时表探测与列探测**一致地 404**，旧代码走 missing 分支本来就 exit 1。
    // 真正能造出「表 200 / 列 404」的只有：表在两轮探测之间被删、多实例缓存分歧、
    // 或 RLS 42501 与 200 混排。无论哪种，都不能当成「一致」。
    const schema = readFileSync('supabase/schema.sql', 'utf8')
    const readFile = (f: string) =>
      String(f).includes('schema.sql')
        ? schema
        : 'VITE_SUPABASE_URL=https://vbamprkcwrpsazkyknjq.supabase.co\nVITE_SUPABASE_ANON_KEY=fake-anon-key\n'

    // 表探测（column === '*'）成功；所有列探测都返回「表不存在」
    const probeFn = async (_url: string, _anon: string, _table: string, column: string) =>
      column === '*'
        ? { ok: true, status: 200 }
        : { ok: false, status: 404, code: 'PGRST205' }

    const r = await runCheck({
      envFile: '.env.production',
      exists: () => true,
      readFile,
      probeFn: probeFn as never,
    })

    expect(r.code).toBe(1)
    // 84 个列探测必须全部被记为「无法判定」，而不是被 continue 吞掉
    expect(r.unknown.length).toBe(84)
    expect(r.okCount).toBe(13)
    // ⚠️ 还必须钉住**诊断内容**（第十四轮评审·轻微-2）：
    // 只钉 code/length 时，N3（分支落到通用 else，消息变「无法判定」）与
    // N4（unknown.push(空串)，84 条诊断全是空）两个变异仍然 185/185 全绿。
    // 矛盾态的诊断必须说清「表探测成功、列探测报缺表」这个自相矛盾的事实。
    expect(r.unknown.every((u) => u.includes('表探测成功'))).toBe(true)
    expect(r.unknown.every((u) => u.includes('列探测报缺表'))).toBe(true)
    expect(r.unknown.every((u) => u.trim().length > 0)).toBe(true)
  })
  it('add 括号组里双引号标识符含括号不能参与配平（否则整组丢失）', () => {
    // ⚠️ 这条守的是 matchBalancedParens 的「跳过双引号标识符」分支 ——
    // `blankSqlStrings` 故意**保留**双引号标识符（要能数到 "brand_new_table"），
    // 所以 body 里真的会出现 `"b(c"` 这种标识符。去掉跳过分支后：
    //   `(a int, "b(c" text)` 的 depth 永远回不到 0 → matchBalancedParens 返回 null → 整组列全丢
    //   `(a int, "b)c" text)` 的 depth 提前归零 → 只解析出 a，b 静默丢失
    // 变异实测：去掉该分支后本条与上面几条一起变红（[] / ['t.a']）。
    const sql1 = 'alter table public.t add column (a int, "b(c" text);'
    expect(
      dedupeColumns(parseSchema(sql1).columns).map((c) => c.table + '.' + c.column).sort(),
    ).toEqual(['t.a', 't.b(c'])

    const sql2 = 'alter table public.t add column (a int, "b)c" text);'
    expect(
      dedupeColumns(parseSchema(sql2).columns).map((c) => c.table + '.' + c.column).sort(),
    ).toEqual(['t.a', 't.b)c'])
  })
  it('add 括号组里字符串含右括号 —— 端到端仍然正确（但不测内部配平逻辑）', () => {
    // ⚠️ 诚实说明：这条**测不到** matchBalancedParens 的「跳过字符串」分支，因为它恒真。
    // 原因：matchBalancedParens 的输入是 body = locate.slice(...)，而 locate 来自
    // blankSqlStrings（字符串内容已被遮成空格），所以 body 里根本没有字符串字面量，
    // 那个分支在 body 上就是死代码（实测 body 不含单引号）。
    // 保留它的价值只是「端到端断言这个合法 DDL 能解析对」，不构成对内部逻辑的防线。
    // 真正的配平防线是上面「双引号标识符含括号」那条（变异实测会红）。
    const sql = "alter table public.t add column (a text default ')', b int);"
    const cols = dedupeColumns(parseSchema(sql).columns).map((c) => c.table + '.' + c.column)
    expect(cols.sort()).toEqual(['t.a', 't.b'])
  })
  it('字符串字面量里的 create table 不能产生幻影表（假红）', () => {
    // ⚠️ 这条是变异 M5 逼出来的：CREATE_HEAD_RE 若在 `clean`（保留字符串内容）上匹配，
    // 就会把 `default 'create table public.fake2 (id int);'` 当成真的建表语句 →
    // 解析出幻影表 fake2 + 幻影列 fake2.id，脚本会去探测一个根本不存在的表。
    // 必须断言 tables **精确相等**（不是 toContain），否则幻影表混进来也发现不了。
    const sql = "create table public.t (note text default 'create table public.fake2 (id int);');"
    const parsed = parseSchema(sql)
    expect(parsed.tables).toEqual(['t'])
    const cols = dedupeColumns(parsed.columns).map((c) => c.table + '.' + c.column)
    expect(cols).toEqual(['t.note'])
  })

  it('字符串里的 create table 不能让普查多数（不能假红）', () => {
    const sql = "create table public.t (note text default 'create table public.fake2 (id int);');"
    const parsed = parseSchema(sql)
    const c = ddlCensus(sql, parsed.tables)
    expect(c.found).toBe(1)
    expect(c.missing).toEqual([])
  })
  it('字符串字面量里的 alter table 不能产生幻影列（假红）', () => {
    // 旧实现：stripSqlComments 保留字符串内容 → 正则把字符串里的 alter 当真的 → 幻影列 fake.zz
    const sql = "create table public.t (note text default 'alter table public.fake add column zz int;');"
    const cols = dedupeColumns(parseSchema(sql).columns).map((c) => c.table + '.' + c.column)
    expect(cols).toEqual(['t.note'])
  })

  it('alter 的列默认值字符串里有 add 不能产生幻影列', () => {
    const sql = "alter table public.t add column note text default 'add column zz int';"
    const cols = dedupeColumns(parseSchema(sql).columns).map((c) => c.table + '.' + c.column)
    expect(cols).toEqual(['t.note'])
  })

  it('E-string 默认值里的伪 add（含分号）不能产生幻影列', () => {
    // E-string 里的 \\' 是转义；字符串里的分号不能截断语句体
    const sql = "alter table public.t add column note text default E'it\\'s; add column zz int';"
    const cols = dedupeColumns(parseSchema(sql).columns).map((c) => c.table + '.' + c.column)
    expect(cols).toEqual(['t.note'])
  })

  it('真实 schema 的 alter 语句里 drop constraint / enable RLS 不能产生幻影列', () => {
    const sql = readFileSync('supabase/schema.sql', 'utf8')
    const cols = dedupeColumns(parseSchema(sql).columns)
    const names = cols.map((c) => c.table + '.' + c.column)
    // 真实 schema 有 `alter table public.sessions drop constraint ...` 与大量 `enable row level security`
    expect(names).not.toContain('sessions.drop')
    expect(names).not.toContain('sessions.constraint')
    expect(names).not.toContain('sessions.enable')
    expect(names).not.toContain('sessions.row')
    expect(names).not.toContain('patients.enable')
    // 真实列仍在（pulse 是本轮新增的）
    expect(names).toContain('blood_pressures.pulse')
    expect(names).toContain('sessions.doctor_uf')
    expect(names).toContain('sessions.aborted_at')
    expect(names).toContain('sessions.abort_reason')
  })
  it('真实 schema.sql 的普查仍然是 found=13 parsed=13 missing=[]', () => {
    const sql = readFileSync('supabase/schema.sql', 'utf8')
    const parsed = parseSchema(sql)
    const c = ddlCensus(sql, parsed.tables)
    expect(c).toEqual({ found: 13, parsed: 13, missing: [] })
  })
})
describe('词法边界加固（轻微）', () => {
  it('isEscapeString 不能把标识符末尾的 e 当成 E 前缀（1e\'x\\\'）', () => {
    // ⚠️ 这条用例必须能让「只看前一个字符」的旧逻辑变红，否则等于没测。
    // 旧逻辑把 `1e` 的 e 当 E 前缀 → `\` 被当转义 → 吞掉闭合引号 → 误报「未闭合」。
    // 新逻辑要求 E 前面不是标识符字符，所以正确放行。
    expect(findUnterminatedSql("create table t (a text default 1e'x\\', b int);")).toEqual([])
    // 合法的 E'...' 仍必须按转义处理（反斜杠转义了引号）
    expect(findUnterminatedSql("create table t (v text default E'it\\'s');")).toEqual([])
    // 普通字符串里的反斜杠不是转义（standard_conforming_strings=on）
    expect(findUnterminatedSql("create table t (v text default 'C:\\');")).toEqual([])
  })

  it('双引号标识符里的 "" 要归一成一个双引号（列名 a"b）', () => {
    const q = String.fromCharCode(34)
    const sql = 'create table if not exists public.t (' + q + 'a' + q + q + 'b' + q + ' int, c int)'
    const cols = dedupeColumns(parseSchema(sql).columns).map((c) => c.column)
    // 未归一化时会得到 'a""b'，探测 select 出去必然 42703
    expect(cols).toEqual(['a' + q + 'b', 'c'])
  })
})
describe('ddlCensus：必须能发现「有 DDL 没被解析」（严重-1 的第二道防线）', () => {
  it('正常 schema.sql：普查缺口为 0', () => {
    const sql = readFileSync('supabase/schema.sql', 'utf8')
    const { tables } = parseSchema(sql)
    const census = ddlCensus(sql, tables)
    expect(census.missing).toEqual([])
    expect(census.found).toBe(census.parsed)
    expect(census.found).toBe(13)
  })

  it('CTAS（create table ... as select，无列定义括号）必须被普查抓到', () => {
    const sql =
      'create table public.a (id int);\n' +
      'create table public.ctas_t as select 1 as id;\n'
    const { tables } = parseSchema(sql)
    const census = ddlCensus(sql, tables)
    // parseSchema 认不出 CTAS（没有列定义括号）→ 只解析出 1 张表
    expect(tables).toEqual(['a'])
    // 普查必须发现这个缺口
    expect(census.found).toBe(2)
    expect(census.parsed).toBe(1)
    expect(census.missing.length).toBe(1)
    expect(census.missing[0]).toContain('ctas_t')
  })

  it('runCheck 在普查发现缺口时必须 exit 1，且不发出任何探测（走到普查那一步）', async () => {
    const asked = []
    const r = await runCheck({
      envFile: '/x/.env.production',
      sqlFile: '/x/schema.sql',
      // 让 env 检查通过：给一个生产库 URL 与 anon key
      exists: () => true,
      readFile: (f) =>
        f === '/x/schema.sql'
          ? 'create table public.a (id int);\ncreate table public.ctas_t as select 1 as id;'
          : 'VITE_SUPABASE_URL=https://vbamprkcwrpsazkyknjq.supabase.co\nVITE_SUPABASE_ANON_KEY=fake',
      probeFn: async (...args) => {
        asked.push(args)
        return { ok: true, status: 200, code: null }
      },
      logger: { log() {}, error() {} },
    })
    expect(r.code).toBe(1)
    // 关键：普查在探测之前拦下，一个请求都不发
    expect(asked).toEqual([])
    // 并且日志点名了那条没被解析的 DDL
    expect(r.log.join('\n')).toContain('ctas_t')
  })
  it('runCheck 在普查发现缺口时必须 exit 1，且不发出任何探测', async () => {
    const asked = []
    const r = await runCheck({
      envFile: '/nonexistent/.env.production',
      sqlFile: '/nonexistent/schema.sql',
      probeFn: async (...args) => {
        asked.push(args)
        return { ok: true, status: 200, code: null }
      },
      readFile: () =>
        'create table public.a (id int);\ncreate table public.ctas_t as select 1 as id;',
      exists: () => true,
      logger: { log() {}, error() {} },
    })
    // 环境读不到会先失败，这条用例的目的是钉住「普查在解析之后、探测之前」
    expect(r.code).toBe(1)
    expect(asked).toEqual([])
  })
})

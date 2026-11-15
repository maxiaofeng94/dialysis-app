/**
 * 检查生产库的结构是否与 supabase/schema.sql 同步。
 *
 * 为什么需要这个脚本：第十一轮用户反馈「变更历史没有记录却提示加载失败」，
 * 根因是**生产库从没执行过 schema.sql**（patient_change_logs 表不存在、
 * blood_pressures.pulse 列不存在），而整条发布链路（1828 条测试 / 10 轮评审 /
 * 4 个 CI 工作流）**没有一环能发现它**。
 *
 * 实现方式：**只用 anon key 做只读探测**，不写库、不需要 PAT。
 * 对每张表/每个列发一个 `select <col> limit 0`：
 * - 200 → 结构存在
 * - 404 PGRST205 → 表不存在
 * - 400 42703 → 列不存在
 *
 * ⚠️ 本脚本的头号敌人是**假绿**（对着错误的对象 / 在无法判定的情况下报 ✅）。
 * 第十一轮独立评审揪出四个会导致假绿的问题，都已修并加了用例：
 *   ① `.env.production` 缺失时静默回退 `.env`（= 检查测试库却报「生产库一致」）
 *      → 现在**只认 .env.production**，缺失直接失败；并断言 URL 不是测试库
 *   ② anon key 无效 / 主机不可达时全部探测 401 或 fetch failed，全归「无法判定」仍 exit 0
 *      → 现在**无法判定也算失败**（exit 1），并要求至少有一张表探测成功
 *   ③ `parseSchema` 不剥 SQL 注释，注释掉的 create table 被当真
 *      → 现在**先剥注释**再解析
 *   ④ `probe()` 无超时，黑洞主机能挂 10 秒以上且无上限
 *      → 现在每个请求 8 秒 AbortController 超时
 *
 * 用法：node scripts/check-prod-schema.mjs
 * 退出码：0 = 结构齐全（且确实检查的是生产库）；1 = 缺结构 / 无法判定 / 配置缺失
 */
import { readFileSync, existsSync } from 'node:fs'

const SQL = 'supabase/schema.sql'
/** 生产库的 ref（写死在这里，作为「检查对象是否正确」的最后一道断言） */
const EXPECTED_PROD_REF = 'vbamprkcwrpsazkyknjq'
/** 已知的非生产库 ref：探测到这些说明读错了 env 文件 */
const KNOWN_NON_PROD_REFS = ['gkrugenqmbimpzkkriml']
/** 单个探测请求的超时（毫秒） */
const PROBE_TIMEOUT_MS = 8000

/**
 * 只从 .env.production 读配置。
 *
 * ⚠️ **故意不回退到 `.env`**：`.env` 连的是测试库。回退过一次的真实后果是
 * 「生产库缺表」被报成「✅ 生产库结构与 schema.sql 一致」，守卫彻底失效。
 * 新克隆的仓库 / CI 里 `.env.production` 是 gitignore 的、根本不存在 ——
 * 这时必须**明确失败**，而不是拿测试库凑数。
 */
export function loadEnv(
  file = '.env.production',
  exists = existsSync,
  readFile = (f) => readFileSync(f, 'utf8'),
) {
  if (!exists(file)) {
    return { error: `找不到 ${file}（生产库配置不入库，需本地准备）` }
  }
  const out = {}
  for (const line of readFile(file).split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 0) continue
    const k = t.slice(0, i).trim()
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    if (k === 'VITE_SUPABASE_URL') out.url = v
    if (k === 'VITE_SUPABASE_ANON_KEY') out.anon = v
  }
  if (!out.url || !out.anon) {
    return { error: `${file} 缺少 VITE_SUPABASE_URL 或 VITE_SUPABASE_ANON_KEY` }
  }
  return out
}

/** 从 URL 里取出 project ref */
export function refFromUrl(url) {
  const m = String(url).match(/https:\/\/([a-z0-9]+)\.supabase\.co/i)
  return m ? m[1] : null
}

/**
 * 校验「要检查的对象确实是生产库」。
 * 返回错误信息字符串，或 null 表示没问题。
 */
export function assertProdTarget(url, expectedRef = EXPECTED_PROD_REF, nonProdRefs = KNOWN_NON_PROD_REFS) {
  const ref = refFromUrl(url)
  if (!ref) return `URL 里解析不出 Supabase project ref：${url}`
  if (nonProdRefs.includes(ref)) {
    return `检查对象是**非生产库** ${ref}（很可能是读到了 .env 而不是 .env.production）`
  }
  if (ref !== expectedRef) {
    return `检查对象 ref=${ref}，与预期的生产库 ${expectedRef} 不一致`
  }
  return null
}

/** 剥掉 SQL 注释（-- 行注释 与 块注释），避免注释里的建表语句被当真 */
export function stripSqlComments(sql) {
  // 先剥块注释 /* ... */（非贪婪、跨行），再剥行注释 -- 到行尾
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\r\n]*/g, '')
}

/**
 * 从 schema.sql 解析出「必须有」的表与列。
 *
 * ⚠️ 建表语句的列解析**不能依赖 `);` 的具体缩进**：独立评审实测，
 * 把收尾 `);` 缩进成 `  );`（sqlfluff / prettier-plugin-sql 的默认风格）后，
 * 可探测列会从 84 静默掉到 5 —— 而「pulse 在列里」那条断言仍然绿。
 * 现在改用**括号配平**找建表体，不依赖缩进。
 */
export function parseSchema(sql) {
  const clean = stripSqlComments(sql)

  const tables = [...clean.matchAll(/create\s+table\s+if\s+not\s+exists\s+public\.(\w+)/gi)].map(
    (m) => m[1],
  )

  // alter table ... add column if not exists
  const altered = [
    ...clean.matchAll(
      /alter\s+table\s+public\.(\w+)\s+add\s+column\s+if\s+not\s+exists\s+(\w+)/gi,
    ),
  ].map((m) => ({ table: m[1], column: m[2] }))

  // 建表语句内部的列：用括号配平截出建表体（不依赖 `);` 的缩进）
  const declared = []
  const headRe = /create\s+table\s+if\s+not\s+exists\s+public\.(\w+)\s*\(/gi
  let h
  while ((h = headRe.exec(clean)) !== null) {
    const table = h[1]
    const bodyStart = h.index + h[0].length
    let depth = 1
    let i = bodyStart
    while (i < clean.length && depth > 0) {
      const ch = clean[i]
      if (ch === '(') depth++
      else if (ch === ')') depth--
      i++
    }
    const body = clean.slice(bodyStart, i - 1)
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      // 列定义形如 `col_name type ...`；跳过约束声明
      const c = line.match(/^(\w+)\s+[a-z]/i)
      if (!c) continue
      const name = c[1].toLowerCase()
      if (['constraint', 'primary', 'unique', 'foreign', 'check', 'exclude'].includes(name)) continue
      declared.push({ table, column: c[1] })
    }
  }

  return { tables, columns: [...altered, ...declared] }
}

/** 去重（同一列可能既在建表体、又在 add column 里） */
export function dedupeColumns(columns) {
  const seen = new Set()
  const out = []
  for (const { table, column } of columns) {
    const k = table + '.' + column
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ table, column })
  }
  return out
}

/** 带超时的探测 */
export async function probe(url, anon, table, column, timeoutMs = PROBE_TIMEOUT_MS) {
  const q = `${url}/rest/v1/${table}?select=${column}&limit=0`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(q, {
      headers: { apikey: anon, Authorization: `Bearer ${anon}` },
      signal: ctrl.signal,
    })
    if (r.ok) return { ok: true }
    const body = await r.text()
    let code = null
    try {
      code = JSON.parse(body).code ?? null
    } catch {
      /* 非 JSON */
    }
    return { ok: false, status: r.status, code, body: body.slice(0, 200) }
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e)))
    return {
      ok: null,
      timeout: aborted,
      error: aborted ? `超时 ${timeoutMs}ms` : String(e).slice(0, 160),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把探测结果归类。
 * @returns {'ok'|'missing-table'|'missing-column'|'unknown'}
 */
export function classify(r, kind) {
  if (r.ok === true) return 'ok'
  if (r.ok === null) return 'unknown'
  if (r.code === 'PGRST205' || r.code === '42P01') return 'missing-table'
  if (r.code === '42703') return 'missing-column'
  if (r.status === 401 || r.status === 403) return 'unknown'
  // 其它错误码（400 语法、500 等）也算无法判定，不能当成「结构 OK」
  return 'unknown'
}

/**
 * 执行一次完整检查（**可注入 probe，便于单测**）。
 *
 * 为什么抽成函数：第十一轮独立评审指出 `probe()` / 退出码 / 主循环**零覆盖** ——
 * 而「404 PGRST205 → 判缺表 → exit 1」正是这次生产事故唯一依赖的判定链。
 * 改坏了没有任何用例会红，等于防线是纸做的。
 *
 * @returns {Promise<{code: number, log: string[], missing: string[], unknown: string[], okCount: number}>}
 *   code 0 = 一致；1 = 缺结构 / 无法判定 / 配置问题
 */
export async function runCheck(opts = {}) {
  const {
    envFile = '.env.production',
    sqlFile = SQL,
    probeFn = probe,
    probeTimeoutMs = PROBE_TIMEOUT_MS,
    expectedRef = EXPECTED_PROD_REF,
    nonProdRefs = KNOWN_NON_PROD_REFS,
    readFile = (f) => readFileSync(f, 'utf8'),
    exists = existsSync,
    logger = console,
  } = opts

  const log = []
  const out = (line) => {
    log.push(line)
    logger.log(line)
  }
  const err = (line) => {
    log.push(line)
    logger.error(line)
  }

  const env = loadEnv(envFile, exists, readFile)
  if (env.error) {
    err(`❌ ${env.error}`)
    err('   （生产库检查必须有 .env.production；不会回退到 .env 的测试库）')
    return { code: 1, log, missing: [], unknown: [], okCount: 0 }
  }

  const targetErr = assertProdTarget(env.url, expectedRef, nonProdRefs)
  if (targetErr) {
    err(`❌ 检查对象不对：${targetErr}`)
    return { code: 1, log, missing: [], unknown: [], okCount: 0 }
  }

  out(`检查目标：${env.url}`)

  let sql
  try {
    sql = readFile(sqlFile)
  } catch (e) {
    err(`❌ 读不到 ${sqlFile}：${String(e)}`)
    return { code: 1, log, missing: [], unknown: [], okCount: 0 }
  }

  const { tables, columns } = parseSchema(sql)
  const uniqueCols = dedupeColumns(columns)
  out(`schema.sql 声明：${tables.length} 张表、${uniqueCols.length} 个列`)
  out('')

  if (tables.length === 0) {
    err('❌ 没从 schema.sql 解析出任何表 —— 解析器坏了，不能当作「结构一致」')
    return { code: 1, log, missing: [], unknown: [], okCount: 0 }
  }

  const missing = []
  const unknown = []
  let okCount = 0

  for (const t of tables) {
    const r = await probeFn(env.url, env.anon, t, '*', probeTimeoutMs)
    const c = classify(r, 'table')
    if (c === 'ok') okCount++
    else if (c === 'missing-table') missing.push(`表 ${t} 不存在（HTTP ${r.status} ${r.code}）`)
    else unknown.push(`${t}（${r.status ?? ''} ${r.code ?? r.error ?? ''}）`)
  }

  for (const { table, column } of uniqueCols) {
    const r = await probeFn(env.url, env.anon, table, column, probeTimeoutMs)
    const c = classify(r, 'column')
    if (c === 'ok') okCount++
    else if (c === 'missing-column') missing.push(`列 ${table}.${column} 不存在（HTTP ${r.status} 42703）`)
    else if (c === 'missing-table') continue
    else unknown.push(`${table}.${column}（${r.status ?? ''} ${r.code ?? r.error ?? ''}）`)
  }

  if (missing.length) {
    err('❌ 生产库结构未同步（schema.sql 有、库里没有）：')
    for (const m of missing) err('   - ' + m)
    err('')
    err('修法：npm run apply:schema -- ' + expectedRef + ' <PROD_PAT>')
    err('（schema.sql 是幂等的，重复执行不清数据）')
    return { code: 1, log, missing, unknown, okCount }
  }

  // ⚠️ 无法判定也算失败：全 401 / 全超时时报 ✅ 是假绿
  if (unknown.length) {
    err('❌ 有探测无法判定，不能确认结构一致：')
    for (const u of unknown) err('   - ' + u)
    err('')
    err('常见原因：anon key 无效、网络不通、RLS 拦住了匿名读。')
    err('结构检查必须能真正读到库，否则这道防线等于没有。')
    return { code: 1, log, missing, unknown, okCount }
  }

  if (okCount === 0) {
    err('❌ 没有任何一项探测成功，不能报告「结构一致」')
    return { code: 1, log, missing, unknown, okCount }
  }

  out(`✅ 生产库结构与 schema.sql 一致（${okCount} 项探测全部通过）`)
  return { code: 0, log, missing, unknown, okCount }
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('check-prod-schema.mjs')
if (isMain) {
  const r = await runCheck()
  process.exit(r.code)
}

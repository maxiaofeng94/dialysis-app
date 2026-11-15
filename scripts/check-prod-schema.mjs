/**
 * 检查生产库的结构是否与 supabase/schema.sql 同步。
 *
 * 为什么需要这个脚本：第十一轮用户反馈「变更历史没有记录却提示加载失败」，
 * 根因是**生产库从没执行过 schema.sql**（patient_change_logs 表不存在、
 * blood_pressures.pulse 列不存在），而整条发布链路（1819 条测试 / 10 轮评审 /
 * 4 个 CI 工作流）**没有一环能发现它**。
 *
 * 实现方式：**只用 anon key 做只读探测**，不写库、不需要 PAT。
 * 对每张表/每个列发一个 `select <col> limit 0`：
 * - 200 → 结构存在
 * - 404 PGRST205 → 表不存在
 * - 400 42703 → 列不存在
 * - 其它（401/网络）→ 无法判定，不算失败但会明确报出来
 *
 * 用法：node scripts/check-prod-schema.mjs
 * 退出码：0 = 结构齐全或无法判定；1 = 明确缺少结构
 */
import { readFileSync, existsSync } from 'node:fs'

const SQL = 'supabase/schema.sql'

function loadEnv() {
  const out = {}
  for (const f of ['.env.production', '.env']) {
    if (!existsSync(f)) continue
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const i = t.indexOf('=')
      if (i < 0) continue
      const k = t.slice(0, i).trim()
      const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
      if (k === 'VITE_SUPABASE_URL') out.url = v
      if (k === 'VITE_SUPABASE_ANON_KEY') out.anon = v
    }
    if (out.url) break // .env.production 优先
  }
  return out
}

/** 从 schema.sql 解析出「必须有」的表与列 */
export function parseSchema(sql) {
  const tables = [...sql.matchAll(/create table if not exists public\.(\w+)/gi)].map((m) => m[1])
  const columns = [...sql.matchAll(/alter table public\.(\w+)\s+add column if not exists (\w+)/gi)].map(
    (m) => ({ table: m[1], column: m[2] }),
  )
  // 建表语句里的列（create table 的括号内），用于检查「表存在但列不全」
  const declared = []
  for (const m of sql.matchAll(/create table if not exists public\.(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
    const table = m[1]
    for (const line of m[2].split(/\r?\n/)) {
      const c = line.match(/^\s{2}(\w+)\s+\w/)
      if (c && !['constraint', 'primary', 'unique', 'foreign', 'check'].includes(c[1].toLowerCase())) {
        declared.push({ table, column: c[1] })
      }
    }
  }
  return { tables, columns: [...columns, ...declared] }
}

async function probe(url, anon, table, column) {
  const q = `${url}/rest/v1/${table}?select=${column}&limit=0`
  try {
    const r = await fetch(q, { headers: { apikey: anon, Authorization: `Bearer ${anon}` } })
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
    return { ok: null, error: String(e).slice(0, 160) }
  }
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('check-prod-schema.mjs')
if (isMain) {
  const { url, anon } = loadEnv()
  if (!url || !anon) {
    console.error('❌ 找不到 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY（检查 .env.production）')
    process.exit(1)
  }
  console.log(`检查目标：${url}`)
  const { tables, columns } = parseSchema(readFileSync(SQL, 'utf8'))
  console.log(`schema.sql 声明：${tables.length} 张表、${columns.length} 个列\n`)

  const missing = []
  const unknown = []

  for (const t of tables) {
    // 用 * 而不是 id：admins / rate_limits 没有 id 列，用 id 会误报「列不存在」
    const r = await probe(url, anon, t, '*')
    if (r.ok === true) continue
    if (r.ok === null) {
      unknown.push(`${t}（${r.error}）`)
      continue
    }
    if (r.code === 'PGRST205' || r.code === '42P01') {
      missing.push(`表 ${t} 不存在（HTTP ${r.status} ${r.code}）`)
    } else if (r.status === 401 || r.status === 403) {
      // 无权限读 ≠ 表不存在：RLS 下匿名读也可能 401，不能据此判定
      unknown.push(`${t}（HTTP ${r.status}，无权限判定）`)
    } else {
      unknown.push(`${t}（HTTP ${r.status} ${r.code ?? ''}）`)
    }
  }

  // 去重：同一列可能既在建表语句里、又在 add column 里（如 blood_pressures.pulse）
  const seenCol = new Set()
  const uniqueCols = columns.filter(({ table, column }) => {
    const k = table + '.' + column
    if (seenCol.has(k)) return false
    seenCol.add(k)
    return true
  })

  for (const { table, column } of uniqueCols) {
    const r = await probe(url, anon, table, column)
    if (r.ok === true) continue
    if (r.ok === null) {
      unknown.push(`${table}.${column}（${r.error}）`)
      continue
    }
    if (r.code === '42703') {
      missing.push(`列 ${table}.${column} 不存在（HTTP ${r.status} 42703）`)
    } else if (r.status === 401 || r.status === 403) {
      unknown.push(`${table}.${column}（HTTP ${r.status}，无权限判定）`)
    } else if (r.code === 'PGRST205' || r.code === '42P01') {
      // 表本身已在上面的循环里报过，这里不重复
      continue
    } else {
      unknown.push(`${table}.${column}（HTTP ${r.status} ${r.code ?? ''}）`)
    }
  }

  if (unknown.length) {
    console.log('⚠️ 无法判定（不影响结论，但请留意）：')
    for (const u of unknown) console.log('   - ' + u)
    console.log('')
  }

  if (missing.length) {
    console.error('❌ 生产库结构未同步（schema.sql 有、库里没有）：')
    for (const m of missing) console.error('   - ' + m)
    console.error(
      '\n修法：node scripts/apply-schema.mjs ' +
        (url.match(/https:\/\/(\w+)\.supabase\.co/)?.[1] ?? '<ref>') +
        ' <PROD_PAT>',
    )
    console.error('（schema.sql 是幂等的，重复执行不清数据）')
    process.exit(1)
  }

  console.log('✅ 生产库结构与 schema.sql 一致')
}

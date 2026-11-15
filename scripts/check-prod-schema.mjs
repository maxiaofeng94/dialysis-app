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
 * 第十二轮独立评审又揪出三处（都已修 + 加用例）：
 *   ⑤ `parseSchema` 遇到未闭合引号时**静默丢列** → 假绿（漏报真实缺列）
 *      → 现在先跑 `findUnterminatedSql`，语法坏掉直接 exit 1，不拿残缺结果下结论
 *   ⑥ `probe` 的列名没做 URL 编码 → 列名含 `&` 时探测对象错位
 *      → 现在用 `encodeURIComponent`
 *   ⑦ `\` 被无条件当成转义（与 Postgres `standard_conforming_strings=on` 相反）
 *      → 普通字符串里 `default 'C:\'` 被误报未闭合（假红）；
 *        `E'it\'s fine'` 后面的列被整段吞掉（假绿）
 *      → 现在只在 `E'` / `e'` 前缀后才把 `\` 当转义
 *
 * 用法：node scripts/check-prod-schema.mjs
 * 退出码：0 = 结构齐全（且确实检查的是生产库）；1 = 缺结构 / 无法判定 / 配置缺失 / SQL 语法坏
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
export function assertProdTarget(
  url,
  expectedRef = EXPECTED_PROD_REF,
  nonProdRefs = KNOWN_NON_PROD_REFS,
) {
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

/**
 * 判断位置 `quoteIdx` 处的单引号是否是 `E'...'`（转义字符串）。
 *
 * PostgreSQL 默认 `standard_conforming_strings = on`：普通字符串里 `\` 是普通字符，
 * 只有 `E'...'` / `e'...'` 前缀才启用反斜杠转义。
 * 三处词法扫描都必须按这个规则走，否则（第十二轮评审·轻微-2 实测）：
 *   · `default 'C:\'`（合法 SQL）会被误报「单引号未闭合」→ runCheck 假红；
 *   · `default E'it\'s fine'` 会让后续列被整段吞掉 → parseSchema 丢列 → 假绿。
 */
function isEscapeString(sql, quoteIdx) {
  const prev = quoteIdx > 0 ? sql[quoteIdx - 1] : ''
  if (prev !== 'E' && prev !== 'e') return false
  // ⚠️ 还要确认这个 `E` 是**独立前缀**，而不是某个标识符的末尾字符。
  // 否则 `value numeric default 1e'5'` 里 `1e` 的 `e` 会被误判成 E-string 前缀，
  // 于是把 `\` 当转义、可能吞掉后续内容（第十二轮评审·轻微实测的形态）。
  // 当前 schema.sql 里 `E'` 出现 0 次，属预防性加固。
  const before = quoteIdx > 1 ? sql[quoteIdx - 2] : ''
  return !/[\w$]/.test(before)
}

/**
 * 剥掉 SQL 注释（-- 行注释 与 块注释），避免注释里的建表语句被当真。
 *
 * ⚠️ 必须用**真词法扫描**，不能用正则：第十二轮评审实测
 * `check (name <> '--')` 这种「字符串里含注释标记」会被正则当成行注释起点，
 * 把后面的 `)` 一起吃掉 → 括号配平提前结束 → 幻影列 / 漏列。
 * 同理块注释在 PostgreSQL 里允许嵌套，正则也处理不了。
 *
 * 规则：
 * - 单引号字符串：`''` 转义；只有 `E'...'` 里 `\` 才转义
 * - 双引号标识符：`""` 转义
 * - dollar-quote `$tag$ ... $tag$`：整体保留（内容不参与建表解析，但**内容里可能有
 *   动态 SQL 造出的表名**，所以下面 parseSchema 会把内容遮掉）
 * - 行注释 `--` 到行尾；块注释可嵌套
 * - 所有被剥掉的部分用**空格**填充（保留换行，行号对得上）
 */
export function stripSqlComments(sql) {
  const out = []
  let i = 0
  const n = sql.length

  /** 把一段文本里的非换行字符替换成空格（保留换行，行号对得上） */
  const blank = (text) => text.replace(/[^\r\n]/g, ' ')

  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]

    // ---- 行注释 -- ----
    if (ch === '-' && next === '-') {
      let j = i
      while (j < n && sql[j] !== '\n') j++
      out.push(blank(sql.slice(i, j)))
      i = j
      continue
    }

    // ---- 块注释（PostgreSQL 允许嵌套）----
    if (ch === '/' && next === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++
          j += 2
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--
          j += 2
        } else {
          j++
        }
      }
      out.push(blank(sql.slice(i, j)))
      i = j
      continue
    }

    // ---- dollar-quote $tag$ ... $tag$ ----
    if (ch === '$') {
      const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i))
      if (tagMatch) {
        const tag = tagMatch[0]
        const close = sql.indexOf(tag, i + tag.length)
        const end = close < 0 ? n : close + tag.length
        // 标签保留，内容遮成空白：内容里的动态 SQL 不该被当成真的建表语句
        out.push(tag)
        out.push(blank(sql.slice(i + tag.length, Math.max(i + tag.length, end - tag.length))))
        if (close >= 0) out.push(tag)
        i = end
        continue
      }
    }

    // ---- 单引号字符串 ----
    if (ch === "'") {
      const escapeString = isEscapeString(sql, i)
      let j = i + 1
      while (j < n) {
        // 只有 E'...' 才把 \ 当转义（standard_conforming_strings=on）
        if (escapeString && sql[j] === '\\') {
          j += 2
          continue
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2
            continue
          }
          j++
          break
        }
        j++
      }
      out.push(sql.slice(i, j))
      i = j
      continue
    }

    // ---- 双引号标识符 ----
    if (ch === '"') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2
            continue
          }
          j++
          break
        }
        j++
      }
      out.push(sql.slice(i, j))
      i = j
      continue
    }

    out.push(ch)
    i++
  }

  return out.join('')
}

/**
 * 把**字符串字面量**和注释也一起遮成空白（保留换行）。
 *
 * ⚠️ 为什么需要单独一遍：`ddlCensus` 用一条极宽的正则数「文件里有多少个
 * `create table`」，它**不关心语义、只数关键字**。如果某个 text 列的默认值里
 * 恰好写了 `default 'create table x'`，宽正则会把字符串内容也算一次 →
 * `found=2 parsed=1 missing=["create table x"]` → **假红**（报「有 DDL 没被解析」）。
 *
 * 实测（第十四轮自查）：`note text default 'create table x'` 会让 `runCheck`
 * 直接 exit 1 并打印「未识别：create table x'」。合法 SQL 被拦下推送，属于
 * 「宁可假红」方向上**过头**了 —— 假红也要能解释，而这条没法解释。
 *
 * 与 `stripSqlComments` 的区别：那个**保留**字符串内容（`parseSchema` 要靠
 * `default '...'` 里的内容判断列边界），这个**连字符串一起遮**（只给普查用）。
 */
export function blankSqlStrings(sql) {
  const out = []
  let i = 0
  const n = sql.length

  const blank = (text) => text.replace(/[^\r\n]/g, ' ')

  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]

    // 行注释
    if (ch === '-' && next === '-') {
      let j = i
      while (j < n && sql[j] !== '\n') j++
      out.push(blank(sql.slice(i, j)))
      i = j
      continue
    }

    // 块注释（可嵌套）
    if (ch === '/' && next === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++
          j += 2
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--
          j += 2
        } else {
          j++
        }
      }
      out.push(blank(sql.slice(i, j)))
      i = j
      continue
    }

    // dollar-quote：连标签一起遮（普查不需要它）
    if (ch === '$') {
      const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i))
      if (tagMatch) {
        const tag = tagMatch[0]
        const close = sql.indexOf(tag, i + tag.length)
        const end = close < 0 ? n : close + tag.length
        out.push(blank(sql.slice(i, end)))
        i = end
        continue
      }
    }

    // 单引号字符串（E'...' 里 \ 是转义）
    if (ch === "'") {
      const escapeString = isEscapeString(sql, i)
      let j = i + 1
      while (j < n) {
        if (escapeString && sql[j] === '\\') {
          j += 2
          continue
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2
            continue
          }
          j++
          break
        }
        j++
      }
      out.push(blank(sql.slice(i, j)))
      i = j
      continue
    }

    // 双引号标识符：**必须保留**（表名可能是 `"brand_new_table"`，遮掉就数不到表了）
    if (ch === '"') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2
            continue
          }
          j++
          break
        }
        j++
      }
      out.push(sql.slice(i, j))
      i = j
      continue
    }

    out.push(ch)
    i++
  }

  return out.join('')
}

/**
 * 找出 SQL 里**未闭合**的引号 / dollar-quote / 块注释 / 括号。
 *
 * ⚠️ 为什么必须单独做这一遍：`parseSchema` 是「尽力解析」—— 遇到未闭合的单引号，
 * 它会把后面所有内容都当成字符串内容，于是后面的列**静默消失**，
 * 探测项变少、缺列永远发现不了 → **假绿**。
 * 所以 runCheck 在解析前先跑这个；有问题就直接失败，不拿残缺结果下结论。
 *
 * @returns {string[]} 问题描述列表（空数组 = 语法完整）
 */
export function findUnterminatedSql(sql) {
  const problems = []
  let i = 0
  const n = sql.length
  // ⚠️ 括号配平（第十二轮评审·中级）：本函数只查引号 / dollar-quote / 块注释，
  // 而 `parseSchema` 靠**括号配平**截取建表体 —— 少一个右括号就会把后面的列全吞掉。
  // 评审实测：把 `admins` 的 `(` 改成 `((` → 该表 4 列静默消失、`ddlCensus` 只数表
  // 也放行，`runCheck` 照样报「✅ 一致（93 项探测全部通过）」并 exit 0。
  // 所以「解析结果不可信就拒绝报一致」这句承诺必须包含括号。
  let depth = 0

  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]

    // 行注释：直接跳到行尾，不影响闭合
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++
      continue
    }

    // 块注释
    if (ch === '/' && next === '*') {
      const start = i
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else {
          i++
        }
      }
      if (depth > 0) problems.push(`块注释未闭合（从第 ${start} 个字符起）`)
      continue
    }

    // dollar-quote
    if (ch === '$') {
      const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i))
      if (tagMatch) {
        const tag = tagMatch[0]
        const start = i
        const close = sql.indexOf(tag, i + tag.length)
        if (close < 0) {
          problems.push(`dollar-quote ${tag} 未闭合（从第 ${start} 个字符起）`)
          i = n
        } else {
          i = close + tag.length
        }
        continue
      }
    }

    // 单引号字符串
    if (ch === "'") {
      const start = i
      const escapeString = isEscapeString(sql, i)
      let j = i + 1
      let closed = false
      while (j < n) {
        if (escapeString && sql[j] === '\\') {
          j += 2
          continue
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2
            continue
          }
          j++
          closed = true
          break
        }
        j++
      }
      if (!closed) problems.push(`单引号字符串未闭合（从第 ${start} 个字符起）`)
      i = j
      continue
    }

    // 双引号标识符
    if (ch === '"') {
      const start = i
      let j = i + 1
      let closed = false
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2
            continue
          }
          j++
          closed = true
          break
        }
        j++
      }
      if (!closed) problems.push(`双引号标识符未闭合（从第 ${start} 个字符起）`)
      i = j
      continue
    }

    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth < 0) {
        problems.push(`多余的右括号（第 ${i} 个字符处，前面没有对应的左括号）`)
        // 复位，避免后面每一行都报一遍
        depth = 0
      }
    }

    i++
  }

  if (depth > 0) {
    problems.push(`缺少 ${depth} 个右括号（左括号没有配平，建表体可能被截断）`)
  }

  return problems
}

/**
 * 按**顶层逗号**切分建表体（跳过字符串、双引号标识符、dollar-quote、嵌套括号）。
 *
 * ⚠️ 不能简单 `split(',')`：第十二轮评审实测多行外键约束
 * `references public.x (id)` / `on delete cascade` 会被切成幻影列；
 * `numeric(10,2)`、`check (a in (1,2))`、`default 'x,y'` 同理。
 */
export function splitTopLevel(body) {
  const parts = []
  let depth = 0
  let cur = []
  let i = 0
  const n = body.length

  while (i < n) {
    const ch = body[i]

    // 双引号标识符里的逗号不切（`"a,b" int` 是一段）
    if (ch === '"') {
      let j = i + 1
      cur.push(ch)
      while (j < n) {
        if (body[j] === '"') {
          if (body[j + 1] === '"') {
            cur.push('""')
            j += 2
            continue
          }
          cur.push('"')
          j++
          break
        }
        cur.push(body[j])
        j++
      }
      i = j
      continue
    }

    // dollar-quote 里的逗号不切（`$$a,b$$` 是一段）
    if (ch === '$') {
      const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(body.slice(i))
      if (tagMatch) {
        const tag = tagMatch[0]
        const close = body.indexOf(tag, i + tag.length)
        const end = close < 0 ? n : close + tag.length
        cur.push(body.slice(i, end))
        i = end
        continue
      }
    }

    // 单引号字符串里的逗号不切
    // ⚠️ 必须认 E'...' 的反斜杠转义：否则 E'it\'s fine' 会在 \' 处被当成字符串结束，
    // 后面的 `, potassium numeric(4,1)` 被吞成字符串内容 → 丢列（轻微-2）。
    if (ch === "'") {
      const escapeString = isEscapeString(body, i)
      let j = i + 1
      cur.push(ch)
      while (j < n) {
        if (escapeString && body[j] === '\\') {
          cur.push(body[j])
          if (j + 1 < n) cur.push(body[j + 1])
          j += 2
          continue
        }
        if (body[j] === "'") {
          if (body[j + 1] === "'") {
            cur.push("''")
            j += 2
            continue
          }
          cur.push("'")
          j++
          break
        }
        cur.push(body[j])
        j++
      }
      i = j
      continue
    }

    if (ch === '(') {
      depth++
      cur.push(ch)
      i++
      continue
    }
    if (ch === ')') {
      depth--
      cur.push(ch)
      i++
      continue
    }
    if (ch === ',' && depth === 0) {
      parts.push(cur.join(''))
      cur = []
      i++
      continue
    }
    cur.push(ch)
    i++
  }
  if (cur.join('').trim()) parts.push(cur.join(''))
  return parts
}

/** 约束片段的关键字（这些不是列名） */
const CONSTRAINT_KEYWORDS = new Set([
  'constraint',
  'primary',
  'unique',
  'foreign',
  'check',
  'exclude',
  'like',
  'references',
  'on',
  'using',
  'with',
  'not',
  'default',
  'generated',
  'null',
])

/**
 * 表引用的匹配片段（不含 `create table` 前缀）：
 * 可选的 `public.` / `"public".` 限定符 + 可选的引号包裹表名。
 *
 * ⚠️ 必须同时支持三种写法，否则会**静默漏表**（第十二轮评审·严重-1 实测：
 * 追加 5 种合法 DDL 变体后，三道守卫全绿、新结构 100% 未被解析）：
 *   - `public.users`            ← 手写迁移脚本（本项目 schema.sql 就是这种）
 *   - `"public"."patient_notes"` ← pg_dump 默认风格
 *   - `users`                   ← 省略 schema
 */
const TABLE_REF = String.raw`(?:"public"\s*\.\s*|public\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?`

/** 单列引用：双引号包裹或裸标识符。捕获组 1 = 带引号名，2 = 裸名 */
const COL_REF = String.raw`(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))`

/**
 * 匹配一条 `create table` 语句的头部（到左括号为止）。
 *
 * 覆盖的写法（评审实测这些都会让原实现静默漏表）：
 *   A. `create table if not exists "public"."patient_notes" (`  ← pg_dump 风格
 *   B. `create table if not exists public.x (`
 *   C. `create table "public"."x" (`
 *   D. `create table x (`                                       ← 省略 schema
 *   E. `create table public.x (`                                ← 省略 if not exists
 *   F. `create unlogged table ...` / `create temp table ...`
 */
const CREATE_HEAD_RE = new RegExp(
  String.raw`create\s+(?:unlogged\s+|temp(?:orary)?\s+)?table\s+` +
    String.raw`(?:if\s+not\s+exists\s+)?(?:only\s+)?` +
    TABLE_REF +
    String.raw`\s*\(`,
  'gi',
)

/**
 * 匹配一条 `alter table ... add [column]` 语句的**头部**（只到第一个 `add` 之前）。
 *
 * 覆盖：`alter table if exists …`、`alter table only …`。
 * 捕获组 1 = 表名。
 *
 * ⚠️ 为什么只匹配到 `add` 之前、而不是整条 `add` 子句：
 * 第十四轮自查发现 `alter table public.t add column a int, add column b int;`
 * （一条语句里多个 `add`，PG 完全合法）只会解析出 `a`，`b` 静默丢失。
 * 原来的正则把 `add ...` 也吃进匹配里，全局 `exec` 从 `a` 之后继续找，
 * 但下一个 `add` 前面没有 `alter table` 前缀 → 匹配不上。
 * 现在拆成「先定位语句头，再在语句体内逐个扫 add」，多 add 也能全解析。
 */
const ALTER_HEAD_RE = new RegExp(
  String.raw`alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?` + TABLE_REF,
  'gi',
)

/**
 * 在一条 alter 语句体里定位 `add` 关键字（后面到列名之间的修饰词一起吃掉）。
 *
 * ⚠️ 这里**只匹配到「列名/左括号」的起始位置**，不试图用正则吃掉整个括号组。
 * 第十四轮自查实测：用 `(\([^)]*\)|列名)` 匹配括号组时，
 *   `alter table public.t add column (a numeric(4,1), b text);`
 * 里的 `[^)]*` 会在 `numeric(4,1)` 的第一个 `)` 处停下 → 只解析出 `a`，`b` 静默丢失
 * （假绿：探测项变少，生产库真缺 `b` 也不报）。真实 `schema.sql` 里没有 `add column (`
 * 这种形态，但这是**合法 PG 语法**，不能靠「现在没有」来保证安全。
 * 所以括号组改用 `matchBalancedParens` 按配平提取，正则只负责找起点。
 *
 * 捕获组 1 = 带引号列名，2 = 裸列名（括号组时两者都不匹配，靠 index 判断）
 */
const ALTER_BODY_ADD_RE = new RegExp(
  String.raw`\badd\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?(?:"((?:[^"]|"")*)"|([A-Za-z_][A-Za-z0-9_]*)|(?=\())`,
  'gi',
)

/**
 * 从 `text[start]` 处的左括号开始，按配平返回括号内的内容（不含最外层括号）。
 *
 * 跳过字符串（含 E-string 转义）、双引号标识符 —— 它们内部的括号不参与配平。
 * 返回 null 表示没有左括号或括号不配平。
 */
function matchBalancedParens(text, start) {
  if (text[start] !== '(') return null
  let depth = 0
  let i = start
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'") {
      const escapeString = isEscapeString(text, i)
      let j = i + 1
      while (j < text.length) {
        if (escapeString && text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            j += 2
            continue
          }
          j++
          break
        }
        j++
      }
      i = j
      continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < text.length) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            j += 2
            continue
          }
          j++
          break
        }
        j++
      }
      i = j
      continue
    }
    if (ch === '(') {
      depth++
    } else if (ch === ')') {
      depth--
      if (depth === 0) return text.slice(start + 1, i)
      if (depth < 0) return null
    }
    i++
  }
  return null
}

/**
 * DDL 普查：核对「文件里出现的 create table 数」与「parseSchema 真正解析出的表数」。
 *
 * ⚠️ 这是第十二轮评审·严重-1 的修法。`parseSchema` 是**尽力解析** —— 遇到它不认识的
 * DDL 拼写就静默跳过，后果有两个且都是致命的：
 *   1. 探测项变少 → 生产库真缺那张表也不报（假绿，正是第十一轮事故的形态）
 *   2. `schema-baseline.spec.ts` 的期望值也来自同一个 `parseSchema` → 两边同时少仍相等
 * 所以必须有**一条独立的、不依赖 parseSchema 的普查**兜底。
 *
 * @param {string} sql 原始 SQL
 * @param {string[]} parsedTables parseSchema 解析出的表名
 * @returns {{found:number, parsed:number, missing:string[]}}
 *   found = 极宽正则数出的 create table 次数；parsed = 解析出的去重表数；
 *   missing = 未能对应到已解析表的语句片段（便于定位）
 */
export function ddlCensus(sql, parsedTables) {
  // ⚠️ 必须用 blankSqlStrings（连字符串一起遮），不能用 stripSqlComments：
  // 后者保留字符串内容，`default 'create table x'` 会被宽正则多数一次 → 假红。
  const clean = blankSqlStrings(sql)
  // 极宽：只要出现 create [unlogged|temp] table 就计数，不管后面怎么写
  const broad = [...clean.matchAll(/create\s+(?:unlogged\s+|temp(?:orary)?\s+)?table\b/gi)]
  const parsed = new Set(parsedTables.map((t) => t.toLowerCase()))
  const missing = []
  const nameRe = new RegExp(String.raw`table\s+(?:if\s+not\s+exists\s+)?(?:only\s+)?` + TABLE_REF, 'i')
  for (const m of broad) {
    const snippet = clean.slice(m.index, m.index + 200)
    const named = snippet.match(nameRe)
    const name = named ? named[1].toLowerCase() : null
    if (!name || !parsed.has(name)) {
      missing.push(snippet.split('\n')[0].trim().slice(0, 100))
    }
  }
  return { found: broad.length, parsed: parsed.size, missing }
}

/**
 * 从 schema.sql 解析出「必须有」的表与列。
 *
 * 关键点：
 * - 先做**词法级**注释剥离（字符串 / dollar-quote / 标识符内部不剥）
 * - 建表体用**括号配平**截取，不依赖 `);` 的缩进（评审实测：缩进一变 84 列会掉到 5 列）
 * - 建表体按**顶层逗号**切片段，多行约束不会被当成列
 * - 配平循环**跳过字符串与双引号标识符**：`v text default ')'` 会让配平提前结束
 * - DDL 正则**不写死一种拼写**（见 CREATE_HEAD_RE / ALTER_ADD_RE 注释）
 */
export function parseSchema(sql) {
  const clean = stripSqlComments(sql)
  // ⚠️ `locate` 是「连字符串字面量一起遮成空白」的版本，**只用来跑 DDL 定位正则**。
  //
  // 为什么必须遮：`stripSqlComments` 保留了字符串内容（`parseSchema` 截取建表体时
  // 需要看到 `default '...'` 的原文）。但保留内容会让**字符串里出现的 DDL 关键字**
  // 被正则当成真语句。第十四轮自查实测：
  //   `create table public.t (note text default 'alter table public.fake add column zz int;');`
  //   → 旧实现解析出幻影列 `fake.zz`（假红：会去探测一个不存在的表）
  // 遮掉字符串后，`create table` / `alter table` 只会在真正的位置被匹配到。
  //
  // `blankSqlStrings` 保持**字符长度与换行完全一致**（逐字符替换成空格），
  // 所以 `locate` 上的 match.index 可以直接用来索引 `clean` / 原始 `sql`。
  const locate = blankSqlStrings(sql)

  const tables = []
  const declared = []

  let h
  CREATE_HEAD_RE.lastIndex = 0
  while ((h = CREATE_HEAD_RE.exec(locate)) !== null) {
    const table = h[1]
    tables.push(table)
    const bodyStart = h.index + h[0].length
    let depth = 1
    let i = bodyStart
    while (i < clean.length && depth > 0) {
      const ch = clean[i]
      // 字符串/双引号标识符里的括号不参与配平：
      // 评审实测 `v text default ')'` 会让配平提前结束，后面的列全丢。
      if (ch === "'") {
        const escapeString = isEscapeString(clean, i)
        let j = i + 1
        while (j < clean.length) {
          // 只有 E'...' 才把 \ 当转义（standard_conforming_strings=on）
          if (escapeString && clean[j] === '\\') {
            j += 2
            continue
          }
          if (clean[j] === "'") {
            if (clean[j + 1] === "'") {
              j += 2
              continue
            }
            j++
            break
          }
          j++
        }
        i = j
        continue
      }
      if (ch === '"') {
        let j = i + 1
        while (j < clean.length) {
          if (clean[j] === '"') {
            if (clean[j + 1] === '"') {
              j += 2
              continue
            }
            j++
            break
          }
          j++
        }
        i = j
        continue
      }
      if (ch === '(') depth++
      else if (ch === ')') depth--
      i++
    }
    const body = clean.slice(bodyStart, i - 1)
    for (const rawPart of splitTopLevel(body)) {
      const part = rawPart.trim()
      if (!part) continue
      // 列定义形如 `col_name type ...`；跳过约束声明
      // 标识符可以是双引号包裹的任意内容（`"a,b" int`），先试带引号的，再试裸的
      const c = part.match(/^"((?:[^"]|"")*)"\s+/) || part.match(/^(\w+)\s+/)
      if (!c) continue
      // 双引号标识符里的 "" 是转义的双引号，必须归一成一个（`"a""b"` 是列名 a"b）
      const columnName = c[1].replace(/""/g, '"')
      const name = columnName.toLowerCase()
      if (CONSTRAINT_KEYWORDS.has(name)) continue
      declared.push({ table, column: columnName })
    }
  }

  // alter table ... add [column]
  //
  // ⚠️ 分两阶段：先定位每条 alter 语句的头（拿到表名 + 语句范围），
  // 再在语句范围内逐个扫 `add`。一条语句可以有多个 add：
  //   `alter table public.t add column a int, add column b int;`
  // 单阶段正则会只解析出 a、静默丢掉 b（第十四轮自查实测）。
  const altered = []
  ALTER_HEAD_RE.lastIndex = 0
  let h2
  const alterHeads = []
  while ((h2 = ALTER_HEAD_RE.exec(locate)) !== null) {
    alterHeads.push({ table: h2[1], start: h2.index + h2[0].length })
  }
  for (let k = 0; k < alterHeads.length; k++) {
    const head = alterHeads[k]
    // 语句体：从表名之后到下一个分号（或下一条 alter 头之前）
    const stmtEnd = (() => {
      let j = head.start
      while (j < locate.length && locate[j] !== ';') j++
      return j
    })()
    // ⚠️ 语句体必须从 `locate`（字符串已遮成空白）切片，不能用 `clean`：
    // `clean` 保留了 `default 'add column zz int'` 这类字符串内容，
    // 扫描时会把它当成真的 add 子句 → 幻影列（第十四轮自查实测）。
    const body = locate.slice(head.start, stmtEnd)
    ALTER_BODY_ADD_RE.lastIndex = 0
    let a
    while ((a = ALTER_BODY_ADD_RE.exec(body)) !== null) {
      const table = head.table
      // 捕获组 1 = 带引号列名，2 = 裸列名；若两者都没匹配到，说明 `add` 后面直接是左括号
      // （`add column (a int, b text)`），此时正则靠 `(?=\()` 零宽断言停住。
      const quoted = a[1]
      const bare = a[2]
      if (quoted === undefined && bare === undefined) {
        // 括号多列：从 `add` 之后找左括号，按**配平**提取（不能用 [^)]*，
        // 否则 `a numeric(4,1)` 会在类型括号的第一个 ) 处截断，后面的列静默丢失）
        const parenStart = body.indexOf('(', a.index)
        const inner = parenStart < 0 ? null : matchBalancedParens(body, parenStart)
        if (inner === null) continue
        for (const rawPart of splitTopLevel(inner)) {
          const part = rawPart.trim()
          if (!part) continue
          const c = part.match(/^"((?:[^"]|"")*)"/) || part.match(/^([A-Za-z_][A-Za-z0-9_]*)/)
          if (!c) continue
          const columnName = c[1].replace(/""/g, '"')
          const name = columnName.toLowerCase()
          if (CONSTRAINT_KEYWORDS.has(name)) continue
          altered.push({ table, column: columnName })
        }
      } else {
        const column = quoted !== undefined ? quoted.replace(/""/g, '"') : bare
        // ⚠️ 必须排除约束关键字：`alter table x add constraint ...` 里的
        // `constraint` 是裸标识符，不排除就会造出幻影列 `x.constraint`
        // （真实 schema.sql 第 129 行就有这么一句）。
        if (column && !CONSTRAINT_KEYWORDS.has(column.toLowerCase())) {
          altered.push({ table, column })
        }
      }
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

/**
 * 带超时的探测。
 *
 * ⚠️ 列名必须 `encodeURIComponent`：第十二轮评审自查发现，若列名含 `&`，
 * `select=a&b` 会让 PostgREST 只看到 `select=a`（`b` 变成独立查询参数），
 * 探测对象就错了。当前 84 个列名都是 `[A-Za-z_][A-Za-z0-9_]*` 所以不可利用，
 * 但这是**预防性加固** —— 别等哪天加了带特殊字符的列才发现。
 */
export async function probe(url, anon, table, column, timeoutMs = PROBE_TIMEOUT_MS) {
  const q = `${url}/rest/v1/${table}?select=${encodeURIComponent(column)}&limit=0`
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
export function classify(r) {
  if (r.ok === true) return 'ok'
  if (r.ok === null) return 'unknown'
  if (r.code === 'PGRST205' || r.code === '42P01') return 'missing-table'
  if (r.code === '42703') return 'missing-column'
  // 其它一律无法判定：401/403（anon key 失效）、400 语法错、500 服务端错都算。
  // ⚠️ 不要给 401/403 单独开分支返回 'unknown' —— 和这里的默认返回值完全一样，
  // 属于死代码，只会让读代码的人误以为它有专门处理（第十二轮评审·轻微）。
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
 *   code 0 = 一致；1 = 缺结构 / 无法判定 / 配置问题 / SQL 语法坏
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

  // ⚠️ 语法自检必须在解析之前：未闭合引号会让 parseSchema 静默丢列，
  // 拿残缺结果报「结构一致」就是假绿（第十二轮评审·轻微-2）。
  const sqlProblems = findUnterminatedSql(sql)
  if (sqlProblems.length) {
    err('❌ schema.sql 语法有问题，解析结果不可信，不能报告「结构一致」：')
    for (const p of sqlProblems) err('   - ' + p)
    return { code: 1, log, missing: [], unknown: [], okCount: 0 }
  }

  const { tables, columns } = parseSchema(sql)
  const uniqueCols = dedupeColumns(columns)

  // ⚠️ DDL 普查（第十二轮评审·严重-1）：parseSchema 是「尽力解析」，遇到不认识的
  // DDL 拼写会静默跳过 —— 探测项变少 → 生产库真缺那张表也不报（假绿，正是第十一轮
  // 事故的形态），而且 schema-baseline 的期望值也来自同一个 parseSchema，两边同时
  // 少仍相等。所以这里用一条**不依赖 parseSchema 的普查**兜底：文件里有几条
  // create table，就必须解析出几张表；对不上就说明有 DDL 没被解析，结果不可信。
  const census = ddlCensus(sql, tables)
  if (census.missing.length) {
    err('❌ 有 create table 语句没被解析出来，解析结果不可信，不能报告「结构一致」：')
    for (const frag of census.missing) err('   - 未识别：' + frag)
    err(`   （文件里 create table 出现 ${census.found} 次，只解析出 ${census.parsed} 张表）`)
    return { code: 1, log, missing: [], unknown: [], okCount: 0 }
  }

  // 期望探测数 = 表探测 + 列探测。失败时把它打出来，读者才不用自己数
  // 「84 个列探测全没了」这件事（第十四轮评审 Q2）。
  const expectedProbes = tables.length + uniqueCols.length
  out(`schema.sql 声明：${tables.length} 张表、${uniqueCols.length} 个列（共 ${expectedProbes} 项探测）`)
  out('')

  if (tables.length === 0) {
    err('❌ 没从 schema.sql 解析出任何表 —— 解析器坏了，不能当作「结构一致」')
    return { code: 1, log, missing: [], unknown: [], okCount: 0 }
  }

  const missing = []
  const unknown = []
  let okCount = 0

  // 记录每张表的探测结果，供列探测的矛盾态诊断使用（见下方 missing-table 分支）
  const tableProbe = new Map()
  for (const t of tables) {
    const r = await probeFn(env.url, env.anon, t, '*', probeTimeoutMs)
    const c = classify(r)
    tableProbe.set(t, { kind: c, status: r.status, code: r.code ?? r.error })
    if (c === 'ok') okCount++
    else if (c === 'missing-table') missing.push(`表 ${t} 不存在（HTTP ${r.status} ${r.code}）`)
    else unknown.push(`${t}（${r.status ?? ''} ${r.code ?? r.error ?? ''}）`)
  }

  for (const { table, column } of uniqueCols) {
    const r = await probeFn(env.url, env.anon, table, column, probeTimeoutMs)
    const c = classify(r)
    if (c === 'ok') okCount++
    else if (c === 'missing-column') missing.push(`列 ${table}.${column} 不存在（HTTP ${r.status} 42703）`)
    else if (c === 'missing-table') {
      // ⚠️ 这里**不能** `continue`（第十四轮自查修）。
      // 列探测报「表不存在」（PGRST205/42P01），静默跳过会让该表所有列探测**全部消失**
      // 而 okCount 大幅下降，脚本照样报「一致」并 exit 0
      // （实测：表 ok + 列全 PGRST205 → code 0 / okCount 13 / 0 项列探测 → 假绿）。
      // 必须算「无法判定」，让下面的 unknown 分支 exit 1。
      //
      // 文案按表探测的**真实**结果措辞（第十四轮评审·轻微-1）：
      // 表探测也可能是 401/404（不是「成功」），说成「表探测成功」就是撒谎。
      const tp = tableProbe.get(table)
      const tableDesc =
        tp && tp.kind === 'ok'
          ? '表探测成功'
          : `表探测 ${tp ? `${tp.kind} HTTP ${tp.status ?? ''} ${tp.code ?? ''}` : '缺失记录'}`
      unknown.push(`${table}.${column}（${tableDesc}，但列探测报缺表：HTTP ${r.status ?? ''} ${r.code ?? r.error ?? ''}）`)
    } else unknown.push(`${table}.${column}（${r.status ?? ''} ${r.code ?? r.error ?? ''}）`)
  }

  if (missing.length) {
    err('❌ 生产库结构未同步（schema.sql 有、库里没有）：')
    for (const m of missing) err('   - ' + m)
    err('')
    err(`期望 ${expectedProbes} 项探测，实际成功 ${okCount} 项，失败 ${missing.length + unknown.length} 项`)
    err('修法：npm run apply:schema -- ' + expectedRef + ' <PROD_PAT>')
    err('（schema.sql 是幂等的，重复执行不清数据）')
    return { code: 1, log, missing, unknown, okCount }
  }

  // ⚠️ 无法判定也算失败：全 401 / 全超时时报 ✅ 是假绿
  if (unknown.length) {
    err('❌ 有探测无法判定，不能确认结构一致：')
    for (const u of unknown) err('   - ' + u)
    err('')
    err(`期望 ${expectedProbes} 项探测，实际成功 ${okCount} 项，无法判定 ${unknown.length} 项`)
    err('')
    err('常见原因：anon key 无效、网络不通、RLS 拦住了匿名读。')
    err('若**只有列探测**报缺表而表探测成功：多为 PostgREST schema cache 陈旧')
    err('（例如表在两轮探测之间被删、或多实例缓存分歧），可重试或刷新 schema cache。')
    err('结构检查必须能真正读到库，否则这道防线等于没有。')
    return { code: 1, log, missing, unknown, okCount }
  }

  // 注意：这里**故意没有** `okCount === 0` 的分支 ——
  // tables.length === 0 已在上面拦掉，而 uniqueCols 为空也不影响
  // 「表探测成功即结构一致」。保留那个分支只会制造一段永远走不到的代码。

  out(`✅ 生产库结构与 schema.sql 一致（${okCount} 项探测全部通过）`)
  return { code: 0, log, missing, unknown, okCount }
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('check-prod-schema.mjs')
if (isMain) {
  const r = await runCheck()
  process.exit(r.code)
}

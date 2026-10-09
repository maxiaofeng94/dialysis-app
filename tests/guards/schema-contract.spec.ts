// @vitest-environment node
/**
 * 静态守卫 · 数据库结构与代码映射一致性
 *
 * AGENTS.md 的硬约定：「数据库结构变更要同步四处：supabase/schema.sql、src/types.ts、
 * cloudRepository 映射、localRepository」。漏掉任何一处，编译器都发现不了 ——
 * 典型的炸法：加了新字段但没写 schema（线上写库直接 400）、或者 schema 加了列却没写映射（字段永远读不出来）。
 *
 * 本文件用**文本解析 + 运行时实例检查**把这条约定固化：
 * 1. 每个 `xxxToRow` 写出的键，都必须是目标表的列（挡住「加了新字段忘了写 schema」）；
 * 2. 每个 `xxxFromRow` 读出的键集合，必须与 `src/types.ts` 对应接口的字段完全一致；
 * 3. `Repository` 接口的方法集合，必须被 localRepository / cloudRepository / cachedCloudRepository 全部实现
 *    （运行时 typeof 检查 + 源码解析，两路互证）；
 * 4. cachedRepository 的缓存 key 前缀与 AGENTS.md 的约定一致。
 *
 * 解析器自带「自检用例」（数量下界 + 抽样关键字）：解析跟不上了要报错，而不是静默通过。
 * 离线、不联网、无凭据。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { localRepository } from '../../src/repo/localRepository'
import { cloudRepository } from '../../src/lib/cloudRepository'
import { cachedCloudRepository } from '../../src/repo/cachedRepository'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function read(rel: string): string {
  return readFileSync(`${ROOT}/${rel}`, 'utf8')
}

/** 去掉注释（保留换行，避免把说明文字当成代码解析） */
function stripJsComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function stripSqlComments(sql: string): string {
  return sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
}

/** 从 openIdx 处的 `{` 开始做括号配平，返回内部文本（不含最外层大括号） */
function matchBlock(src: string, openIdx: number): string | null {
  if (src[openIdx] !== '{') return null
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return src.slice(openIdx + 1, i)
    }
  }
  return null
}

/** 按 header 正则定位，再取其后的 `{ … }` 块内容 */
function blockAfter(src: string, header: RegExp): string | null {
  const m = header.exec(src)
  if (!m) return null
  const open = src.indexOf('{', m.index + m[0].length - 1)
  if (open < 0) return null
  return matchBlock(src, open)
}

/** 取对象字面量第一层的键名（键值对形态：`k: v`） */
function topLevelKeys(body: string): string[] {
  const keys: string[] = []
  let depth = 0
  for (const raw of body.split('\n')) {
    const line = raw.replace(/(^|[^:])\/\/.*$/, '$1')
    if (depth === 0) {
      const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line)
      if (m) keys.push(m[1])
    }
    depth += count(line, /[{[]/g) - count(line, /[}\]]/g)
  }
  return keys
}

/** 取对象/类体第一层的成员名（方法简写 `name(` 与属性 `name:` 都算） */
function topLevelMembers(body: string): string[] {
  const names: string[] = []
  let depth = 0
  for (const raw of body.split('\n')) {
    const line = raw.replace(/(^|[^:])\/\/.*$/, '$1')
    if (depth === 0) {
      const m = /^\s*(?:(?:public|private|protected|static|readonly)\s+)*(?:async\s+)?([A-Za-z_$][\w$]*)\s*[(:]/.exec(line)
      if (m) names.push(m[1])
    }
    depth += count(line, /[{[]/g) - count(line, /[}\]]/g)
  }
  return names
}

/** 类体第一层的「非私有」方法名（TS 的 private 只是编译期修饰，这里显式排除） */
function classPublicMethods(body: string): string[] {
  const names: string[] = []
  let depth = 0
  for (const raw of body.split('\n')) {
    const line = raw.replace(/(^|[^:])\/\/.*$/, '$1')
    if (depth === 0) {
      const m = /^\s*(?:(public|private|protected|static|readonly)\s+)*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(line)
      if (m) {
        const modifier = m[1] ?? ''
        const name = m[2]
        if (modifier !== 'private' && modifier !== 'protected' && name !== 'constructor') names.push(name)
      }
    }
    depth += count(line, /[{[]/g) - count(line, /[}\]]/g)
  }
  return names
}

function count(s: string, re: RegExp): number {
  return (s.match(re) ?? []).length
}

/** 函数体（`function name(...) { … }` 的内部文本） */
function functionBody(src: string, name: string): string | null {
  const re = new RegExp(`\\bfunction\\s+${name}\\s*\\(`)
  const m = re.exec(src)
  if (!m) return null
  const open = src.indexOf('{', m.index + m[0].length)
  if (open < 0) return null
  return matchBlock(src, open)
}

/** 映射函数体里 `return { … }` 的键名 */
function returnObjectKeys(src: string, fnName: string): string[] {
  const body = functionBody(src, fnName)
  if (body === null) return []
  const ret = /\breturn\s*\{/.exec(body)
  if (!ret) return []
  const inner = matchBlock(body, body.indexOf('{', ret.index))
  return inner === null ? [] : topLevelKeys(inner)
}

/** 比对两个集合，不一致时抛出带「缺什么/多什么」的中文错误 */
function assertSameSet(actual: string[], expected: string[], contract: string): void {
  const a = [...new Set(actual)].sort()
  const e = [...new Set(expected)].sort()
  if (a.join('|') === e.join('|')) return
  const missing = e.filter((x) => !a.includes(x))
  const extra = a.filter((x) => !e.includes(x))
  throw new Error(
    `${contract} 不一致：\n` +
      (missing.length ? `  缺少：${missing.join(', ')}\n` : '') +
      (extra.length ? `  多余：${extra.join(', ')}\n` : '') +
      '修法：按 AGENTS.md 第四节同步四处（schema.sql / src/types.ts / cloudRepository 映射 / localRepository）',
  )
}

// ------------------------------------------------------------------
// schema.sql：表 → 列
// ------------------------------------------------------------------

/** 按顶层逗号切分列定义（忽略 `references t(a, b)`、`unique (a, b)` 里的逗号） */
function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of body) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  parts.push(cur)
  return parts
}

const CONSTRAINT_START = /^(primary\s+key|unique|constraint|foreign\s+key|check|exclude|like)\b/i

/** 解析 `create table if not exists public.X ( … );` 的列名，并补上 `add column if not exists` 的列 */
function parseSchemaTables(sql: string): Map<string, { columns: Set<string>; body: string }> {
  const clean = stripSqlComments(sql)
  const tables = new Map<string, { columns: Set<string>; body: string }>()

  const tableRe = /create\s+table\s+if\s+not\s+exists\s+public\.(\w+)\s*\(([\s\S]*?)\n\);/g
  let m: RegExpExecArray | null
  while ((m = tableRe.exec(clean)) !== null) {
    const [, name, body] = m
    const columns = new Set<string>()
    for (const raw of splitTopLevelCommas(body)) {
      const def = raw.trim()
      if (!def || CONSTRAINT_START.test(def)) continue
      const col = /^"?([A-Za-z_][\w]*)"?\s+/.exec(def)
      if (col) columns.add(col[1])
    }
    tables.set(name, { columns, body })
  }

  const addRe = /alter\s+table\s+public\.(\w+)\s+add\s+column\s+if\s+not\s+exists\s+([A-Za-z_][\w]*)/gi
  while ((m = addRe.exec(clean)) !== null) {
    const [, table, column] = m
    tables.get(table)?.columns.add(column)
  }

  return tables
}

// ------------------------------------------------------------------
// src/types.ts：接口字段
// ------------------------------------------------------------------

function interfaceFields(src: string, name: string): string[] {
  const body = blockAfter(src, new RegExp(`export\\s+interface\\s+${name}\\b[^{]*\\{`))
  if (body === null) return []
  const fields: string[] = []
  for (const raw of body.split('\n')) {
    const m = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(raw)
    if (m) fields.push(m[1])
  }
  return fields
}

// ------------------------------------------------------------------

const schemaTables = parseSchemaTables(read('supabase/schema.sql'))
const cloudSrc = stripJsComments(read('src/lib/cloudRepository.ts'))
const typesSrc = stripJsComments(read('src/types.ts'))
const repoIfaceSrc = stripJsComments(read('src/repo/repository.ts'))
const localSrc = stripJsComments(read('src/repo/localRepository.ts'))
const cachedSrc = stripJsComments(read('src/repo/cachedRepository.ts'))
const agentsMd = read('AGENTS.md')

/** xxxToRow → 目标表（写库方向：键必须是 DB 列名） */
const TO_ROW: Array<{ fn: string; table: string }> = [
  { fn: 'sessionToRow', table: 'sessions' },
  { fn: 'patientToRow', table: 'patients' },
  { fn: 'dryWeightToRow', table: 'dry_weights' },
  { fn: 'bpToRow', table: 'blood_pressures' },
  { fn: 'bgToRow', table: 'blood_glucoses' },
  { fn: 'bloodFlowToRow', table: 'blood_flows' },
  { fn: 'reactionToRow', table: 'adverse_reactions' },
]

/** xxxFromRow → src/types.ts 的接口（读库方向：键集合必须与领域对象一致） */
const FROM_ROW: Array<{ fn: string; type: string }> = [
  { fn: 'sessionFromRow', type: 'DialysisSession' },
  { fn: 'patientFromRow', type: 'Patient' },
  { fn: 'dryWeightFromRow', type: 'DryWeight' },
  { fn: 'bpFromRow', type: 'BloodPressure' },
  { fn: 'bgFromRow', type: 'BloodGlucose' },
  { fn: 'bloodFlowFromRow', type: 'BloodFlow' },
  { fn: 'reactionFromRow', type: 'AdverseReaction' },
]

const repositoryMethods: string[] = (() => {
  const body = blockAfter(repoIfaceSrc, /export\s+interface\s+Repository\b[^{]*\{/)
  if (body === null) return []
  return body
    .split('\n')
    .map((l) => /^\s*([A-Za-z_$][\w$]*)\s*\(/.exec(l)?.[1])
    .filter((x): x is string => Boolean(x))
})()

describe('静态守卫 · 数据库结构与代码映射一致性', () => {
  describe('解析器自检（解析跟不上时必须报错，而不是静默通过）', () => {
    it('schema.sql 解析出了预期的表与列', () => {
      const names = [...schemaTables.keys()].sort()
      for (const t of ['users', 'patients', 'dry_weights', 'sessions', 'blood_pressures', 'blood_glucoses', 'blood_flows', 'adverse_reactions', 'patient_members', 'admins', 'rate_limits']) {
        expect(names, `schema.sql 没解析到表 ${t}（解析正则要跟着改）`).toContain(t)
      }
      // 抽样校验列解析没被约束行干扰
      expect([...schemaTables.get('sessions')!.columns]).toEqual(
        expect.arrayContaining(['id', 'patient_id', 'date', 'pre_weight_measured', 'operator_id', 'doctor_uf', 'abort_tags']),
      )
      expect(schemaTables.get('rate_limits')!.columns.has('window_start')).toBe(true)
      // 约束行不能被当成列名
      expect(schemaTables.get('patient_members')!.columns.has('unique')).toBe(false)
      expect(schemaTables.get('rate_limits')!.columns.has('primary')).toBe(false)
    })

    it('cloudRepository 的映射函数与 Repository 接口都解析出来了', () => {
      for (const { fn } of TO_ROW) {
        expect(returnObjectKeys(cloudSrc, fn).length, `${fn} 没解析出任何键`).toBeGreaterThan(2)
      }
      for (const { fn } of FROM_ROW) {
        expect(returnObjectKeys(cloudSrc, fn).length, `${fn} 没解析出任何键`).toBeGreaterThan(2)
      }
      expect(repositoryMethods.length, 'Repository 接口没解析出方法').toBeGreaterThan(15)
    })
  })

  describe('写库方向：xxxToRow 的键必须是目标表的列', () => {
    it.each(TO_ROW)('$fn 写出的每个键都在 $table 表里', ({ fn, table }) => {
      const info = schemaTables.get(table)
      expect(info, `schema.sql 里找不到表 ${table}`).toBeDefined()

      const keys = returnObjectKeys(cloudSrc, fn)
      const unknown = keys.filter((k) => !info!.columns.has(k))

      expect(
        unknown,
        `${fn} 写了 ${table} 表不存在的列：[${unknown.join(', ')}]\n` +
          `  该表现有列：${[...info!.columns].join(', ')}\n` +
          '修法：在 supabase/schema.sql 里补 `alter table public.' +
          table +
          ' add column if not exists <列> <类型>;`（脚本必须保持幂等），再重跑一次 schema.sql',
      ).toEqual([])
    })
  })

  describe('读库方向：xxxFromRow 的键必须与领域对象完全一致', () => {
    it.each(FROM_ROW)('$fn 与接口 $type 字段完全一致', ({ fn, type }) => {
      const fromRow = returnObjectKeys(cloudSrc, fn)
      const fields = interfaceFields(typesSrc, type)
      expect(fields.length, `src/types.ts 里 ${type} 接口没解析出字段`).toBeGreaterThan(2)
      assertSameSet(fromRow, fields, `${fn} 读出的键 vs src/types.ts 的 ${type}`)
    })

    it('七个领域对象的映射都两两对应（无遗漏、无重复）', () => {
      const fromRowNames = FROM_ROW.map((x) => x.fn)
      expect(new Set(fromRowNames).size).toBe(fromRowNames.length)
      for (const { fn } of FROM_ROW) {
        expect(cloudSrc.includes(`function ${fn}(`), `cloudRepository 里没有 ${fn}`).toBe(true)
      }
      for (const { fn } of TO_ROW) {
        expect(cloudSrc.includes(`function ${fn}(`), `cloudRepository 里没有 ${fn}`).toBe(true)
      }
    })
  })

  describe('Repository 接口与三个实现的契约', () => {
    it('localRepository 实现了接口的每个方法（运行时 typeof）', () => {
      const missing = repositoryMethods.filter(
        (m) => typeof (localRepository as unknown as Record<string, unknown>)[m] !== 'function',
      )
      expect(
        missing,
        `localRepository 缺方法：[${missing.join(', ')}]\n` +
          '修法：本地单机模式与云端模式必须共用同一套 Repository 接口；新方法要在 localRepository.ts 里补齐实现',
      ).toEqual([])
    })

    it('cloudRepository 实现了接口的每个方法（运行时 typeof）', () => {
      const missing = repositoryMethods.filter(
        (m) => typeof (cloudRepository as unknown as Record<string, unknown>)[m] !== 'function',
      )
      expect(
        missing,
        `cloudRepository 缺方法：[${missing.join(', ')}]\n修法：在 src/lib/cloudRepository.ts 的 CloudRepository 里补实现`,
      ).toEqual([])
    })

    it('cachedCloudRepository 实现了接口的每个方法（运行时 typeof）', () => {
      const missing = repositoryMethods.filter(
        (m) => typeof (cachedCloudRepository as unknown as Record<string, unknown>)[m] !== 'function',
      )
      expect(
        missing,
        `cachedCloudRepository 缺方法：[${missing.join(', ')}]\n` +
          '修法：缓存包装层要把每个方法都显式转发/包装（漏掉的方法在云端模式下会直接 undefined 崩）',
      ).toEqual([])
    })

    it('三个实现的方法集合与接口一一对应（源码解析，多一个少一个都算漂移）', () => {
      const localBody = blockAfter(localSrc, /class\s+LocalRepository\b[^{]*\{/)
      const cloudBody = blockAfter(cloudSrc, /class\s+CloudRepository\b[^{]*\{/)
      const cachedBody = blockAfter(cachedSrc, /export\s+const\s+cachedCloudRepository\b[^{]*\{/)

      expect(localBody, 'localRepository.ts 里找不到 class LocalRepository').not.toBeNull()
      expect(cloudBody, 'cloudRepository.ts 里找不到 class CloudRepository').not.toBeNull()
      expect(cachedBody, 'cachedRepository.ts 里找不到 cachedCloudRepository 对象').not.toBeNull()

      assertSameSet(classPublicMethods(localBody!), repositoryMethods, 'localRepository 方法 vs Repository 接口')
      assertSameSet(classPublicMethods(cloudBody!), repositoryMethods, 'cloudRepository 方法 vs Repository 接口')
      assertSameSet(topLevelMembers(cachedBody!), repositoryMethods, 'cachedCloudRepository 成员 vs Repository 接口')
    })
  })

  describe('缓存 key 前缀与 AGENTS.md 的约定一致', () => {
    /** AGENTS.md 里点名的 8 个前缀 */
    const EXPECTED_PREFIXES: Record<string, string> = {
      patient: 'patient:',
      dryWeights: 'dryWeights:',
      session: 'session:',
      sessions: 'sessions:',
      bps: 'bps:',
      bgs: 'bgs:',
      bfs: 'bfs:',
      ars: 'ars:',
    }

    it('cachedRepository 的 K 表就是这 8 个前缀', () => {
      const body = blockAfter(cachedSrc, /const\s+K\s*=\s*\{/)
      expect(body, 'cachedRepository.ts 里找不到缓存 key 表 K').not.toBeNull()

      const actual: Record<string, string> = {}
      for (const line of body!.split('\n')) {
        const m = /^\s*([A-Za-z_$][\w$]*)\s*:.*?`([A-Za-z]+):\$\{/.exec(line)
        if (m) actual[m[1]] = `${m[2]}:`
      }

      assertSameSet(Object.keys(actual), Object.keys(EXPECTED_PREFIXES), 'cachedRepository 的缓存 key 名')
      const wrong = Object.keys(EXPECTED_PREFIXES).filter((k) => actual[k] !== EXPECTED_PREFIXES[k])
      expect(
        wrong.map((k) => `${k} → ${actual[k] ?? '（缺失）'}（应为 ${EXPECTED_PREFIXES[k]}）`),
        '缓存 key 前缀被改了：写操作按前缀失效缓存（removeFromListsById / cacheClear）会全部失效，页面出现脏数据',
      ).toEqual([])
    })

    it('按前缀批量失效用的字面前缀都在 K 表里（不许另起炉灶）', () => {
      const prefixes = Object.values(EXPECTED_PREFIXES)
      const literals: string[] = []
      const re = /removeFromListsById\([^,]+,\s*\[([^\]]*)\]/g
      let m: RegExpExecArray | null
      while ((m = re.exec(cachedSrc)) !== null) {
        for (const raw of m[1].split(',')) {
          const lit = /['"]([^'"]+)['"]/.exec(raw)
          if (lit) literals.push(lit[1])
        }
      }
      expect(literals.length, '没解析到 removeFromListsById 的前缀实参（解析要跟着改）').toBeGreaterThan(0)
      const unknown = literals.filter((p) => !prefixes.includes(p))
      expect(
        unknown,
        `这些前缀不在 K 表里：[${unknown.join(', ')}] —— 少写一个冒号或拼错，缓存就永远清不掉（换账号看到上一个账号的数据）`,
      ).toEqual([])
    })

    it('AGENTS.md 的缓存 key 约定与代码同步', () => {
      const missing = Object.values(EXPECTED_PREFIXES).filter((p) => !agentsMd.includes(p))
      expect(
        missing,
        `AGENTS.md 的「缓存 key 约定」少了：[${missing.join(', ')}]（改 key 时文档与代码要一起改）`,
      ).toEqual([])
    })
  })
})

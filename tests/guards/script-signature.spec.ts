/**
 * 测试代码与脚本导出的**签名一致性**守卫（第十二轮独立评审·轻微-1）。
 *
 * ⭐ 为什么需要：
 * `tsconfig.app.json` 只含 `src/**`，`tsconfig.node.json` 只含两个 vite config，
 * `tsconfig.json` 的 `files: []` ⇒ `vue-tsc -b` **从不检查 `tests/`**。
 * 于是 `scripts/check-prod-schema.mjs` 的 `classify(r, kind)` 改成 `classify(r)` 之后，
 * `tests/` 里 9 处仍在传两个参数，JS 不报错、测试照样绿 —— 这种「测试代码与实现脱节」
 * 会静默累积。
 *
 * 试过把 `tests/` 挂进 `vue-tsc -b`（新增 `tsconfig.vitest.json`），但 tests 里已有
 * **144 个既存类型错误**（大多是 `implicit any` / `possibly undefined`），
 * 挂进去会直接卡住 `npm run build`。所以改成这条窄守卫：只检查「实参个数」这一件事。
 *
 * ⚠️ 不能用 `fn.length` 当形参个数：`.length` 只数「第一个默认值之前」的形参，
 * `probe(url, anon, table, column, timeoutMs = X)` 的 `.length` 是 4 但合法实参是 5 个。
 * 所以这里直接解析源码里的形参列表，区分「固定形参」与「有默认值/剩余参数」。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error 脚本是 .mjs，没有类型声明
import * as schemaScript from '../../scripts/check-prod-schema.mjs'

const SCRIPT_PATH = 'scripts/check-prod-schema.mjs'

const SCRIPT_FNS = [
  'parseSchema',
  'dedupeColumns',
  'stripSqlComments',
  'splitTopLevel',
  'findUnterminatedSql',
  'loadEnv',
  'refFromUrl',
  'assertProdTarget',
  'classify',
  'probe',
  'runCheck',
] as const

/** 递归收集 tests/ 下的 .ts 文件 */
function collectTestFiles(dir = 'tests'): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...collectTestFiles(p))
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** 剥掉 JS/TS 注释（保留字符串内容会误伤，但这里只用来定位函数声明与调用，够用） */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      out += ch
      i++
      while (i < src.length) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '')
          i += 2
          continue
        }
        out += src[i]
        if (src[i] === quote) {
          i++
          break
        }
        i++
      }
      continue
    }
    out += ch
    i++
  }
  return out
}

/**
 * 解析函数声明里「固定形参个数」与「是否可变长」。
 * 返回 null 表示解析失败（调用方跳过）。
 */
function analyzeParams(src: string, fn: string): { fixed: number; variadic: boolean } | null {
  const re = new RegExp(`function\\s+${fn}\\s*\\(([^)]*)\\)`)
  const m = src.match(re)
  if (!m) return null
  const raw = m[1].trim()
  if (raw === '') return { fixed: 0, variadic: false }
  // 按顶层逗号切分（形参里可能有解构 `{ a, b }` 或默认值 `= [1,2]`）
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of raw) {
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  const cleaned = parts.map((p) => p.trim()).filter(Boolean)
  const variadic = cleaned.some((p) => p.startsWith('...'))
  const withDefault = cleaned.some((p) => p.includes('='))
  // 有默认值或剩余参数 ⇒ 实参个数上不封顶
  return { fixed: withDefault || variadic ? Infinity : cleaned.length, variadic }
}

/** 统计一次调用的实参个数；无法判定时返回 null */
function countArgs(src: string, openParenIdx: number): number | null {
  let depth = 0
  let args = 0
  let hasContent = false
  for (let i = openParenIdx; i < src.length; i++) {
    const ch = src[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      // 跳过字符串，避免里面的逗号/括号干扰
      const quote = ch
      i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++
        i++
      }
      if (depth === 1) hasContent = true
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++
      if (depth > 1) hasContent = true
      continue
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      if (depth === 0) return hasContent ? args + 1 : 0
      continue
    }
    if (depth === 1) {
      if (ch === ',') {
        args++
        hasContent = true
      } else if (!/\s/.test(ch)) {
        hasContent = true
      }
    }
  }
  return null
}

describe('测试调用脚本导出函数时，实参个数必须与签名一致（轻微-1）', () => {
  const scriptSrc = stripComments(readFileSync(SCRIPT_PATH, 'utf8'))
  const files = collectTestFiles()

  it('不得出现「形参已删、测试仍在传」的多余实参', () => {
    const problems: string[] = []

    for (const fn of SCRIPT_FNS) {
      expect(typeof (schemaScript as any)[fn], `${fn} 必须导出`).toBe('function')
      const sig = analyzeParams(scriptSrc, fn)
      expect(sig, `必须在脚本里找到 function ${fn}(...)`).toBeTruthy()
      if (!sig || sig.fixed === Infinity) continue

      const callRe = new RegExp(`\\b${fn}\\s*\\(`, 'g')
      for (const file of files) {
        // 跳过本文件（它自己的注释/正则里会出现函数名）
        if (file.endsWith('script-signature.spec.ts')) continue
        const body = stripComments(readFileSync(file, 'utf8'))
        // 跳过 import 语句
        const noImports = body.replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"]\s*$/gm, '')
        let m: RegExpExecArray | null
        while ((m = callRe.exec(noImports))) {
          const openIdx = m.index + m[0].length - 1
          const actual = countArgs(noImports, openIdx)
          if (actual == null) continue
          if (actual > sig.fixed) {
            const line = noImports.slice(0, m.index).split('\n').length
            problems.push(
              `${file}:${line} 调 ${fn}() 传了 ${actual} 个实参，但签名只有 ${sig.fixed} 个`,
            )
          }
        }
      }
    }

    expect(problems, problems.join('\n')).toEqual([])
  })

  it('classify 的签名必须仍是单参（本轮的回归点）', () => {
    const sig = analyzeParams(scriptSrc, 'classify')
    expect(sig).toEqual({ fixed: 1, variadic: false })
  })

  it('probe 的 timeoutMs 必须仍是有默认值的可选参数', () => {
    // 有默认值 ⇒ 允许传 5 个（防「把默认值删了」导致 5 个实参变成静默多余）
    const sig = analyzeParams(scriptSrc, 'probe')
    expect(sig!.fixed).toBe(Infinity)
  })
})

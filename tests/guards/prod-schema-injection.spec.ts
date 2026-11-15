import { describe, it, expect } from 'vitest'
// @ts-expect-error 脚本是 .mjs，没有类型声明
import { runCheck } from '../../scripts/check-prod-schema.mjs'

const ANON = 'anon-key-fake'
const PROD = 'https://vbamprkcwrpsazkyknjq.supabase.co'
const SQL_TEXT = `
create table if not exists public.users (
  id uuid primary key,
  name text
);
`

function envFile(url = PROD, anon = ANON) {
  return `VITE_SUPABASE_URL=${url}\nVITE_SUPABASE_ANON_KEY=${anon}\n`
}

function makeReadFile(map: Record<string, string>) {
  return (f: string) => {
    if (map[f] !== undefined) return map[f]
    throw new Error('ENOENT ' + f)
  }
}

const quietLogger = { log: () => {}, error: () => {} }

/**
 * 第十二轮独立评审·中级-2：`runCheck` 有 5 个注入点（`envFile` / `sqlFile` /
 * `expectedRef` / `nonProdRefs` / `logger`），但**显式传入非默认值时是否生效**
 * 一个都没测过 —— 如果哪天实现改成写死默认值（忽略注入），所有用例照样绿。
 * 默认值本身被间接钉住了，缺的正是「透传」。
 */
describe('生产库结构检查 · runCheck 注入点透传（第十二轮评审·中级-2）', () => {
  it('envFile 注入生效（非默认 .env.production 也要读）', async () => {
    const r = await runCheck({
      envFile: '.env.staging',
      readFile: makeReadFile({
        '.env.staging': envFile(),
        'supabase/schema.sql': SQL_TEXT,
      }),
      exists: (f: string) => f === '.env.staging',
      probeFn: async () => ({ ok: true }),
      logger: quietLogger,
    })
    expect(r.code).toBe(0)
    // ⚠️ 光断言 code===0 太弱：忽略 envFile 注入、硬读 .env.production 时，
    // makeReadFile 会抛 ENOENT → 也走 code 1，但如果两个文件都存在就分辨不出来。
    // 这里用「日志里出现注入的 URL」证明真的读了 .env.staging。
    expect(r.log.join('\n')).toContain('检查目标：' + PROD)
  })

  it('sqlFile 注入生效（非默认路径也能解析）', async () => {
    const r = await runCheck({
      sqlFile: 'custom/other.sql',
      readFile: makeReadFile({
        '.env.production': envFile(),
        'custom/other.sql': SQL_TEXT,
      }),
      exists: () => true,
      probeFn: async () => ({ ok: true }),
      logger: quietLogger,
    })
    expect(r.code).toBe(0)
    // 注入的 SQL 只有 users 一张表 2 个列 → 日志里必须是「1 张表、2 个列」
    // （若忽略 sqlFile 注入去读真实 schema.sql，这里会是 13 张表 84 个列）
    expect(r.log.join('\n')).toContain('1 张表、2 个列')
  })

  it('expectedRef 注入生效（换个期望 ref，真实 URL 就「不一致」）', async () => {
    const r = await runCheck({
      expectedRef: 'someotherref',
      readFile: makeReadFile({
        '.env.production': envFile(),
        'supabase/schema.sql': SQL_TEXT,
      }),
      exists: () => true,
      probeFn: async () => ({ ok: true }),
      logger: quietLogger,
    })
    expect(r.code).toBe(1)
    expect(r.log.join('\n')).toContain('检查对象不对')
  })

  it('nonProdRefs 注入生效（把生产 ref 列为「非生产」就该拒绝）', async () => {
    const r = await runCheck({
      nonProdRefs: ['vbamprkcwrpsazkyknjq'],
      readFile: makeReadFile({
        '.env.production': envFile(),
        'supabase/schema.sql': SQL_TEXT,
      }),
      exists: () => true,
      probeFn: async () => ({ ok: true }),
      logger: quietLogger,
    })
    expect(r.code).toBe(1)
    expect(r.log.join('\n')).toContain('检查对象不对')
  })

  it('logger 注入生效（不能写死 console）', async () => {
    const lines: string[] = []
    const r = await runCheck({
      readFile: makeReadFile({
        '.env.production': envFile(),
        'supabase/schema.sql': SQL_TEXT,
      }),
      exists: () => true,
      probeFn: async () => ({ ok: true }),
      logger: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) },
    })
    expect(r.code).toBe(0)
    // 日志必须真的走了注入的 logger（写死 console 的话这里会是空的）
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join('\n')).toContain('检查目标：')
  })
})

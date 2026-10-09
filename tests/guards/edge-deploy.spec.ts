// @vitest-environment node
/**
 * 静态守卫 · Edge Function 部署配置
 *
 * 这里的每条约定都是「部署那一刻才会炸」或「炸了也很难查」的类型：
 * - `register` 必须带 `--no-verify-jwt`（注册时用户还没登录），其余函数**必须保持默认 JWT 校验**
 *   —— 尤其 admin-api：一旦被误加 `--no-verify-jwt`，任何人构造请求就能打到后台管理接口；
 * - 所有 Edge Function 入口都要 `Deno.serve` + `_shared/cors.ts` 的 preflight/jsonResponse
 *   （CORS 白名单统一收口，漏一个函数就等于放行任意 Origin）；
 * - `register` 的限流依赖 `schema.sql` 第 14 节的 `rate_limits` + `check_rate_limit`：
 *   先跑 schema 再部署函数，少了函数 register 会 fail closed（503）；
 * - `admin-api` 的 `whoami` 必须留在 `!isAdmin` 的 403 之前（前端靠它判断有没有后台权限）；
 * - `schema.sql` 必须保持幂等（可重复执行）：裸 `create table` / 无 drop 前置的 `create policy`
 *   都会让「改完 schema 再跑一遍」这个动作直接报错。
 *
 * 离线、不联网、不读任何凭据。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function read(rel: string): string {
  return readFileSync(`${ROOT}/${rel}`, 'utf8')
}

function stripSqlComments(sql: string): string {
  return sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
}

/** 行号（1 基）：用于把问题指到具体位置 */
function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length
}

interface DeployCmd {
  fn: string
  where: string
  line: number
  text: string
}

/** deploy-functions.ps1 里的部署命令（Invoke-Supa @('functions','deploy','<name>', …) 形态） */
function scriptDeployCommands(src: string): DeployCmd[] {
  const out: DeployCmd[] = []
  src.split(/\r?\n/).forEach((line, i) => {
    const m = /'deploy'\s*,\s*'([\w-]+)'([^)]*)/.exec(line)
    if (m) out.push({ fn: m[1], where: 'supabase/deploy-functions.ps1', line: i + 1, text: line })
  })
  return out
}

/** README / docs 里的 `supabase functions deploy <name> …` 命令 */
function docDeployCommands(rel: string): DeployCmd[] {
  const src = read(rel)
  const out: DeployCmd[] = []
  // 抓到行尾或反引号为止：命令行后面的中文说明里提到 --no-verify-jwt 不算进命令
  const re = /(?:npx\s+(?:--yes\s+)?supabase(?:@latest)?|supabase)\s+functions\s+deploy\s+([\w-]+)([^\n`]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    out.push({ fn: m[1], where: rel, line: lineOf(src, m.index), text: m[0] })
  }
  return out
}

const edgeEntries = readdirSync(`${ROOT}/supabase/functions`, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== '_shared')
  .map((d) => `supabase/functions/${d.name}/index.ts`)
  .filter((rel) => {
    try {
      read(rel)
      return true
    } catch {
      return false
    }
  })

const schemaSql = stripSqlComments(read('supabase/schema.sql'))

describe('静态守卫 · Edge Function 部署配置', () => {
  describe('部署命令与 JWT 校验', () => {
    const scriptSrc = read('supabase/deploy-functions.ps1')
    const scriptCmds = scriptDeployCommands(scriptSrc)
    const docFiles = ['README.md', 'AGENTS.md', 'supabase/README.md', ...readdirSync(`${ROOT}/docs`).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)]
    const docCmds = docFiles.flatMap((f) => {
      try {
        return docDeployCommands(f)
      } catch {
        return []
      }
    })

    it('deploy-functions.ps1 里 register 的部署命令带 --no-verify-jwt', () => {
      const register = scriptCmds.filter((c) => c.fn === 'register')
      expect(
        register.map((c) => `${c.where}:${c.line}`),
        'deploy-functions.ps1 里找不到 register 的部署命令（注册是唯一免登录入口，必须显式免 JWT）',
      ).not.toEqual([])
      const bad = register.filter((c) => !c.text.includes('--no-verify-jwt'))
      expect(
        bad.map((c) => `${c.where}:${c.line}`),
        'register 的部署命令没有 --no-verify-jwt：注册请求会被平台挡在 JWT 校验上（用户还没登录，必然 401）\n' +
          "修法：Invoke-Supa @('functions','deploy','register','--project-ref',$ProjectRef,'--no-verify-jwt','--use-api')",
      ).toEqual([])
    })

    it('除 register 外的所有部署命令都不带 --no-verify-jwt（admin-api 必须保持默认 JWT 校验）', () => {
      const all = [...scriptCmds, ...docCmds]
      expect(all.length, '一条部署命令都没解析到（脚本/文档的写法变了？）').toBeGreaterThan(3)

      const bad = all.filter((c) => c.fn !== 'register' && c.text.includes('--no-verify-jwt'))
      expect(
        bad.map((c) => `${c.where}:${c.line} → deploy ${c.fn}`),
        '这些函数被加了 --no-verify-jwt：等于把服务端接口直接暴露给未登录用户\n' +
          '（admin-api 尤其致命：它是后台唯一入口，靠 JWT 里 user.id 判管理员）\n' +
          '修法：只有 register 免 JWT；其余保持 `supabase functions deploy <name> --project-ref <ref> --use-api`',
      ).toEqual([])
    })

    it('deploy-functions.ps1 恰好部署 App 侧三个函数，且只有 register 带 --no-verify-jwt', () => {
      // 脚本的定位是「App 侧函数一键部署」（脚本内步骤编号就是 1/3、2/3、3/3）。
      // admin-api 刻意**不**放进来：它的 JWT 要求与 register 相反，混在一起最容易踩错（见下一个用例）。
      const EXPECTED = ['register', 'create-patient', 'invite-member']
      const covered = scriptCmds.map((c) => c.fn).sort()

      expect(
        covered,
        `deploy-functions.ps1 部署的函数是 [${covered.join(', ')}]，与约定的 App 侧三个 [${EXPECTED.join(', ')}] 不一致\n` +
          '修法：本脚本只负责 App 侧函数；admin-api 走独立部署命令（supabase/README.md 第四·五节）',
      ).toEqual([...EXPECTED].sort())

      const withFlag = scriptCmds.filter((c) => c.text.includes('--no-verify-jwt')).map((c) => c.fn)
      expect(
        withFlag,
        `deploy-functions.ps1 里带 --no-verify-jwt 的是 [${withFlag.join(', ')}]（只允许 register）\n` +
          '修法：只有注册接口能免 JWT（注册时用户还没登录）；其余函数必须靠平台校验 JWT',
      ).toEqual(['register'])
    })

    it('admin-api 有独立的部署路径，且该命令不带 --no-verify-jwt（保持默认 JWT 校验）', () => {
      // admin-api 的部署说明写在两处，任一存在即可（脚本里刻意没有它）
      const adminCmds = docCmds.filter((c) => c.fn === 'admin-api')
      expect(
        adminCmds.map((c) => `${c.where}:${c.line}`),
        'supabase/README.md 与 docs/后台管理系统部署指南.md 里都找不到 `functions deploy admin-api`：' +
          '后台没有可复现的部署路径（手工敲命令最容易把它和 register 的 --no-verify-jwt 搞混）\n' +
          '修法：在 supabase/README.md 保留 `supabase functions deploy admin-api --project-ref <ref> --use-api`',
      ).not.toEqual([])

      const bad = adminCmds.filter((c) => c.text.includes('--no-verify-jwt'))
      expect(
        bad.map((c) => `${c.where}:${c.line}`),
        'admin-api 的部署命令被加了 --no-verify-jwt：等于把后台管理接口暴露给未登录用户（函数内部虽然会查 token，' +
          '但平台侧校验是第一道闸，注册接口之外没有理由关掉它）\n' +
          '修法：admin-api 保持 `supabase functions deploy admin-api --project-ref <ref> --use-api`',
      ).toEqual([])
    })
  })

  describe('Edge Function 入口的共性', () => {
    it('每个入口都调用 Deno.serve', () => {
      expect(edgeEntries.length, 'supabase/functions/ 下没找到任何入口').toBeGreaterThan(3)
      const bad = edgeEntries.filter((rel) => !/Deno\.serve\s*\(/.test(read(rel)))
      expect(
        bad,
        `这些入口没有 Deno.serve：[${bad.join(', ')}] —— 部署上去会 500/不响应`,
      ).toEqual([])
    })

    it('每个入口都从 _shared/cors.ts 取 preflight + jsonResponse（CORS 白名单统一收口）', () => {
      const bad: string[] = []
      for (const rel of edgeEntries) {
        const src = read(rel)
        if (!/from\s+['"]\.\.\/_shared\/cors\.ts['"]/.test(src)) bad.push(`${rel}：没有 import ../_shared/cors.ts`)
        if (!/\bpreflight\s*\(/.test(src)) bad.push(`${rel}：没有用 preflight（OPTIONS 预检）`)
        if (!/\bjsonResponse\s*\(/.test(src)) bad.push(`${rel}：没有用 jsonResponse（响应头统一收口）`)
        // 自己 new Response 拼 JSON 会漏掉 CORS 头
        if (/new\s+Response\s*\(\s*JSON\.stringify/.test(src) && rel.includes('index.ts')) {
          bad.push(`${rel}：直接用 new Response(JSON.stringify(...))，绕过了 jsonResponse`)
        }
      }
      expect(
        bad,
        `CORS 收口被绕过：\n${bad.map((x) => '  ' + x).join('\n')}\n` +
          '修法：入口统一 `import { preflight, jsonResponse } from \'../_shared/cors.ts\'`，' +
          'OPTIONS 走 preflight，其余走 jsonResponse（白名单外的 Origin 不该拿到 Access-Control-Allow-Origin）',
      ).toEqual([])
    })
  })

  describe('register 限流 ↔ schema.sql', () => {
    it('schema.sql 第 14 节有 rate_limits 表与 check_rate_limit 函数（register fail closed 的前提）', () => {
      expect(
        /create\s+table\s+if\s+not\s+exists\s+public\.rate_limits\s*\(/.test(schemaSql),
        'schema.sql 里没有 rate_limits 表：register 的限流 RPC 会直接报错 → fail closed（503），全站注册不可用',
      ).toBe(true)
      expect(
        /create\s+or\s+replace\s+function\s+public\.check_rate_limit\s*\(/.test(schemaSql),
        'schema.sql 里没有 check_rate_limit 函数：同上，注册接口会 503',
      ).toBe(true)
      expect(
        /create\s+or\s+replace\s+function\s+public\.check_rate_limit[\s\S]*?security\s+definer/i.test(schemaSql),
        'check_rate_limit 不是 security definer：它要写 rate_limits 表（该表不建任何策略），否则会被 RLS 挡住',
      ).toBe(true)
    })

    it('register 通过 rpc 调 check_rate_limit，且四道限流桶都在', () => {
      const src = read('supabase/functions/register/index.ts')
      expect(
        /rpc\(\s*['"]check_rate_limit['"]/.test(src),
        'register 没有调用 check_rate_limit：注册接口是全网唯一免登录入口，必须自己扛滥用',
      ).toBe(true)
      const buckets = ['register:ip:minute', 'register:ip:hour', 'register:global:hour', 'register:phone:hour']
      const missing = buckets.filter((b) => !src.includes(b))
      expect(
        missing,
        `register 少了限流桶：[${missing.join(', ')}]（supabase/README.md 第四·六节列了四道）`,
      ).toEqual([])
    })
  })

  describe('admin-api 鉴权顺序', () => {
    it('whoami 分支在 if (!isAdmin) 403 之前（非管理员也要能自检身份）', () => {
      const src = read('supabase/functions/admin-api/index.ts')
      const whoamiAt = src.search(/action\s*===\s*['"]whoami['"]/)
      const forbidAt = src.search(/if\s*\(\s*!\s*isAdmin\s*\)/)

      expect(whoamiAt, 'admin-api 里找不到 whoami 分支：前端无法判断当前账号有没有后台权限').toBeGreaterThanOrEqual(0)
      expect(forbidAt, 'admin-api 里找不到 `if (!isAdmin)` 403 拦截：普通用户 token 也能调管理接口').toBeGreaterThanOrEqual(0)
      expect(
        whoamiAt < forbidAt,
        'whoami 分支被放到了 !isAdmin 拦截之后：非管理员调 whoami 会拿到 403，后台登录后会卡在「无权限」而无法提示原因\n' +
          '修法：先处理 whoami（返回 { userId, isAdmin, ... }），再 `if (!isAdmin) return json({ error: … }, 403)`',
      ).toBe(true)
    })
  })

  describe('schema.sql 幂等性（改完必须能重跑一次）', () => {
    it('没有裸 create table / create index / add column（都必须带 if not exists）', () => {
      const problems: string[] = []
      const patterns: Array<[RegExp, string, string]> = [
        [/(^|\n)\s*create\s+table\s+(?!if\s+not\s+exists)/gi, 'create table', 'create table if not exists public.x ( … )'],
        [/(^|\n)\s*create\s+(?:unique\s+)?index\s+(?!if\s+not\s+exists)/gi, 'create index', 'create index if not exists …'],
        // add column 要幂等；add constraint 走另一条规则（见下一个用例）
        [
          /alter\s+table\s+[\w."]+\s+add\s+(?!column\s+if\s+not\s+exists)(?!constraint\b)/gi,
          'alter table … add',
          'alter table public.x add column if not exists …',
        ],
        [/(^|\n)\s*create\s+function\s+/gi, 'create function', 'create or replace function …'],
      ]
      for (const [re, label, fix] of patterns) {
        let m: RegExpExecArray | null
        while ((m = re.exec(schemaSql)) !== null) {
          problems.push(`schema.sql:${lineOf(schemaSql, m.index)} ${label} 不是幂等形态（应写成 ${fix}）`)
        }
      }

      expect(
        problems,
        `schema.sql 出现非幂等语句：\n${problems.map((p) => '  ' + p).join('\n')}\n` +
          '背景：AGENTS.md 要求「改过 schema.sql 后必须重新执行一次」，脚本一旦不幂等，重跑就报错、只能手工补',
      ).toEqual([])
    })

    it('每条 create policy 都有对应的 drop policy if exists（先 drop 再 create）', () => {
      const creates: Array<{ name: string; line: number }> = []
      const re = /create\s+policy\s+(\w+)/gi
      let m: RegExpExecArray | null
      while ((m = re.exec(schemaSql)) !== null) creates.push({ name: m[1], line: lineOf(schemaSql, m.index) })

      expect(creates.length, 'schema.sql 里一条 create policy 都没解析到').toBeGreaterThan(10)

      const missing = creates.filter(
        (c) => !new RegExp(`drop\\s+policy\\s+if\\s+exists\\s+${c.name}\\b`, 'i').test(schemaSql),
      )
      expect(
        missing.map((c) => `schema.sql:${c.line} create policy ${c.name} 没有前置的 drop policy if exists ${c.name}`),
        '策略缺少 drop 前置：重跑 schema.sql 会报 "policy already exists"，后台/业务表权限就改不动了\n' +
          '修法：每个 create policy 前面补一行 `drop policy if exists <同名> on <表>;`',
      ).toEqual([])
    })

    it('每条 add constraint 都有对应的 drop constraint if exists', () => {
      const adds: Array<{ name: string; line: number }> = []
      const re = /alter\s+table\s+[\w."]+\s+add\s+constraint\s+(\w+)/gi
      let m: RegExpExecArray | null
      while ((m = re.exec(schemaSql)) !== null) adds.push({ name: m[1], line: lineOf(schemaSql, m.index) })

      const missing = adds.filter(
        (c) => !new RegExp(`drop\\s+constraint\\s+if\\s+exists\\s+${c.name}\\b`, 'i').test(schemaSql),
      )
      expect(
        missing.map((c) => `schema.sql:${c.line} add constraint ${c.name} 没有前置的 drop constraint if exists`),
        '约束缺少 drop 前置：重跑 schema.sql 会报 constraint already exists（改外键时最容易踩）',
      ).toEqual([])
    })

    it('每条 create trigger 都有对应的 drop trigger if exists', () => {
      const creates: Array<{ name: string; line: number }> = []
      const re = /create\s+trigger\s+(\w+)/gi
      let m: RegExpExecArray | null
      while ((m = re.exec(schemaSql)) !== null) creates.push({ name: m[1], line: lineOf(schemaSql, m.index) })

      const missing = creates.filter(
        (c) => !new RegExp(`drop\\s+trigger\\s+if\\s+exists\\s+${c.name}\\b`, 'i').test(schemaSql),
      )
      expect(
        missing.map((c) => `schema.sql:${c.line} create trigger ${c.name} 没有前置的 drop trigger if exists`),
        '触发器缺少 drop 前置：重跑 schema.sql 会报 already exists',
      ).toEqual([])
    })

    it('表结构自检：sessions.operator_id 外键指向 public.users（不是 auth.users）', () => {
      // AGENTS.md 踩坑：指向 auth.users 时 PostgREST 关联不出记录人姓名
      const m = /alter\s+table\s+public\.sessions[\s\S]*?foreign\s+key\s*\(operator_id\)\s*references\s+([\w.]+)/i.exec(schemaSql)
      expect(m, '没找到 sessions.operator_id 的外键定义（改 schema 时删掉了？）').not.toBeNull()
      expect(
        m![1],
        `sessions.operator_id 外键指向了 ${m![1]}：PostgREST 关联不出记录人姓名（成员列表/报告页会显示空）\n` +
          '修法：references public.users(id) on delete set null',
      ).toBe('public.users')
    })
  })
})

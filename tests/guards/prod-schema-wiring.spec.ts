import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

/**
 * 生产库结构检查的**接线**守卫。
 *
 * 背景：`npm run check:schema` 原来只挂在**本地 pre-push**，而
 * `git push --no-verify`、从网页/其它机器推、hook 没装（core.hooksPath 是本地配置）
 * 都能绕过。第十一轮事故的本质是「没有任何一环问过库和代码匹配吗」——
 * 只在开发机本地钩子里问，仍然不算有人问。
 *
 * ⚠️ 这组用例自己也要防假绿（第十二轮独立评审·中级-3 实测 4 个变异全绿）：
 * 用 `toContain('trap')` 这种**原文匹配**会被注释骗过 —— 而 CI 步骤的注释里
 * 恰好就写着 `trap` / `.env.production` / `node scripts/check-prod-schema.mjs`。
 * 所以这里一律走 **YAML 解析 + 行级锚定正则**：
 *   - 注释行不以 `trap`/`printf`/`node` 开头，锚定 `^\s*` 后就不匹配；
 *   - `echo "node ..."` 以 `echo` 开头，不匹配 `^\s*node ...$`；
 *   - `node ... || true` 结尾多出 `|| true`，不匹配行尾 `$`。
 */

const CI = '.github/workflows/test.yml'
const PRE_PUSH = '.githooks/pre-push'

function ciDoc(): any {
  return parseYaml(readFileSync(CI, 'utf8'))
}

/** 找到「生产库结构」那个 CI 步骤（返回 yaml 解析后的对象） */
function schemaStep(): any {
  const steps = ciDoc().jobs.build.steps
  const step = steps.find((st: any) => st.name && st.name.includes('生产库结构'))
  expect(step, 'CI 里必须有「生产库结构与 schema.sql 一致性」步骤').toBeTruthy()
  return step
}

/** 剥掉整行 `#` 注释（用于 pre-push 这种 shell 脚本） */
function stripHashComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
}

describe('pre-push 接线', () => {
  const prePush = stripHashComments(readFileSync(PRE_PUSH, 'utf8'))

  it('pre-push 里必须真的执行 check-prod-schema.mjs（不是注释、不是 echo）', () => {
    // 行级锚定：行首（允许缩进）直接是 node 调用，行尾不能有 || true 之类
    expect(prePush).toMatch(/^\s*node\s+scripts\/check-prod-schema\.mjs\s*$/m)
  })

  it('pre-push 里调用失败必须中止推送（不能只 warn）', () => {
    const idx = prePush.search(/^\s*node\s+scripts\/check-prod-schema\.mjs\s*$/m)
    expect(idx).toBeGreaterThan(-1)
    const after = prePush.slice(idx, idx + 1200)
    expect(after).toMatch(/exit 1/)
  })

  it('pre-push 必须保留 SKIP_SCHEMA_CHECK 逃生口', () => {
    expect(prePush).toContain('SKIP_SCHEMA_CHECK')
  })
})

describe('CI 接线（YAML 结构级，不靠原文匹配）', () => {
  it('CI 里必须有生产库结构检查步骤，且在 build job 的 checkout 之后', () => {
    const steps = ciDoc().jobs.build.steps
    const names = steps.map((st: any) => st.name || st.uses)
    const idx = names.findIndex((n: string) => n && n.includes('生产库结构'))
    expect(idx).toBeGreaterThan(-1)
    const checkoutIdx = names.findIndex((n: string) => n && n.includes('checkout'))
    expect(checkoutIdx).toBeGreaterThan(-1)
    expect(idx).toBeGreaterThan(checkoutIdx)
  })

  it('该步骤必须真的执行脚本（行级锚定，echo 骗不过）', () => {
    const run = schemaStep().run as string
    expect(run).toMatch(/^\s*node\s+scripts\/check-prod-schema\.mjs\s*$/m)
  })

  it('脚本退出码不能被吞掉（不许 || true / ; 之类）', () => {
    const run = schemaStep().run as string
    const line = run.split('\n').find((l) => /^\s*node\s+scripts\/check-prod-schema\.mjs/.test(l))
    expect(line).toBeTruthy()
    expect(line!.trim()).toBe('node scripts/check-prod-schema.mjs')
  })

  it('必须用 printf 把凭据真的写到 .env.production（不能只 echo）', () => {
    const run = schemaStep().run as string
    // 行级锚定：printf ... > .env.production
    expect(run).toMatch(/^\s*printf\s+[^\n]*>\s*\.env\.production\s*$/m)
  })

  it('必须用 trap 清理凭据文件（node 失败时 set -e 会跳过普通 rm）', () => {
    const run = schemaStep().run as string
    expect(run).toMatch(/^\s*trap\s+'rm -f \.env\.production'\s+EXIT\s*$/m)
  })

  it('必须有 set -euo pipefail', () => {
    expect(schemaStep().run as string).toMatch(/^\s*set -euo pipefail\s*$/m)
  })

  it('没有凭据时必须警告并跳过（不能因为拿不到库就红）', () => {
    const run = schemaStep().run as string
    expect(run).toMatch(/::warning::/)
    // 跳过分支必须 exit 0
    expect(run).toMatch(/exit 0/)
  })

  it('凭据来自 secrets（不能硬编码 anon key）', () => {
    const env = schemaStep().env as Record<string, string>
    expect(env.PROD_URL).toContain('secrets.')
    expect(env.PROD_ANON).toContain('secrets.')
  })

  it('CI 里不许出现真实 anon key 实值（防止误把密钥写进 workflow）', () => {
    const raw = readFileSync(CI, 'utf8')
    // JWT 形态的 anon key 以 eyJ 开头
    expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/)
    // Supabase PAT 形态
    expect(raw).not.toMatch(/sbp_[A-Za-z0-9]{20,}/)
  })
})

/**
 * 第十二轮评审·中级-1：上面的用例只断言「某行存在」，于是下面这些**把整步架空的改法**
 * 全都能通过（评审实测 11 个变异里只有 1 个被抓）：
 *   M1 `if false; then … fi` 包住整步      M2 `if [ 1 -eq 2 ]; then … fi`
 *   M3 `if true; then :; fi` 跳过          M4 `if [ -n "" ]; then … fi`
 *   M5 node 前插 `exit 0`                  M6 pre-push 里 `if false` 包住
 *   M7 `exit 1` 前置                       M8 `SKIP_SCHEMA_CHECK` 默认跳过反转
 *   M10 `continue-on-error: true`          M11 `if: ${{ false }}`
 *
 * 这里补**反向断言**：不光「该有的在」，还要「不该有的不在」，且 node 必须是
 * 该步骤里最后一条可执行行（后面不能再有能改变退出码的东西）。
 */
describe('接线反向断言：不能把检查架空（中级-1）', () => {
  it('CI 步骤不许 continue-on-error（否则失败也算过）', () => {
    const step = schemaStep()
    expect(step['continue-on-error']).toBeUndefined()
  })

  it('CI 步骤不许带 if: 条件（否则可以被条件跳过）', () => {
    const step = schemaStep()
    expect(step.if).toBeUndefined()
  })

  it('CI 步骤的 run 里不许出现 || true / set +e / ; exit 0 之类吞退出码的写法', () => {
    const run = schemaStep().run as string
    expect(run).not.toMatch(/\|\|\s*true/)
    expect(run).not.toMatch(/set\s+\+e/)
    // node 那一行必须是整行，不能带 `; exit 0` 之类的尾巴
    expect(run).not.toMatch(/^\s*node\s+scripts\/check-prod-schema\.mjs\s*;/m)
  })

  it('CI 步骤的 run 里不许用 if false / if [ 1 -eq 2 ] / if true 把整步包起来', () => {
    const run = schemaStep().run as string
    // 任何 if 分支里出现 node 调用都算可疑（该步骤本来就是直线脚本）
    expect(run).not.toMatch(/if\s+false\b/)
    expect(run).not.toMatch(/if\s*\[\s*1\s+-eq\s+2\s*\]/)
    expect(run).not.toMatch(/if\s+true\s*;?\s*then/)
  })

  it('node 必须是该步骤里最后一条能影响退出码的语句', () => {
    const run = schemaStep().run as string
    const lines = run.split('\n')
    const nodeIdx = lines.findIndex((l) => /^\s*node\s+scripts\/check-prod-schema\.mjs\s*$/.test(l))
    expect(nodeIdx).toBeGreaterThan(-1)
    // node 之后不允许再出现任何「执行类」语句（只允许空行 / 注释）
    const after = lines.slice(nodeIdx + 1)
    const executable = after.filter((l) => {
      const t = l.trim()
      if (!t) return false
      if (t.startsWith('#')) return false
      // fi / done 之类收尾结构允许
      if (/^(fi|done|esac|})\s*$/.test(t)) return false
      return true
    })
    expect(executable, `node 之后还有可执行语句：${JSON.stringify(executable)}`).toEqual([])
  })

  it('CI 步骤里 node 不许被任何 if/条件包住（if [ -n "" ] 也算）', () => {
    const run = schemaStep().run as string
    const lines = run.split('\n')
    const nodeIdx = lines.findIndex((l) => /^\s*node\s+scripts\/check-prod-schema\.mjs\s*$/.test(l))
    expect(nodeIdx).toBeGreaterThan(-1)
    // 从 node 往上找：在遇到 `set -euo pipefail` / `trap` / `printf` 之前，不许出现 if/else/then
    const beforeNode = lines.slice(0, nodeIdx)
    const lastStructural = Math.max(
      beforeNode.findLastIndex((l) => /^\s*(set\s|trap\s|printf\s)/.test(l)),
      0,
    )
    const between = beforeNode.slice(lastStructural + 1).join('\n')
    expect(between, `node 前出现了条件结构，可能被跳过：${JSON.stringify(between)}`).not.toMatch(/\bif\b|\bthen\b|\bfi\b/)
  })

  it('CI 步骤里 node 之前不许有无条件 exit（否则永远跑不到）', () => {
    const run = schemaStep().run as string
    const lines = run.split('\n')
    const nodeIdx = lines.findIndex((l) => /^\s*node\s+scripts\/check-prod-schema\.mjs\s*$/.test(l))
    expect(nodeIdx).toBeGreaterThan(-1)
    const beforeNode = lines.slice(0, nodeIdx)
    // 允许 if 分支里的 exit 0（跳过分支），但不允许裸 exit
    let inBranch = 0
    for (const line of beforeNode) {
      const t = line.trim()
      if (/^if\b/.test(t)) inBranch++
      if (/^fi$/.test(t)) inBranch = Math.max(0, inBranch - 1)
      if (/^exit\s+0\s*$/.test(t) && inBranch === 0) {
        throw new Error(`node 之前出现无条件 exit 0：${t}`)
      }
    }
    expect(true).toBe(true)
  })

  it('CI 步骤不许 set +e（会关掉 set -e 的失败中止）', () => {
    const run = schemaStep().run as string
    expect(run).not.toMatch(/set\s+\+e/)
  })

  it('pre-push 的跳过条件必须是「等于 1」，不能是「非空就跳」或「为空才跳」', () => {
    const raw = stripHashComments(readFileSync(PRE_PUSH, 'utf8'))
    // 定位判断 SKIP_SCHEMA_CHECK 的那一行
    const line = raw
      .split('\n')
      .find((l) => l.includes('SKIP_SCHEMA_CHECK') && /\[\s/.test(l))
    expect(line, '必须有一行用 [ ] 判断 SKIP_SCHEMA_CHECK').toBeTruthy()
    // 必须是 = "1"（显式 1 才跳），不能是 -z（为空就跳 = 默认跳过）
    expect(line).toMatch(/=\s*"?1"?/)
    expect(line).not.toMatch(/\[\s*-z\s/)
    expect(line).not.toMatch(/\[\s*-n\s/)
  })
  it('pre-push 里 SKIP_SCHEMA_CHECK 不能是「默认跳过」（必须是显式 1 才跳）', () => {
    const raw = stripHashComments(readFileSync(PRE_PUSH, 'utf8'))
    // 常见反转写法：`if [ -z "$SKIP_SCHEMA_CHECK" ]; then exit 0; fi`
    expect(raw).not.toMatch(/\[\s*-z\s+"?\$\{?SKIP_SCHEMA_CHECK\}?"?\s*\]/)
    // 必须是「等于 1 才跳过」
    expect(raw).toMatch(/SKIP_SCHEMA_CHECK"?\s*=\s*"?1/)
  })

  it('pre-push 里 node 之后不许有裸 exit 0（会吞掉失败）', () => {
    const raw = stripHashComments(readFileSync(PRE_PUSH, 'utf8'))
    const lines = raw.split('\n')
    const nodeIdx = lines.findIndex((l) => /^\s*node\s+scripts\/check-prod-schema\.mjs\s*$/.test(l))
    expect(nodeIdx).toBeGreaterThan(-1)
    // ⚠️ 第十四轮评审（rev14-tests 中级-1）实测：旧写法用 findIndex 找**第一个** exit 0，
    // 而那正好是 L20-22 的 SKIP_TESTS 合法跳过分支 —— 找到它就「通过」了，
    // 于是 node 之后插入的裸 `exit 0` 从未被检查（W22 变异 25/25 全绿）。
    // 现在改为：node 之后到文件末尾，**每一行**裸 exit 0 都必须处在 if 分支内。
    let inBranch = 0
    for (let i = nodeIdx + 1; i < lines.length; i++) {
      const t = lines[i].trim()
      if (/^if\b/.test(t)) inBranch++
      if (/^fi$/.test(t)) inBranch = Math.max(0, inBranch - 1)
      if (/^else$/.test(t) || /^elif\b/.test(t)) {
        // else/elif 不改变嵌套深度
      }
      if (/^exit\s+0\s*$/.test(t) && inBranch === 0) {
        throw new Error(`node 之后出现无条件 exit 0（会吞掉检查失败）：第 ${i + 1} 行`)
      }
    }
    expect(true).toBe(true)
  })

  it('pre-push 不许 set +e / trap exit 0 / 函数包裹 / if false 架空检查', () => {
    const raw = stripHashComments(readFileSync(PRE_PUSH, 'utf8'))
    // ⚠️ 这 6 个改法在第十四轮评审里实测**全部 25/25 绿**（W17/W18/W19/W21/W24）。
    // 它们都不改「node 这一行在不在」，而是让它的失败不被传播 / 根本执行不到。
    // set +e：关掉 set -e 的失败中止
    expect(raw, 'pre-push 不许 set +e').not.toMatch(/^\s*set\s+\+e\s*$/m)
    // trap ... EXIT：脚本退出时强制 exit 0
    expect(raw, 'pre-push 不许 trap exit 0').not.toMatch(/trap\s+["']exit\s+0["']\s+EXIT/)
    // if false / if [ 1 -eq 2 ]：条件恒假，包住的检查永不执行
    expect(raw, 'pre-push 不许 if false 包住检查').not.toMatch(/if\s+false\b/)
    expect(raw, 'pre-push 不许 if [ 1 -eq 2 ]').not.toMatch(/if\s+\[\s*1\s+-eq\s+2\s*\]/)
    // 函数包裹 + return 0：把 node 塞进函数里再无条件 return 0
    // （合法写法是直接调用，不该有 `check_schema() { ... }` 这种包裹）
    expect(raw, 'pre-push 不许用函数包裹检查并 return 0').not.toMatch(/check_schema\s*\(\)\s*\{/)
    // 裸 `exit 0` 出现在 echo ④ 之前 = 整个第④步永远跑不到
    const lines = raw.split('\n')
    const echoIdx = lines.findIndex((l) => l.includes('④ 生产库结构同步'))
    expect(echoIdx).toBeGreaterThan(-1)
    let inBranch = 0
    for (let i = 0; i < echoIdx; i++) {
      const t = lines[i].trim()
      if (/^if\b/.test(t)) inBranch++
      if (/^fi$/.test(t)) inBranch = Math.max(0, inBranch - 1)
      if (/^exit\s+0\s*$/.test(t) && inBranch === 0) {
        throw new Error(`第④步之前出现无条件 exit 0（第 ${i + 1} 行），检查永远跑不到`)
      }
    }
    expect(true).toBe(true)
  })

  it('CI 步骤不许用 if false 之类的 job 级跳过', () => {
    const job = ciDoc().jobs.build
    expect(job.if).toBeUndefined()
  })
})
describe('脚本存在且导出预期 API', () => {
  it('scripts/check-prod-schema.mjs 存在并导出关键函数', async () => {
    expect(existsSync('scripts/check-prod-schema.mjs')).toBe(true)
    const m = await import('../../scripts/check-prod-schema.mjs')
    for (const fn of [
      'parseSchema',
      'runCheck',
      'probe',
      'stripSqlComments',
      'splitTopLevel',
      'findUnterminatedSql',
      'loadEnv',
      'refFromUrl',
      'assertProdTarget',
      'classify',
      'dedupeColumns',
    ]) {
      expect(typeof m[fn], `${fn} 必须是函数`).toBe('function')
    }
  })
})

#!/usr/bin/env node
/**
 * 提交前深度评审的**机械门禁**。
 *
 * 为什么要有它：评审这件事光写进文档是拦不住人的 —— 历史上「乐观锁漏加」连续漏了三次
 * （savePatient / replaceAdverseReactions / confirmAbort），每一次都是
 * 「测试全绿 + 类型检查通过 + CI 通过」，没有任何一道自动防线提醒。
 * 所以把「评审」从一个建议，变成一个**不改状态就推不出去**的关卡。
 *
 * 一轮完整流程：
 *   开发 → 测试 → `review-gate start`（列出评审范围与清单）
 *        → 评审（自己 5 问 + 独立评审 agent 对抗性审查，每条问题必须有佐证）
 *        → 有问题就回到开发，修完重新走一轮
 *        → 全部通过后 `review-gate pass --answers <评审记录.md>`
 *        → `git push`（pre-push 会跑 `review-gate check` 复核）
 *        → 构建发布
 *
 * 用法：
 *   node scripts/review-gate.mjs start [--since <sha>]
 *   node scripts/review-gate.mjs pass --answers .review/answers.md
 *   node scripts/review-gate.mjs check
 *   node scripts/review-gate.mjs status
 *
 * 紧急跳过（与 SKIP_TESTS 一致的口子）：
 *   SKIP_REVIEW=1 git push
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = process.cwd()
const STATE_DIR = resolve(ROOT, '.review')
const STATE_FILE = resolve(STATE_DIR, 'state.json')

const C = {
  red: (s) => `\u001b[31m${s}\u001b[0m`,
  green: (s) => `\u001b[32m${s}\u001b[0m`,
  yellow: (s) => `\u001b[33m${s}\u001b[0m`,
  dim: (s) => `\u001b[2m${s}\u001b[0m`,
}

/** 跑一条 git 命令并取回 stdout；失败时返回 null（而不是抛错炸掉钩子） */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function headSha() {
  const sha = git(['rev-parse', 'HEAD'])
  if (!sha) {
    console.error(C.red('[review-gate] 读不到 HEAD（不是 git 仓库？）'))
    process.exit(2)
  }
  return sha
}

function readState() {
  if (!existsSync(STATE_FILE)) return null
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

function writeState(state) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8')
}

/** 评审基线：显式指定 > 上一次评审通过时的 HEAD > 与上游的合并基点 > HEAD~1 */
function resolveBaseline(argv) {
  const i = argv.indexOf('--since')
  if (i >= 0 && argv[i + 1]) return argv[i + 1]

  const state = readState()
  if (state?.passedSha) return state.passedSha

  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (upstream) {
    const base = git(['merge-base', 'HEAD', upstream])
    if (base) return base
  }

  const parent = git(['rev-parse', 'HEAD~1'])
  return parent ?? headSha()
}

function scopeOf(baseline) {
  const range = `${baseline}..HEAD`
  const stat = git(['diff', '--stat', range]) ?? ''
  const log = git(['log', '--oneline', range]) ?? ''
  const commits = log ? log.split('\n').filter(Boolean) : []
  return { range, stat, commits }
}

const QUESTIONS = [
  '影响面：改的函数/模块还有谁在调用？他们的假设还成立吗？（动公共件时逐个调用点看一遍）',
  '同类问题：同一个模式在别处还有吗？（乐观锁漏加就是这么漏的）',
  '新失败模式：这次改动**引入**了什么以前不存在的失败可能？',
  '反向验证：如果我是审查者，会从哪里挑刺？（边界/并发/失败路径/文案/数据可恢复性）',
  '验证强度：证据是「测试通过」还是「实测过真实路径」？关键用例做过对抗性验证吗？',
]

function printChecklist(baseline) {
  const { range, stat, commits } = scopeOf(baseline)
  console.log('')
  console.log(C.yellow('════════ 提交前深度评审 ════════'))
  console.log(`评审范围：${range}（${commits.length} 个提交）`)
  console.log(C.dim(stat || '（没有差异？）'))
  console.log('')
  console.log('① 逐条回答 5 问（写进评审记录，`pass` 时会校验）：')
  QUESTIONS.forEach((q, i) => console.log(`   ${i + 1}. ${q}`))
  console.log('')
  console.log('② 派**独立评审 agent** 做对抗性审查（源码维度 + 测试有效性维度）：')
  console.log('   - 找问题，不是确认它对；范围只限本次 diff')
  console.log('   - 每条问题必须带佐证：可复现路径 / 代码位置 / 实测输出 / 一个会失败的用例')
  console.log('   - 没有佐证的只能标「待确认」，**不许照着改代码**')
  console.log('')
  console.log('③ 评审提出的问题逐条定性：')
  console.log('   - 确认是问题 → 修 + 补用例 → **回到开发，重新走一轮评审**')
  console.log('   - 证伪 → 记录证据，不改')
  console.log('   - 已知取舍 → 写清理由与影响')
  console.log('')
  console.log('④ 关键用例做**对抗性验证**：临时把代码回退成改之前的样子，确认用例真的会红')
  console.log(C.dim('   （守「串数据」的那条用例就曾经恒真 —— 修复前照样通过）'))
  console.log('')
  console.log(`通过后：${C.green('node scripts/review-gate.mjs pass --answers .review/answers.md')}`)
  console.log(C.yellow('════════════════════════════════'))
  console.log('')
}

/** 校验评审记录：5 问都要答、未决问题必须清零或写明「已知取舍」、对抗性验证要有内容 */
function validateAnswers(text) {
  const problems = []

  for (let i = 1; i <= 5; i++) {
    // 接受 `## 1.` / `### 问 1` / `1)` 等写法
    const re = new RegExp(`(^|\\n)\\s*(#{1,6}\\s*)?(问\\s*)?${i}[\\.、\\)：:]\\s*([\\s\\S]{40,}?)(\\n\\s*(#{1,6}\\s*)?(问\\s*)?${i + 1}[\\.、\\)：:]|$)`)
    const m = text.match(re)
    if (!m || !m[4] || m[4].replace(/\s/g, '').length < 30) {
      problems.push(`第 ${i} 问没有实质答案（至少 30 字，写清具体结论而不是「已检查」）`)
    }
  }

  if (!/对抗性验证/.test(text)) {
    problems.push('缺少「对抗性验证」小节：关键用例要临时回退代码确认它会红，写出命令与结果')
  } else {
    const section = text.slice(text.indexOf('对抗性验证'))
    const bullets = section.split('\n').filter((l) => /^[-*]\s*\S/.test(l.trim()) && l.replace(/\s/g, '').length > 12)
    if (bullets.length < 1) problems.push('「对抗性验证」小节没有具体记录（至少要写：回退了什么、用例报了什么错）')
  }

  const unresolvedMatch = text.match(/未决问题[：:]\s*([^\n]*)/)
  if (!unresolvedMatch) {
    problems.push('缺少「未决问题：」一行 —— 必须显式写「未决问题：无」，或逐条列出并标注「已知取舍」')
  } else {
    const line = unresolvedMatch[1].trim()
    const isZero = /^(无|0|none|none\.|没有)$/i.test(line.replace(/[。\s]/g, ''))
    if (!isZero) {
      // 允许列出未决项，但每条都要写明「已知取舍」与影响，否则视为没处理
      const bad = line
        .split(/[；;、,，]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((s) => !/已知取舍/.test(s) || !/影响/.test(text))
      if (bad.length) {
        problems.push(
          `未决问题不为空，且没有写成「已知取舍」：${bad.join(' / ')}\n` +
            '           要么修掉它们回到开发，要么逐条写清「已知取舍 + 理由 + 影响」',
        )
      }
    }
  }

  return problems
}

const [mode, ...rest] = process.argv.slice(2)

if (mode === 'start') {
  const baseline = resolveBaseline(rest)
  const sha = headSha()
  writeState({ baseline, startedAt: new Date().toISOString(), passed: false, passedSha: readState()?.passedSha ?? null })
  printChecklist(baseline)
  console.log(`基线已记录：${C.dim(baseline.slice(0, 8))}；评审通过后跑 pass 即可放行 ${C.dim(sha.slice(0, 8))}`)
  process.exit(0)
}

if (mode === 'pass') {
  const i = rest.indexOf('--answers')
  const answersPath = i >= 0 ? rest[i + 1] : null
  if (!answersPath) {
    console.error(C.red('[review-gate] 用法：pass --answers .review/answers.md'))
    process.exit(2)
  }
  const abs = resolve(ROOT, answersPath)
  if (!existsSync(abs)) {
    console.error(C.red(`[review-gate] 找不到评审记录：${answersPath}`))
    process.exit(2)
  }

  const problems = validateAnswers(readFileSync(abs, 'utf8'))
  if (problems.length) {
    console.error('')
    console.error(C.red('[review-gate] ❌ 评审记录还不合格，不能放行：'))
    problems.forEach((p) => console.error(`   - ${p}`))
    console.error('')
    console.error('   评审没过 = 回到开发：修问题 → 补用例 → 重新评审。')
    console.error('')
    process.exit(1)
  }

  const sha = headSha()
  const prev = readState()
  writeState({
    baseline: prev?.baseline ?? resolveBaseline([]),
    startedAt: prev?.startedAt ?? null,
    passed: true,
    passedSha: sha,
    passedAt: new Date().toISOString(),
    answers: answersPath,
  })
  console.log(C.green(`[review-gate] ✅ 评审通过，已放行 ${sha.slice(0, 8)}（记录：${answersPath}）`))
  console.log(C.dim('           推送时 pre-push 会再复核一次；HEAD 再变就要重新评审。'))
  process.exit(0)
}

if (mode === 'status') {
  const state = readState()
  const sha = headSha()
  if (!state) {
    console.log('[review-gate] 还没有评审记录。先跑：node scripts/review-gate.mjs start')
    process.exit(0)
  }
  console.log(`评审基线：${state.baseline}`)
  console.log(`最新评审：${state.passed ? '通过' : '未通过'} @ ${state.passedSha ?? '(无)'}`)
  console.log(`当前 HEAD：${sha}`)
  console.log(state.passed && state.passedSha === sha ? C.green('状态：可以推送') : C.yellow('状态：需要重新评审'))
  process.exit(0)
}

if (mode === 'check' || mode === undefined) {
  if (process.env.SKIP_REVIEW === '1') {
    console.log(C.yellow('[review-gate] 已跳过（SKIP_REVIEW=1）'))
    process.exit(0)
  }

  const sha = headSha()
  const state = readState()

  // 「有没有东西要推」要看与**上游**的差距，而不是与评审基线的差距 ——
  // 正常流程（提交 → 评审 → 推送）下评审基线就等于 HEAD，
  // 拿它算会得到「0 个提交」，于是静态守卫永远不会被执行。
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  const pushBase = upstream ? (git(['merge-base', 'HEAD', upstream]) ?? upstream) : resolveBaseline([])
  const pushing = scopeOf(pushBase)
  if (pushing.commits.length === 0) {
    console.log(C.dim('[review-gate] 没有待推送的提交，跳过'))
    process.exit(0)
  }

  if (!state || !state.passed) {
    console.error('')
    console.error(C.red('[review-gate] ❌ 本次改动还没有通过深度评审，推送已中止。'))
    const baseline = resolveBaseline([])
    printChecklist(baseline)
    process.exit(1)
  }

  if (state.passedSha !== sha) {
    console.error('')
    console.error(C.red('[review-gate] ❌ 评审记录已过期：当时评审的是另一个提交。'))
    console.error(`           已评审：${state.passedSha}`)
    console.error(`           当前 HEAD：${sha}`)
    console.error('           评审必须覆盖**将要推送的内容**，请重新走一轮评审。')
    console.error('')
    process.exit(1)
  }

  // 评审通过后又改了工作区（还没提交）：提交后 HEAD 会变，评审自动失效 —— 提前提醒
  const dirty = (git(['status', '--porcelain', '--', 'src', 'tests', 'supabase', 'admin']) ?? '')
    .split('\n')
    .filter(Boolean)
  if (dirty.length) {
    console.log(C.yellow(`[review-gate] 注意：src/tests 还有 ${dirty.length} 个未提交改动 ——`))
    console.log(C.yellow('           它们一旦被提交，HEAD 就变了，需要重新评审。'))
  }

  console.log(`[review-gate] ① 静态守卫（评审里可机械化的那部分）…`)
  try {
    execFileSync('npx', ['vitest', 'run', 'tests/guards', '--reporter=dot'], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
  } catch {
    console.error('')
    console.error(C.red('[review-gate] ❌ 静态守卫未通过 —— 评审结论与代码对不上了。'))
    console.error('')
    process.exit(1)
  }

  const { range, commits } = scopeOf(state.baseline)
  console.log(C.green(`[review-gate] ✅ 评审门禁通过（要推送 ${pushing.commits.length} 个提交：${pushing.range}）`))
  console.log(C.dim(`           评审基线：${range}（${commits.length} 个提交）`))
  process.exit(0)
}

console.error(C.red(`[review-gate] 未知命令：${mode}`))
console.error('可用：start | pass --answers <file> | check | status')
process.exit(2)

// @vitest-environment node
/**
 * 静态守卫 · 敏感信息不得入库
 *
 * 本仓库是**公开仓库**：任何被 git 跟踪的文件，等于全世界可读。
 * 一旦把 Supabase PAT / anon key / service_role key / keystore 提交进去，
 * 就等于公开了测试库与生产库的控制权（AGENTS.md 第二节）。
 *
 * 做法：
 * - 只认 `git ls-files` 的**索引清单**（不看磁盘）：`.env` 本来就在磁盘上，但它是被忽略的，不该因此报错；
 *   反过来，只要它出现在索引里就必须红。
 * - 只读文本文件（按扩展名跳过二进制、超过体积上限的跳过、含 NUL 字节的跳过），全部离线、不联网。
 * - 断言失败信息**绝不打印命中的密钥片段**（仓库公开、CI 日志人人可看），只报文件:行号 + 规则名。
 *   因此本文件里的规则全部写成「不会被自己匹配」的形态，扫描范围包含守卫文件自身（见最后一个用例）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** 调 git 并把输出当文本拿回来（守卫只读索引，不扫磁盘） */
function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/** 被跟踪的全部文件（仓库相对路径，正斜杠） */
function trackedFiles(): string[] {
  return git(['ls-files', '-z'])
    .split('\0')
    .filter((p) => p.length > 0)
}

/**
 * 未跟踪且**未被忽略**的文件。
 *
 * 为什么也要扫：`git ls-files` 只看索引，而「已经写到工作区、还没提交」的临时文件
 * 恰恰是最容易把密钥带进公开仓库的那一批（`git add -A` 一按就进去了）。
 * 用 `-z` 取出，避免非 ASCII 文件名被引号转义。
 */
function untrackedFiles(): string[] {
  return git(['ls-files', '-z', '--others', '--exclude-standard'])
    .split('\0')
    .filter((p) => p.length > 0)
}

/** 生成物目录：跳过内容扫描（本来就已被 .gitignore 忽略，不会进提交，扫它们只有噪声） */
const GENERATED_PREFIXES = [
  'coverage/',
  'coverage-tmp/',
  'dist/',
  'dist-admin/',
  'dist-ssr/',
  'node_modules/',
  'android/app/build/',
  'android/.gradle/',
  '.wrangler/',
  'supabase/.temp/',
]

function isGenerated(rel: string): boolean {
  return GENERATED_PREFIXES.some((p) => rel.startsWith(p))
}

// ------------------------------------------------------------------
// 读文件：二进制 / 超大文件直接跳过（不做内容断言，也不会误报）
// ------------------------------------------------------------------

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svgz',
  '.zip', '.gz', '.tgz', '.7z', '.rar', '.apk', '.aab', '.aar',
  '.jar', '.class', '.dex', '.so', '.dll', '.exe', '.bin',
  '.keystore', '.jks', '.p12', '.pfx',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.mp3', '.mp4', '.mov', '.pdf',
  '.db', '.sqlite', '.sqlite3',
])

/** 单文件扫描上限：超过就跳过（现存最大的文本文件是 package-lock.json，约 350KB） */
const MAX_TEXT_BYTES = 1024 * 1024

/** 返回文件文本；二进制 / 超大 / 读不到（稀疏检出）时返回 null */
function readIfText(rel: string): string | null {
  if (BINARY_EXT.has(extname(rel).toLowerCase())) return null
  let buf: Buffer
  try {
    buf = readFileSync(join(ROOT, rel))
  } catch {
    return null
  }
  if (buf.length > MAX_TEXT_BYTES) return null
  if (buf.subarray(0, 8000).includes(0)) return null // 含 NUL = 二进制
  return buf.toString('utf8')
}

// ------------------------------------------------------------------
// 规则表
//
// ⚠️ 写法约定：这里的字面量都是「敏感前缀被拆开」的形态（如 'eyJ' + 'hbGciOi'），
//    否则守卫文件自己会被自己的规则命中 —— 而扫描范围包含守卫文件本身。
// ------------------------------------------------------------------

interface Rule {
  /** 规则名（报错信息里只出现它，不出现命中的内容） */
  id: string
  re: RegExp
  /** 命中后怎么修 */
  fix: string
}

/** 组装前缀，避免规则表自身被匹配 */
const p = (...parts: string[]) => parts.join('')

const RULES: Rule[] = [
  {
    id: 'supabase-pat',
    // Supabase Personal Access Token：sbp_ + 40 位十六进制
    re: new RegExp(p('s', 'bp_') + '[A-Za-z0-9]{20,}'),
    fix: 'PAT 只放本机 .supabase-pat.local（已被 *.local 忽略）或 CI secret，不要写进任何入库文件',
  },
  {
    id: 'jwt',
    // Supabase 的 anon / service_role key 都是 JWT，头部固定以 eyJhbGciOi 开头。
    // 占位符（.env.example 与 README 里的 eyJhbGciOi...）后面跟的是「...」，不会命中。
    re: new RegExp(p('eyJ', 'hbGciOi') + '[A-Za-z0-9_-]{10,}'),
    fix: 'anon key / service key 只能来自环境变量（Deno.env.get / import.meta.env），不要硬编码',
  },
  {
    id: 'service-role-value',
    // 文档里允许出现 service_role 这个词做说明 —— 只禁「service_role = <长值>」这种赋值形态
    re: /service_role["']?\s*[:=]\s*["'][A-Za-z0-9._-]{20,}/i,
    fix: 'service_role 只能是 Deno.env.get(SUPABASE_SERVICE_ROLE_KEY) 的运行时值，绝不入库',
  },
  {
    id: 'private-key-block',
    re: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    fix: '私钥（含 keystore 导出的 PEM）不得入库；keystore 只以 CI secret 的 base64 形式存在',
  },
  {
    id: 'github-pat',
    re: new RegExp('\\b' + p('gh', 'p_') + '[A-Za-z0-9]{20,}'),
    fix: 'GitHub PAT 用 secret 或 gh auth，不要写进仓库',
  },
  {
    id: 'github-fine-grained-pat',
    re: new RegExp('\\b' + p('github', '_pat_') + '[A-Za-z0-9_]{20,}'),
    fix: 'GitHub PAT 用 secret 或 gh auth，不要写进仓库',
  },
]

/**
 * 高危变量名 + 看起来像真值的赋值。
 *
 * 只针对「已知的凭据变量名」，并要求值像真密钥（够长、字母数字混排、不是占位符），
 * 以此避免误伤 UUID / 哈希 / ${{ secrets.X }} / <ref> 这类占位写法。
 * Cloudflare token 形态的长串不做单独规则（40 位随机串太容易误伤），
 * 由这一条按变量名兜住。
 */
const SECRET_NAME_RE =
  /\b(SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE_KEY|SUPABASE_ACCESS_TOKEN|CLOUDFLARE_API_TOKEN|CF_API_TOKEN|CF_API_KEY|ANDROID_DEBUG_KEYSTORE_BASE64|KEYSTORE_BASE64|VITE_SUPABASE_ANON_KEY|TURNSTILE_SECRET_KEY|GH_TOKEN|GITHUB_TOKEN)\b\s*[:=]\s*["']?([^\s"',;)]+)/g

/** 值是否像「真密钥」而不是占位符 / 变量引用 / 表达式 */
function looksLikeRealSecret(value: string): boolean {
  if (value.length < 32) return false
  if (/[${}<>\s]/.test(value)) return false // $VAR / ${{ secrets.X }} / <ref> / 含空格
  if (/^[.\-_=]+$/.test(value)) return false // 全是 ... --- ___ ===
  if (/^(x{4,}|X{4,}|0{8,}|your[-_]|change[-_]?me|placeholder|example|test)/i.test(value)) return false
  if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return false // 真密钥基本都字母数字混排
  if (/^[A-Za-z_]+$/.test(value)) return false
  return true
}

interface Hit {
  file: string
  line: number
  rule: string
  fix: string
}

/** 扫描一段文本，命中只记「文件:行号 + 规则」，绝不记录内容 */
function scan(text: string, file: string): Hit[] {
  const hits: Hit[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      rule.re.lastIndex = 0
      if (rule.re.test(line)) hits.push({ file, line: i + 1, rule: rule.id, fix: rule.fix })
    }
    // 高危变量名赋值：逐行重扫（正则带 g，要复位）
    SECRET_NAME_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = SECRET_NAME_RE.exec(line)) !== null) {
      if (looksLikeRealSecret(m[2])) {
        hits.push({
          file,
          line: i + 1,
          rule: `secret-assignment(${m[1]})`,
          fix: '凭据只走环境变量 / CI secret；本机配置放 *.local（已忽略）',
        })
      }
      if (m[0].length === 0) break
    }
  })
  return hits
}

function formatHits(hits: Hit[]): string {
  // 只报位置与规则，不报内容（仓库公开，日志会进 CI）
  return hits.map((h) => `  ${h.file}:${h.line} → ${h.rule}｜修法：${h.fix}`).join('\n')
}

/**
 * 扫描「即将进入公开仓库的文件」= 索引里的 + 未跟踪且未忽略的（生成物目录除外）。
 * 前者是已经进去的，后者是 `git add -A` 一按就会进去的。
 */
function scanAboutToBeCommitted(): { hits: Hit[]; scanned: number; skipped: number } {
  const hits: Hit[] = []
  let scanned = 0
  let skipped = 0

  const targets: Array<{ rel: string; label: string }> = [
    ...trackedFiles().map((rel) => ({ rel, label: rel })),
    ...untrackedFiles()
      .filter((rel) => !isGenerated(rel))
      .map((rel) => ({ rel, label: `[未跟踪] ${rel}` })),
  ]

  for (const { rel, label } of targets) {
    const text = readIfText(rel)
    if (text === null) {
      skipped++
      continue
    }
    scanned++
    hits.push(...scan(text, label))
  }
  return { hits, scanned, skipped }
}

// ------------------------------------------------------------------
// .gitignore 判定
// ------------------------------------------------------------------

function ignorePatterns(): string[] {
  return readFileSync(join(ROOT, '.gitignore'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
}

/** 粗粒度 glob 匹配（只用于「.gitignore 里有对应规则」的断言） */
function patternCovers(pattern: string, file: string): boolean {
  if (pattern.startsWith('!')) return false
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  return re.test(file)
}

/** 用 git 自己判定是否被忽略（比手写匹配更权威；非 0/1 退出码视为异常） */
function isIgnoredByGit(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', path], { cwd: ROOT, stdio: 'ignore' })
    return true
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status === 1) return false
    throw err
  }
}

// ------------------------------------------------------------------

describe('静态守卫 · 敏感信息不得入库', () => {
  describe('入库清单（git 索引 + 未跟踪未忽略）', () => {
    it('没有 .env / .env.production / .env.local / *.local / .supabase-pat.local / keystore 会被提交', () => {
      const files = trackedFiles()
      expect(files.length, 'git ls-files 没列出任何文件，说明守卫跑错目录了').toBeGreaterThan(50)

      // 未跟踪但没被忽略的也算「即将入库」：git add -A 一按就进去了
      const pending = untrackedFiles().filter((f) => !isGenerated(f))
      const files2 = [...files.map((f) => ({ f, pending: false })), ...pending.map((f) => ({ f, pending: true }))]

      const offenders = files2.filter(
        ({ f }) =>
          f !== '.env.example' && // 占位符样例是故意入库的
          (/^\.env($|\.)/.test(f.split('/').pop() ?? '') ||
            /\.local$/.test(f) ||
            /\.supabase-pat\.local$/.test(f) ||
            /\.keystore$|\.jks$/.test(f)),
      )

      expect(
        offenders.map(({ f, pending }) => `${f}${pending ? '（未跟踪，但未被 .gitignore 忽略 → 会被 git add -A 带进去）' : ''}`),
        '这些敏感文件会被提交：\n' +
          '修法：确认 .gitignore 覆盖它（.env / .env.* / *.local）；已入库的用 git rm --cached <文件> 移除；' +
          '凭据只放本机 *.local 或 CI secret',
      ).toEqual([])
    })

    it('.gitignore 明确忽略 .env / .env.production（或 .env.*）/ *.local，且 git 实测确实忽略', () => {
      const patterns = ignorePatterns()
      const mustCover = ['.env', '.env.production', '.env.local', '.supabase-pat.local']

      const uncovered = mustCover.filter((f) => !patterns.some((p) => patternCovers(p, f)))
      expect(
        uncovered,
        `\.gitignore 缺少能覆盖 ${uncovered.join('、')} 的规则（当前规则：${patterns.join(' | ')}）\n` +
          '修法：保留 .env 与 .env.*（并用 !.env.example 放行样例）以及 *.local',
      ).toEqual([])

      const notIgnored = mustCover.filter((f) => !isIgnoredByGit(f))
      expect(
        notIgnored,
        `git check-ignore 判定这些文件**没有**被忽略：${notIgnored.join('、')}（可能是被 ! 规则放行了）\n` +
          '修法：检查 .gitignore 里的否定规则（! 开头）是否把它重新纳入跟踪',
      ).toEqual([])
    })
  })

  describe('内容扫描（即将进入仓库的文本文件：索引 + 未跟踪未忽略）', () => {
    it('没有 PAT / JWT / 私钥 / GitHub PAT / service_role 实值 / 高危变量赋值', () => {
      const { hits, scanned, skipped } = scanAboutToBeCommitted()
      console.log(
        `[secrets] 已扫描 ${scanned} 个文本文件（索引 + 未跟踪未忽略），跳过 ${skipped} 个二进制/超大/生成物文件`,
      )

      expect(
        hits,
        `命中的规则（内容已隐藏，避免密钥进 CI 日志）：\n${formatHits(hits)}\n` +
          '修法：把凭据换成环境变量引用（Deno.env.get / import.meta.env / ${{ secrets.X }}），并清理 git 历史',
      ).toEqual([])
    })

    it('占位符与守卫文件自身不会误报（保证扫描范围可以覆盖 tests/**）', () => {
      // .env.example 与 supabase/README.md 里的 eyJhbGciOi... 是占位符，不该命中；
      // 本守卫文件自身也会在提交后进入扫描范围 —— 若规则写成了会被自己匹配的形态，这里必须红。
      // 注意：tests/ 目前在索引里可能还没有（未提交），所以这里显式从磁盘读守卫目录，
      // 让「规则不能自我命中」这条立刻生效，而不是等到提交之后。
      const guardDir = fileURLToPath(new URL('.', import.meta.url))
      const guardFiles = readdirSync(guardDir).filter((f) => f.endsWith('.ts'))
      expect(guardFiles.length, 'tests/guards/ 下没有读到守卫文件，自检失去意义').toBeGreaterThan(0)

      const hits = [
        ...scan(readFileSync(join(ROOT, '.env.example'), 'utf8'), '.env.example'),
        ...guardFiles.flatMap((f) => scan(readFileSync(join(guardDir, f), 'utf8'), `tests/guards/${f}`)),
        // 文档里允许出现 sbp_ / service_role 这类词做说明，扫一遍确保规则不会误伤说明性文字
        ...scan(readFileSync(join(ROOT, 'AGENTS.md'), 'utf8'), 'AGENTS.md'),
      ]
      expect(
        hits,
        `占位符或守卫源码被误判：\n${formatHits(hits)}\n` +
          '修法：让规则只匹配「真实形态」的长串（例如 JWT 要求 eyJhbGciOi 之后至少 10 位 base64 字符）',
      ).toEqual([])
    })
    it('规则确有牙齿：合成的假密钥样本必须被逐条命中（阳性对照）', () => {
      // 说明：守卫本身也怕「规则写错导致永远绿」。这里用运行时拼出来的假样本验证规则有效性；
      // 拼接是为了让这些样本**在源码里不构成真形态**（否则本文件会被自己扫红）。
      const S = (...parts: string[]) => parts.join('')
      const HEX40 = '0123456789abcdef0123456789abcdef01234567'
      const MIX36 = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9'

      const controls: Array<[rule: string, sample: string]> = [
        ['supabase-pat', S('TOKEN=sbp', '_', HEX40)],
        ['jwt', S('ANON=eyJ', 'hbGciOi', 'JIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSJ9.sig')],
        ['service-role-value', S('const k = "service', '_role": "', MIX36, '"')],
        ['private-key-block', S('-----BEGIN ', 'RSA ', 'PRIVATE KEY-----')],
        ['github-pat', S('token: gh', 'p_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')],
        ['github-fine-grained-pat', S('token: github', '_pat_', '11ABCDEFG0abcdefghijkl_')],
        [`secret-assignment(CLOUDFLARE_API_TOKEN)`, S('CLOUDFLARE', '_API_TOKEN=', MIX36)],
        [`secret-assignment(SUPABASE_SERVICE_ROLE_KEY)`, S('SUPABASE_SERVICE', '_ROLE_KEY=', MIX36)],
      ]

      const missed = controls.filter(([, sample]) => scan(sample, '样本').length === 0).map(([rule]) => rule)
      expect(
        missed,
        `以下规则形同虚设（合成样本没被命中）：${missed.join('、')}\n` +
          '修法：检查 secrets.spec.ts 的 RULES / SECRET_NAME_RE（这属于守卫自身失效，比漏扫更危险）',
      ).toEqual([])

      const wrongRule = controls
        .filter(([rule, sample]) => !scan(sample, '样本').some((h) => h.rule === rule))
        .map(([rule]) => rule)
      expect(wrongRule, `合成样本命中了错误的规则：${wrongRule.join('、')}`).toEqual([])
    })
  })

  describe('Edge Function 与前端源码', () => {
    it('supabase/functions/** 只用 Deno.env.get 取密钥，没有硬编码 key', () => {
      const entries = trackedFiles().filter((f) => /^supabase\/functions\/.*index\.ts$/.test(f))
      expect(entries.length, '没找到任何 Edge Function 入口（supabase/functions/*/index.ts）').toBeGreaterThan(0)

      const bad: string[] = []
      for (const rel of entries) {
        const src = readIfText(rel) ?? ''
        // 每个函数都必须从运行时环境读 service key 与项目地址
        if (!/Deno\.env\.get\(\s*['"]SUPABASE_SERVICE_ROLE_KEY['"]\s*\)/.test(src)) {
          bad.push(`${rel}：没有用 Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') 取 key`)
        }
        if (!/Deno\.env\.get\(\s*['"]SUPABASE_URL['"]\s*\)/.test(src)) {
          bad.push(`${rel}：没有用 Deno.env.get('SUPABASE_URL') 取项目地址`)
        }
        // 也不允许直接写真实项目地址（<ref>.supabase.co）或 JWT 常量
        if (/https:\/\/[a-z0-9]{15,}\.supabase\.co/.test(src)) {
          bad.push(`${rel}：出现硬编码的 <ref>.supabase.co 项目地址`)
        }
      }

      expect(
        bad,
        `Edge Function 的密钥来源不合规：\n${bad.map((x) => '  ' + x).join('\n')}\n` +
          '修法：一律 const key = Deno.env.get(…)；部署时用 supabase secrets set 注入',
      ).toEqual([])
    })

    it('src/** 里没有硬编码的真实 Supabase 项目地址与长 key 组合', () => {
      const srcFiles = trackedFiles().filter((f) => f.startsWith('src/'))
      const bad: string[] = []
      for (const rel of srcFiles) {
        const src = readIfText(rel)
        if (src === null) continue
        const m = /https:\/\/[a-z0-9]{15,}\.supabase\.co/.exec(src)
        if (m) {
          bad.push(`${rel}:${src.slice(0, m.index).split('\n').length} 出现真实项目地址（前端必须从 import.meta.env.VITE_SUPABASE_URL 读）`)
        }
      }

      expect(
        bad,
        `前端源码里写了云端地址，换库/开源即泄露：\n${bad.map((x) => '  ' + x).join('\n')}\n` +
          '修法：只保留 import.meta.env.VITE_SUPABASE_URL（占位符 xxxx.supabase.co 不受影响，这里要求 15 位以上真实 ref）',
      ).toEqual([])
    })
  })
})

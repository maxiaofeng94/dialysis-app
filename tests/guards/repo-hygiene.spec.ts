// @vitest-environment node
/**
 * 静态守卫 · 仓库卫生
 *
 * 交付流程决定了两件事：APK 是**本地/CI 生成物**（不进仓库），构建产物与临时目录也不该入库。
 * 这类东西一旦被 `git add -A` 带进去，仓库会迅速变肥、diff 噪声爆炸，甚至泄露本机环境。
 *
 * 断言：
 * 1. 索引里没有任何构建产物 / 临时物（dist、dist-admin、node_modules、coverage、
 *    android/app/build、android/.gradle、*.apk、.wrangler、supabase/.temp）与编辑器垃圾文件；
 * 2. 没有任何被跟踪的文件大到不像源码（防大二进制误入库；gradle-wrapper.jar 这类必要的例外在上限内）；
 * 3. android/app/build.gradle 的 versionCode 是正整数、versionName 非空（交付要求递增，这里只做形态校验）；
 * 4. 文档里能查到测试命令（README.md / AGENTS.md / docs/*.md 任一）；
 * 5. 生成物目录若存在于本机，应被 .gitignore 忽略（只提示、不失败，避免 CI 与本地行为不一致）。
 *
 * 只读索引 + 文件大小，离线、无凭据。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function read(rel: string): string {
  return readFileSync(`${ROOT}/${rel}`, 'utf8')
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((p) => p.length > 0)
}

/** 生成物 / 临时物 / 编辑器垃圾的路径规则（逐条写清为什么） */
const FORBIDDEN_TRACKED: Array<{ re: RegExp; why: string; fix: string }> = [
  { re: /(^|\/)(dist|dist-admin|dist-ssr)\//i, why: '前端构建产物（npm run build / build:admin 生成）', fix: 'git rm -r --cached <目录>，确认 .gitignore 有 dist 与 dist-admin' },
  { re: /(^|\/)node_modules\//i, why: '依赖目录（npm ci 安装）', fix: 'git rm -r --cached node_modules' },
  { re: /(^|\/)coverage\//i, why: '测试覆盖率报告（npm run test:coverage 生成）', fix: 'git rm -r --cached coverage，确认 .gitignore 有 coverage' },
  { re: /^android\/app\/build\//i, why: 'Gradle 构建产物', fix: 'git rm -r --cached android/app/build' },
  { re: /^android\/\.gradle\//i, why: 'Gradle 本机缓存', fix: 'git rm -r --cached android/.gradle' },
  { re: /(^|\/)\.wrangler\//i, why: 'wrangler 临时目录', fix: 'git rm -r --cached .wrangler' },
  { re: /(^|\/)supabase\/\.temp\//i, why: 'Supabase CLI 临时文件', fix: 'git rm -r --cached supabase/.temp' },
  { re: /\.apk$/i, why: 'APK 是交付产物（本地或 CI 生成，走 Release 直链）', fix: 'git rm --cached <文件>；产物只放在 GitHub Release' },
  { re: /\.zip$/i, why: '打包产物', fix: 'git rm --cached <文件>' },
  { re: /\.(jks|keystore|p12|pfx)$/i, why: '签名密钥材料（公开仓库里等于公开证书）', fix: 'git rm --cached <文件>，密钥只走 CI secret' },
  { re: /(^|\/)google-services\.json$/i, why: 'Firebase 配置（android/.gitignore 已按约定忽略）', fix: 'git rm --cached google-services.json' },
  { re: /(^|\/)local\.properties$/i, why: '本机 SDK 路径配置', fix: 'git rm --cached local.properties' },
  { re: /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i, why: '系统垃圾文件', fix: 'git rm --cached <文件>' },
  { re: /\.(orig|rej|bak|swp|tmp)$/i, why: '合并/编辑器残留', fix: 'git rm --cached <文件>' },
  { re: /~$/i, why: '编辑器备份文件', fix: 'git rm --cached <文件>' },
  { re: /\.log$/i, why: '日志文件', fix: 'git rm --cached <文件>' },
]

/** 本机存在、但属于「跑一次就会重新生成」的目录：只在没被忽略时提示 */
const GENERATED_DIRS = ['coverage', 'dist', 'dist-admin', 'node_modules', '.wrangler', 'supabase/.temp', 'android/app/build', 'android/.gradle']

const MAX_TRACKED_BYTES = 5 * 1024 * 1024

describe('静态守卫 · 仓库卫生', () => {
  const files = trackedFiles()

  describe('索引里没有构建产物与垃圾文件', () => {
    it('dist / node_modules / coverage / build 产物 / APK / 密钥材料都不在索引里', () => {
      const offenders: string[] = []
      for (const rel of files) {
        for (const rule of FORBIDDEN_TRACKED) {
          if (rule.re.test(rel)) offenders.push(`  ${rel}｜原因：${rule.why}｜修法：${rule.fix}`)
        }
      }

      expect(
        offenders,
        `以下不该入库的东西进了 git 索引：\n${offenders.join('\n')}\n` +
          '背景：AGENTS.md 的交付流程里 APK 与构建产物都是本机/CI 生成物，仓库只放源码',
      ).toEqual([])
    })

    it('没有超大文件被误提交（>5MB 视为可疑二进制）', () => {
      const big: string[] = []
      for (const rel of files) {
        try {
          const size = statSync(`${ROOT}/${rel}`).size
          if (size > MAX_TRACKED_BYTES) big.push(`${rel}（${(size / 1024 / 1024).toFixed(1)}MB）`)
        } catch {
          // 稀疏检出里文件可能不在磁盘上：跳过
        }
      }

      expect(
        big,
        `索引里有超大文件：[${big.join('、')}]\n` +
          '修法：大文件不要直接提交（APK 走 GitHub Release，图片先压缩）；确实需要就用 Git LFS',
      ).toEqual([])
    })
  })

  describe('Android 版本号形态', () => {
    it('versionCode 是正整数、versionName 非空', () => {
      const gradle = read('android/app/build.gradle')

      const codeRaw = /versionCode\s+([^\s/]+)/.exec(gradle)?.[1]
      expect(codeRaw, 'android/app/build.gradle 里没有 versionCode').toBeDefined()
      const code = Number(codeRaw)
      expect(
        Number.isInteger(code) && code > 0,
        `versionCode 解析为 "${codeRaw}"（必须是从 1 开始的整数）：Android 用它在覆盖安装时判断新旧，` +
          '非整数/不递增会导致手机拒绝安装（提示"应用未安装"）',
      ).toBe(true)

      const name = /versionName\s+["']([^"']*)["']/.exec(gradle)?.[1]
      expect(
        name && name.trim().length > 0,
        'versionName 为空：交付的 APK 名称与"设置 → 应用信息"里都会是空白，用户无法确认版本',
      ).toBe(true)
    })
  })

  describe('文档同步', () => {
    it('README.md / AGENTS.md / docs 里能查到测试命令（npm test / npm run test / vitest）', () => {
      const docs = [
        'README.md',
        'AGENTS.md',
        ...readdirSync(`${ROOT}/docs`)
          .filter((f) => f.endsWith('.md'))
          .map((f) => `docs/${f}`),
      ]

      const withCmd = docs.filter((rel) => {
        try {
          const src = read(rel)
          return /npm\s+test|npm\s+run\s+test|vitest/.test(src)
        } catch {
          return false
        }
      })

      expect(
        withCmd,
        '没有任何文档提到怎么跑测试（npm test / vitest）：新人（和 CI）无从下手\n' +
          '修法：在 README.md 的「构建与自检」小节补一句 `npm test`，或维护 docs/测试说明.md',
      ).not.toEqual([])

      if (!withCmd.includes('README.md')) {
        console.log(`[repo-hygiene] 提示：测试命令目前只在 ${withCmd.join('、')} 里提到，README.md 还没写（建议补一句，README 是入口）`)
      }
    })
  })

  describe('生成物目录的忽略状态（提示项，不做硬失败）', () => {
    it('本机存在的生成物目录都应被 .gitignore 忽略', () => {
      const notIgnored: string[] = []
      for (const dir of GENERATED_DIRS) {
        if (!existsSync(`${ROOT}/${dir}`)) continue
        try {
          execFileSync('git', ['check-ignore', '-q', '--', `${dir}/__probe__`], { cwd: ROOT, stdio: 'ignore' })
        } catch (err) {
          const status = (err as { status?: number }).status
          if (status === 1) notIgnored.push(dir) // 1 = 没被忽略
          else throw err
        }
      }

      if (notIgnored.length) {
        console.log(
          `[repo-hygiene] 提示：本机存在但未被 .gitignore 忽略的生成物目录：${notIgnored.join('、')}（git status 会一直显示为未跟踪，注意别 git add -A）`,
        )
      }
      expect(Array.isArray(notIgnored)).toBe(true)
    })
  })
})

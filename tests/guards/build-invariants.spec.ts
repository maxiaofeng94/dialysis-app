// @vitest-environment node
/**
 * 静态守卫 · 构建 / 发布不变式
 *
 * 这些约定都踩过坑（见 AGENTS.md 第五节），但**编译器和构建都发现不了**：
 * - `android/gradlew` 在 Windows 上提交会掉成 100644 → Linux runner 直接 Permission denied；
 * - `npx cap sync android` 会改写 `capacitor.build.gradle` / `capacitor.settings.gradle`，
 *   漏提交 → 别人 clone 后构建的 APK 缺原生插件（如 `@capacitor/preferences`，登录态存不住）；
 * - CI 里 `cap sync` 必须排在 `npm run build` **之后**，否则打进包的是旧 web 产物（甚至退化成单机版）；
 * - 后台产物必须是 `dist-admin/index.html`（closeBundle 提升），否则 Pages 根路径 404；
 * - `build` 脚本必须带 `vue-tsc`（类型检查一旦丢了，等于放弃类型安全）；
 * - `capacitor.config.json` 的 webDir 只能是 `dist`（写成 dist-admin 会把后台打进 APK）；
 * - workflow 里 `uses: ./.github/workflows/x.yml` 指向的文件必须存在，否则 GitHub Actions
 *   会判定「invalid workflow file」——整条流水线静默失效（APK 与部署都不再跑）。
 *
 * 只读文本、只调一次 `git ls-files -s`，离线、无凭据。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function read(rel: string): string {
  return readFileSync(`${ROOT}/${rel}`, 'utf8')
}

/** 工作流目录（从磁盘读：新加的 workflow 可能还没提交） */
function workflowFiles(): string[] {
  return readdirSync(`${ROOT}/.github/workflows`).filter((f) => /\.ya?ml$/.test(f))
}

/** 去掉 YAML 行注释：防止「注释里提到某命令」影响顺序断言 */
function stripYamlComments(yaml: string): string {
  return yaml
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, '$1'))
    .join('\n')
}

function gitLsFiles(args: string[]): string[] {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
}

describe('静态守卫 · 构建与发布不变式', () => {
  describe('Android 工程', () => {
    it('android/gradlew 在 git 索引里的模式是 100755', () => {
      const lines = gitLsFiles(['ls-files', '-s', '--', 'android/gradlew'])

      if (lines.length === 0) {
        // 文件不在索引里就跳过（并明确说明），否则会误报
        console.log('[build-invariants] 跳过：android/gradlew 不在 git 索引里（Android 工程可能被移除了）')
        return
      }

      const mode = lines[0].split(/\s+/)[0]
      expect(
        mode,
        `android/gradlew 的索引模式是 ${mode}（应为 100755）：CI 的 Linux runner 执行 ./gradlew 会直接 Permission denied\n` +
          '修法：git update-index --chmod=+x android/gradlew && git commit（Windows 上提交容易掉成 100644）',
      ).toBe('100755')
    })

    it('cap sync 生成的原生插件注册文件必须被跟踪', () => {
      const tracked = new Set(gitLsFiles(['ls-files']))
      const must = ['android/app/capacitor.build.gradle', 'android/capacitor.settings.gradle']
      const missing = must.filter((f) => !tracked.has(f))

      expect(
        missing,
        `这些文件没有进 git 索引：[${missing.join(', ')}]\n` +
          '它们是 npx cap sync android 生成的原生插件注册表，漏提交会让别人 clone 后构建的 APK 缺插件' +
          '（例如 @capacitor/preferences 缺失 → 登录态存不住，每次打开都要重新登录）\n' +
          '修法：npx cap sync android 之后把改动一并提交',
      ).toEqual([])
    })
  })

  describe('GitHub Actions 工作流', () => {
    const files = workflowFiles()

    it('deploy.yml / deploy-admin.yml / build-apk.yml 都在', () => {
      const missing = ['deploy.yml', 'deploy-admin.yml', 'build-apk.yml'].filter((f) => !files.includes(f))
      expect(
        missing,
        `缺少工作流：[${missing.join(', ')}]（当前目录：${files.join(', ')}）\n` +
          '修法：App 部署 / 后台部署 / APK 构建是三条独立流水线，缺一条对应产物就断了',
      ).toEqual([])
    })

    it('存在跑测试的工作流（ci.yml / test.yml 任一，含 vitest 或 npm test）', () => {
      const withTests = files.filter((f) => {
        const src = stripYamlComments(read(`.github/workflows/${f}`))
        return /vitest|npm\s+run\s+test|npm\s+test|test:coverage/.test(src)
      })

      expect(
        withTests,
        '没有任何工作流跑测试：推送前门禁形同虚设\n' +
          '修法：新增 .github/workflows/ci.yml（或可复用的 test.yml）并加入 `npm test` / `npm run test:coverage` 步骤',
      ).not.toEqual([])
    })

    it('所有 uses: ./.github/workflows/x.yml 指向的文件都存在', () => {
      const missing: string[] = []
      for (const f of files) {
        const src = read(`.github/workflows/${f}`)
        const re = /uses:\s*\.\/\.github\/workflows\/([\w.-]+\.ya?ml)/g
        let m: RegExpExecArray | null
        while ((m = re.exec(src)) !== null) {
          if (!existsSync(`${ROOT}/.github/workflows/${m[1]}`)) missing.push(`${f} → ${m[1]}`)
        }
      }

      expect(
        missing,
        `工作流引用了不存在的可复用工作流：\n${missing.map((x) => '  ' + x).join('\n')}\n` +
          'GitHub Actions 会把整条流水线判为 invalid workflow file（不是报错提醒，是根本不会跑）\n' +
          '修法：补上被引用的文件，或把 uses: 改成实际存在的文件名',
      ).toEqual([])
    })

    it('deploy.yml 里有 npm run build', () => {
      const src = stripYamlComments(read('.github/workflows/deploy.yml'))
      expect(
        /npm\s+run\s+build\b/.test(src),
        'deploy.yml 没有 `npm run build`：部署到 Cloudflare Pages 的产物从哪来？',
      ).toBe(true)
    })

    it('deploy-admin.yml 里有 npm run build:admin 且校验 dist-admin/index.html', () => {
      const src = stripYamlComments(read('.github/workflows/deploy-admin.yml'))
      expect(
        /npm\s+run\s+build:admin\b/.test(src),
        'deploy-admin.yml 没有 `npm run build:admin`：后台会部署成空目录',
      ).toBe(true)
      expect(
        /dist-admin\/index\.html/.test(src),
        'deploy-admin.yml 没有校验 dist-admin/index.html：closeBundle 提升失效时 Pages 根路径会 404（历史上踩过）',
      ).toBe(true)
    })

    it('build-apk.yml 里 npm run build 排在 cap sync android 之前', () => {
      const src = stripYamlComments(read('.github/workflows/build-apk.yml'))
      const buildAt = src.search(/npm\s+run\s+build\b/)
      const syncAt = src.search(/cap\s+sync\s+android/)

      expect(buildAt, 'build-apk.yml 里没有 npm run build').toBeGreaterThanOrEqual(0)
      expect(syncAt, 'build-apk.yml 里没有 npx cap sync android').toBeGreaterThanOrEqual(0)
      expect(
        buildAt < syncAt,
        'build-apk.yml 里 cap sync android 排在了 npm run build 之前：会把旧 web 产物（甚至单机版）打进 APK\n' +
          '修法：先 `npm run build`（注入生产库配置），再 `npx cap sync android`',
      ).toBe(true)

      // 兜底：即使某个平台丢了可执行位，CI 也能跑起来（AGENTS.md 明确写了这条）
      expect(
        /chmod\s+\+x\s+gradlew/.test(src),
        'build-apk.yml 缺 `chmod +x gradlew` 兜底：gradlew 权限一旦掉成 100644，CI 直接 Permission denied',
      ).toBe(true)
    })
  })

  describe('npm 脚本与 Vite 配置', () => {
    it('package.json 有 test / test:coverage / build / build:admin 四个脚本', () => {
      const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> }
      const scripts = pkg.scripts ?? {}
      const missing = ['test', 'test:coverage', 'build', 'build:admin'].filter((s) => !scripts[s])
      expect(
        missing,
        `package.json 缺脚本：[${missing.join(', ')}]（CI 的 test.yml / deploy*.yml 直接按名字调用，缺了就整条红）`,
      ).toEqual([])
      expect(
        /vitest/.test(scripts.test ?? ''),
        `test 脚本是 "${scripts.test ?? ''}"：应当跑 vitest（npm test 是所有人推送前的入口）`,
      ).toBe(true)
    })

    it('build 脚本包含 vue-tsc（类型检查不能丢）', () => {
      const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> }
      const build = pkg.scripts?.build ?? ''
      expect(
        /vue-tsc/.test(build),
        `build 脚本是 "${build}"，不含 vue-tsc：类型错误会一路进产物（AGENTS.md 第四节：提交前 npm run build 必须通过 = 类型检查 + 构建）`,
      ).toBe(true)
    })

    it('vite.admin.config.ts 保留产物提升逻辑（closeBundle + index.html）', () => {
      const src = read('vite.admin.config.ts')
      expect(
        /closeBundle/.test(src),
        'vite.admin.config.ts 没有 closeBundle：后台产物会停在 dist-admin/admin/index.html，Pages 根路径 404',
      ).toBe(true)
      expect(
        /index\.html/.test(src),
        'vite.admin.config.ts 没有提到 index.html（产物提升逻辑被改坏了？）',
      ).toBe(true)
    })

    it('capacitor.config.json 的 webDir 是 dist（不是 dist-admin）', () => {
      const cfg = JSON.parse(read('capacitor.config.json')) as { webDir?: string; android?: Record<string, unknown> }
      expect(
        cfg.webDir,
        `capacitor.config.json 的 webDir 是 "${cfg.webDir}"：必须是 dist（App 产物）。` +
          '写成 dist-admin 会把后台管理端打进 APK，既白屏又泄露管理入口',
      ).toBe('dist')
      expect(
        cfg.android?.webContentsDebuggingEnabled,
        'capacitor.config.json 没关掉 WebView 远程调试：debuggable 的 WebView 可被 adb/chrome://inspect 接管，读登录态与病历缓存',
      ).toBe(false)
    })
  })
})

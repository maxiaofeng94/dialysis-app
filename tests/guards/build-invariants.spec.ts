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

/** 去掉注释，避免把说明文字里的内容当成代码（本项目其他守卫同款实现） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
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

  describe('PWA 预缓存上限（构建不能因主包体积而整份失败）', () => {
    /**
     * 中级-2（第八轮测试有效性评审）：`vite.config.ts` 的 workbox 预缓存上限**零测试守护**。
     *
     * 实测过的失败现场：主包 `index-*.js` 2,098 kB 超过 workbox 默认 2 MiB 上限时，
     * `npm run build` 会在打印「✓ built in 899ms」**之后**抛出：
     *   error during build: Configure "workbox.maximumFileSizeToCacheInBytes" ...
     *   - assets/index-*.js is 2.1 MB, and won't be precached.
     * 而同一份代码 `npx vitest run` 是 **1813 条全绿** —— 也就是说测试层面对此完全无感，
     * 很容易「测试全绿就推送」，然后在 CI 里构建失败。
     *
     * 所以这里用静态断言把「必须显式抬高预缓存上限」钉住。
     */
    it('vite.config.ts 必须显式抬高 workbox 预缓存上限（主包已超 2 MiB 默认值）', () => {
      const src = stripComments(read('vite.config.ts'))
      expect(
        /workbox\s*:\s*\{/.test(src),
        'vite.config.ts 里没有 workbox 配置块。主包已超 2 MiB 默认预缓存上限，' +
          '缺了它会**整个构建失败**（error during build: PLUGIN_ERROR），而不是只丢预缓存。',
      ).toBe(true)

      // ⚠️ 第十轮独立评审轻微-2：上面两个匹配都是「全文件首个」，挡不住「块被挪到错的分支」。
      // vite.config.ts 是 `DISABLE_SW ? [...] : [VitePWA({ workbox: {...} })]` 的二元分支：
      // 若有人把 workbox 挪到 DISABLE_SW 那侧（原生壳分支，本来就不该有 SW），
      // Web 构建会重新踩回 2 MiB 上限，而守卫全绿。所以这里钉住位置关系。
      const vitePwaAt = src.indexOf('VitePWA(')
      const workboxAt = src.indexOf('workbox')
      expect(vitePwaAt, 'vite.config.ts 里找不到 VitePWA( —— 守卫的定位前提变了').toBeGreaterThanOrEqual(0)
      expect(
        workboxAt > vitePwaAt,
        'workbox 配置块跑到了 VitePWA( 前面：它必须在 VitePWA 的选项里，否则等于没配。',
      ).toBe(true)
      // DISABLE_SW 分支（原生壳）在前、SW 分支在后；workbox 必须落在**后者**里
      const disableSwAt = src.indexOf('DISABLE_SW')
      expect(disableSwAt, 'vite.config.ts 里找不到 DISABLE_SW —— 守卫的定位前提变了').toBeGreaterThanOrEqual(0)
      expect(
        workboxAt > disableSwAt,
        'workbox 配置块跑到了 DISABLE_SW 分支里（原生壳不该有 Service Worker）：' +
          'Web 构建会重新踩回 workbox 默认 2 MiB 上限 → npm run build 整个失败。',
      ).toBe(true)

      const m = src.match(/maximumFileSizeToCacheInBytes\s*:\s*([^,\n]+)/)
      expect(
        m,
        'vite.config.ts 没有设置 maximumFileSizeToCacheInBytes：' +
          '主包 2.1 MB 超过 workbox 默认 2 MiB → npm run build 失败（报错在 built in 之后才出现，极易漏看）',
      ).toBeTruthy()

      // 解析实参：只接受能静态求值的写法。
      //
      // ⚠️ 第十轮独立评审轻微-1：原来直接 `expr.split('*')` 逐段 Number() 相乘，
      // 遇到 `4 * 1024 ** 2`（值等价于 4194304，合法 JS）会拆成 ["4 "," 1024 ",""," 2"]，
      // 中间空串 `Number('') === 0` 且 isFinite(0) === true → 不报「无法求值」，
      // 而是算出 0 字节，最终红在「期望恰好 4 MiB」，文案把人引向「值配小了」。
      // 现在先整体求值（`**` / `<<` / `0x` 都能算对），失败再退回按 `*` 拆。
      const expr = m![1].trim()
      let bytes: number
      const whole = Number(expr)
      if (Number.isFinite(whole)) {
        bytes = whole
      } else {
        const parts = expr.split('*').map((x) => x.trim())
        // 空串是 `**`（幂运算）被拆出来的痕迹，必须明确拒绝，不能当 0 吞掉
        const bad = parts.find((part) => part === '' || !Number.isFinite(Number(part)))
        expect(
          bad === undefined,
          `maximumFileSizeToCacheInBytes 的表达式「${expr}」含无法静态求值的项「${bad ?? ''}」，` +
            '守卫没法判断它够不够大。请写成 4 * 1024 * 1024 这种形式。',
        ).toBe(true)
        bytes = parts.reduce((acc, part) => acc * Number(part), 1)
      }
      // 第九轮独立评审轻微-3：原来断言「≥ 2.5 MiB」，比配置值（4 MiB）松 ——
      // 主包从 2.1 MB 慢慢涨到 3.9 MB 时守卫照样绿，等于没守住体积失控。
      // 改成**精确等于 4 MiB**：谁把这个值改小（哪怕是「省点预缓存」）都会立刻红，
      // 逼迫改动者显式面对「主包已经 2.1 MB」这件事。
      expect(
        bytes,
        `maximumFileSizeToCacheInBytes 是 ${bytes} 字节（${(bytes / 1024 / 1024).toFixed(2)} MiB），` +
          '期望恰好 4 MiB（4 * 1024 * 1024）。\n' +
          '调小它会让「主包 2.1 MB」重新顶破预缓存上限 → npm run build 整个失败；\n' +
          '⚠️ 而且抬上限只是**止血**不是解法：正解是代码分割（ECharts / Vant 按需 / 后台模块懒加载）。',
      ).toBe(4 * 1024 * 1024)
    })
  })

  describe('Service Worker 与原生壳（白屏防线）', () => {
    it('build-apk.yml 用 DISABLE_SW=1 构建 web 产物', () => {
      const src = stripYamlComments(read('.github/workflows/build-apk.yml'))
      expect(
        /DISABLE_SW:\s*["']?1["']?/.test(src),
        'build-apk.yml 没有给 web 产物设 DISABLE_SW=1：APK 里会带上 Service Worker，' +
          '覆盖安装后旧 SW 返回旧 index.html、旧 hash 资源已被清 → 脚本 404 → 白屏',
      ).toBe(true)
    })

    it('build-apk.yml 在 cap sync 前校验 dist 里没有 sw.js / registerSW.js', () => {
      const src = stripYamlComments(read('.github/workflows/build-apk.yml'))
      const checkAt = src.search(/dist\/sw\.js/)
      const syncAt = src.search(/cap\s+sync\s+android/)

      expect(checkAt, 'build-apk.yml 没有校验 dist 里的 Service Worker（DISABLE_SW 失效不会被发现）').toBeGreaterThanOrEqual(0)
      expect(
        checkAt < syncAt,
        'sw.js 的存在性校验必须排在 cap sync android 之前，否则已经把 SW 拷进 android 工程了',
      ).toBe(true)
    })

    it('vite.config.ts 按 DISABLE_SW 决定是否启用 VitePWA', () => {
      const src = read('vite.config.ts')
      expect(
        /DISABLE_SW/.test(src),
        'vite.config.ts 不认 DISABLE_SW：APK 构建关不掉 Service Worker',
      ).toBe(true)
      expect(
        /VitePWA\(/.test(src),
        'vite.config.ts 里没有 VitePWA：Web 端会失去离线能力',
      ).toBe(true)
    })

    it('MainActivity 在 WebView 创建前清掉残留的 Service Worker 数据', () => {
      const src = read('android/app/src/main/java/com/dialysis/record/MainActivity.java')

      expect(
        /Service Worker/.test(src),
        'MainActivity 没有清 WebView 的 Service Worker 目录：老用户覆盖安装后仍会撞上旧 SW 白屏',
      ).toBe(true)
      expect(/app_webview/.test(src), 'MainActivity 没有定位到 app_webview 数据目录').toBe(true)

      // 从 onCreate 方法体内部比较，避免匹配到方法上方的注释
      const methodAt = src.search(/public void onCreate/)
      const dropAt = src.indexOf('dropStaleServiceWorkerData();', methodAt)
      const superAt = src.indexOf('super.onCreate(', methodAt)
      expect(methodAt, 'MainActivity 没有覆写 onCreate').toBeGreaterThanOrEqual(0)
      expect(dropAt, 'MainActivity 的 onCreate 里没有调用清理').toBeGreaterThanOrEqual(0)
      expect(superAt, 'MainActivity 的 onCreate 里没有调用 super.onCreate').toBeGreaterThanOrEqual(0)
      expect(
        dropAt < superAt,
        '清理必须排在 super.onCreate() 之前 —— 那之后 WebView 已经创建、目录会被占用',
      ).toBe(true)

      // 只清 Service Worker 子树：业务数据（IndexedDB）与登录态（SharedPreferences）不能动。
      // 这里匹配的是**删除路径**而不是注释里的字样。
      expect(
        /Default\/Service Worker/.test(src),
        'MainActivity 的删除目标不是 Default/Service Worker',
      ).toBe(true)
      expect(
        !/Default\/(IndexedDB|Local Storage|Session Storage|Web Data|shared_prefs)/.test(src),
        'MainActivity 的清理范围越界了：只允许删 Service Worker 目录，' +
          'IndexedDB（本地业务数据 / 云端缓存）与 SharedPreferences（登录态、当前病人）一概不能碰',
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

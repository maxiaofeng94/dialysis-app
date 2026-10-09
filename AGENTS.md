# 项目工作区指令（透析记录 App）

> 本文件由 DSH 自动加载，**本工作区（含子目录）的所有会话都必须遵守**。
> 优先级：用户当前指令 > 本文件 > 通用习惯。

---

## 一、交付流程（改代码后必须按三步走）

### 第 1 步 · 先起本地预览，等用户确认

- UI/交互改动 → `npm run dev`（http://127.0.0.1:5173 ，连**测试库**，带热更新，最快）
- 后台管理端改动 → `npm run dev:admin`（http://127.0.0.1:5174 ，连**测试库**）
- 需要真实数据/构建产物 → `npm run build` 后 `npm run preview`（http://127.0.0.1:4173 ，连**生产库**）
- 用后台任务启动；端口已被占用就**复用**，不要重复起；改动涉及 `.env`、路由、依赖、构建配置时必须重启服务
- 启动后**验证可达**（`curl -s -o NUL -w "%{http_code}" <url>` 应为 200），然后告诉用户：**确切地址 + 该看哪个页面 + 预期效果**
- **停下等用户确认**，不要自行进入第 2、3 步

### 第 2 步 · 用户确认后才推送（触发自动部署）

- 推送前自查：`npm test` 全绿、`npm run build` 通过；未把 `.env`、`.env.production`、token 等加入提交
- 装过 `npm run hooks:install` 后，`git push` 会自动先跑「类型检查 + 全部测试」，不通过就中止推送（急事可 `SKIP_TESTS=1 git push`）
- CI 侧同一套门禁（`.github/workflows/test.yml`）是**部署与出包的前置**：`deploy.yml` / `deploy-admin.yml` / `build-apk.yml` 都 `needs: test`，测试不过不会发布
- `git push origin main` → GitHub Actions（`.github/workflows/deploy.yml`）自动构建并部署到 Cloudflare Pages
- 生产地址：https://dialysis-49v.pages.dev （项目 `dialysis`）
- 推送后查结果：`https://api.github.com/repos/maxiaofeng94/dialysis-app/actions/runs?per_page=1`（公开仓库，免 token）
- 部署完成后**验证线上产物**（见第六节）

### 第 3 步 · APK（已自动化，本地打包仅作兜底）

推送后 `.github/workflows/build-apk.yml` 会**自动构建 APK 并发布到 Release**，手机可用固定直链下载安装（签名与本机一致，可覆盖安装）：

```
https://github.com/maxiaofeng94/dialysis-app/releases/download/latest/dialysis-recorder.apk
```

只有在**还没推送、或 CI 不可用/需要立即拿包**时，才按下述方式本地构建：

```powershell
npm run build                                   # 确保 dist 最新
npx cap sync android                            # 同步 web 产物与插件注册
$env:ANDROID_HOME = "D:\ai\project\android-sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:JAVA_HOME = "D:\Program Files\jdk-17.0.14"
Set-Location android                            # 必须进 android 目录
# 应急兜底（debug 包，debuggable=true，仅本地自测用）：
& "D:\ai\project\android-build\gradle\gradle-8.7\bin\gradle.bat" assembleDebug --console=plain
# 要与线上一致的 release 包（debuggable=false；签名沿用本机 keystore，可与 CI 产物互相覆盖）：
$env:KEYSTORE_PATH = "$env:USERPROFILE\.android\debug.keystore"
& "D:\ai\project\android-build\gradle\gradle-8.7\bin\gradle.bat" assembleRelease --console=plain
Set-Location ..
```

- 产物：debug 包在 `android/app/build/outputs/apk/debug/app-debug.apk`，release 包在 `android/app/build/outputs/apk/release/app-release.apk` → 复制到项目根，命名 `透析记录-多人版-<版本>.apk`，用 `present` 交付
- 功能有变化时递增 `android/app/build.gradle` 的 `versionCode` / `versionName`
- 交付时提醒用户：**覆盖安装，不要卸载**（卸载会清空 App 本地数据）

### 例外

- **纯文档改动**（`README.md`、`docs/*.md`、`AGENTS.md`）可直接提交推送，但仍要告知用户
- 用户明确说"直接推/不用看"时，可跳过第 1 步
- 不得跳过用户已知晓的验收环节做静默发布

---

## 二、环境与凭据（禁止把任何密钥写进本文件）

| 用途 | 说明 |
|---|---|
| 生产库 | Supabase 项目 `dialysis`（东京区），前端配置 `.env.production` |
| 测试库 | Supabase 项目 `dialysis-test`（含测试账号与假数据），前端配置 `.env` |
| 切换规则 | `npm run dev` 读 `.env`；`npm run build` 读 `.env.production` |
| 敏感文件 | `.env`、`.env.production` 已 git 忽略，**绝不能提交**；PAT/token 只走环境变量或临时文件 |
| PAT 存放位置 | 项目根 `.supabase-pat.local`（被 `.gitignore` 的 `*.local` 忽略，**绝不入库**）：`TEST_REF`/`TEST_PAT` = 测试库，`PROD_REF`/`PROD_PAT` = 生产库。跑 SQL / 部署函数时**从这个文件读**，例如 `$env:SUPABASE_ACCESS_TOKEN = ((Select-String .supabase-pat.local -Pattern '^PROD_PAT=').Line -replace '^PROD_PAT=','')`。⚠️ 本仓库是**公开仓库**，PAT 一旦写进任何入库文件，就等于公开两个 Supabase 项目的控制权 |
| 后端 | `supabase/schema.sql`（可重复执行）+ `supabase/functions/{register,create-patient,invite-member,admin-api}` |
| 前端托管 | Cloudflare Pages 项目 `dialysis`，GitHub Actions（`deploy.yml`）自动部署 |
| 后台托管 | Cloudflare Pages 项目 `dialysis-admin`（https://dialysis-admin.pages.dev ），由 `deploy-admin.yml` 自动部署；产物 `dist-admin/`，**不进 APK** |
| 管理员名单 | Supabase 表 `public.admins`（后台无自助提权入口，首个管理员用 SQL Editor 手动 insert） |
| 移动端 | Capacitor Android；CI 出的是 **release** 包（`debuggable=false`，关掉 WebView 远程调试与 run-as 取数），与本地兜底的 debug 包**同一 keystore**、可互相覆盖安装 |
| APK 产物 | GitHub Release `latest` 的 `dialysis-recorder.apk`，由 `build-apk.yml` 自动构建；手机直链 https://github.com/maxiaofeng94/dialysis-app/releases/download/latest/dialysis-recorder.apk |
| APK 签名 | CI 用 secret `ANDROID_DEBUG_KEYSTORE_BASE64` 还原**本机既有的 keystore**，通过 `KEYSTORE_PATH` 交给 Gradle（`DEBUG_KEYSTORE_PATH` 仍兼容），debug 与 release 同源。⚠️ 换掉这份密钥材料 = 换证书 = 用户必须卸载重装（会丢 App 本地数据） |

---

## 三、项目速览

- 技术栈：Vue 3 + Vite + TypeScript + Vant 4 + Dexie(IndexedDB) + ECharts + Capacitor
- **双模式**：不配 `.env` → 纯本地单机版；配了 → 手机号密码登录走 Supabase 多人版
- 数据访问统一走 `src/repo/`：
  - `localRepository.ts` 本地 IndexedDB；`lib/cloudRepository.ts` Supabase；
  - `repo/cachedRepository.ts` 云端的「缓存优先 + 后台刷新」包装（缓存实现 `lib/cloudCache.ts`）；
  - `repo/index.ts` 按登录态动态切换
- 页面：`src/views/`（Home / Session / Report / Trend / Settings / Login / Members）
- **后台管理端**（独立入口，与 App 两套产物互不影响）：
  - 前端入口 `admin/index.html` + `src/admin/**`（Element Plus + hash 路由），构建 `npm run build:admin` → `dist-admin/index.html`（Vite root 是项目根；dev 用中间件把 `/` 指向 `/admin/index.html`，构建后用 `closeBundle` 把产物提升为 `index.html`，否则 Pages 根路径 404）
  - 后端唯一入口 `supabase/functions/admin-api/`（action 分发 + 查 `public.admins` 鉴权 + 写 `admin_audit_logs`）
  - **隐私边界：后台看不到任何病历明细**（刻意不动 `sessions` / `blood_pressures` 等表的 RLS），只给账号、成员关系、病人基础配置与记录聚合数字 —— 不要"顺手"开放
  - 文档：`docs/后台管理系统设计说明.md`、`docs/后台管理系统部署指南.md`

---

## 四、改代码的硬性约定

- 提交前 `npm run build` 必须通过（= `vue-tsc` 类型检查 + `vite build`）
- 提交信息用中文，说清「改了什么、为什么」
- 数据库结构变更要同步四处：`supabase/schema.sql`、`src/types.ts`、`cloudRepository` 映射、`localRepository`（以及 `lib/migrate.ts` 迁移逻辑）
- 云端页面的请求用 `Promise.all` **并行**发出，不要串行 `await` 叠加网络往返
- 含输入表单的页面（详情页、设置页）**不要**让后台缓存刷新自动覆盖用户正在输入的内容
- 推送前扫一遍敏感信息（`sbp_` / `eyJhbGciOi` / `service_role` / anon key 实值），确认没有进 diff

---

## 五、踩坑清单（重犯即事故）

### Supabase / 云端

- Edge Function 里 `supabase.auth.getUser()` **无参永远拿不到用户**（service 客户端自身没有 session）→ 必须 `getUser(req.headers.get('Authorization') 里的 token)`
- 前端调 Edge Function 要带 `Authorization: Bearer <用户 access_token>` **且** `apikey` 头；只有注册接口可以用 anon key
- 改过 `supabase/schema.sql` 后**必须重新执行一次**；脚本是幂等的（`drop policy if exists` + `add column if not exists`），重复跑不清数据
- RLS 策略里引用外层表列必须带表名（如 `users.id`）：`patient_members` 也有 `id` 列，裸写会被解析成 `pm.user_id = pm.id`（恒假），导致同一病人的其他成员看不到记录人姓名
- `sessions.operator_id` 外键必须指向 `public.users`；指向 `auth.users` 时 PostgREST 关联不出记录人姓名
- 部署函数：`npx supabase functions deploy <name> --project-ref <ref> --use-api`，其中 **register 必须加 `--no-verify-jwt`**（注册时用户还没登录）
- 本地数据迁移：本地病人 id 是 `patient-default`（**不是 uuid**），云端主键是 uuid → 必须重映射，并同步改所有子表的 `patient_id` / `session_id`
- RLS 拦截是**静默过滤**：删除 0 行也返回 204，判断是否被拦要看**数据是否还在**，不能只看状态码
- Supabase PAT 有权限边界：可操作项目（跑 SQL、部署函数），但建项目属组织级操作（常见 403），项目名单 API 也可能不可见
- 管理员标记**绝不能**加在 `public.users` 上：`users_update` 策略允许用户更新自己那一行，等于开了自我提权后门 → 用独立表 `public.admins`，且**不建任何写策略**
- `security definer` 函数要给调用面收口：`revoke all on function ... from public`，再按需 `grant execute ... to service_role`，否则任何登录用户都能执行（`is_admin()` 是唯一例外，RLS 策略需要它）
- `admin-api` 必须**保持默认 JWT 校验**（恰好与 `register` 的 `--no-verify-jwt` 相反）
- 用户列表的「最后登录时间 / 禁用状态」在 `auth.users` 里，PostgREST 读不到（不暴露 auth schema，service_role 也一样）→ 只能用 Admin API `auth.admin.listUsers` 分页取，再与 `public.users` 合并
- **「首页 200 但页面白屏」**：dev server 返回 HTML 200 不代表能用，入口脚本可能 404 或被 SPA fallback 成 HTML。动过 `vite.admin.config.ts` 的 root 或 HTML 里的脚本路径后，必须跑 `npm run check:admin-dev`，别只看首页状态码

### 云端读写（读/写/删各有各的坑）

- **读接口必须 `if (error) throw error`**：PostgREST 出错时 `data` 为 null，`(data ?? []).map(...)` 会把「查询失败」静默变成「没有数据」——断网/401 时首页显示「请先建立病人档案 / 暂无透析记录」，用户以为数据全丢了，可能去重建档案或导入备份（二次伤害）。**写接口同理**：`savePatient` 曾用 `update`，命中 0 行时 PostgREST 不报错，档案改动「看着保存成功其实没写进去」→ 所有写一律 `upsert`，或显式检查影响行数
- **RLS 对删除是静默过滤**（删 0 行也返回 204、error 为 null）→ 前端删除必须 `.delete().eq('id', id).select('id')` 把被删的行要回来，空数组就抛错；否则会「删了又复活」：前端以为成功、清缓存跳走，几秒后缓存刷新记录重现（`cloudRepository` 的 `assertDeleted()`）
- **不要写别人的 `operator_id`**：`sessions_insert` / `sessions_update` 的 `with check` 强制 `operator_id = auth.uid()`，想「保留原记录人」反而会让整条更新被拒（还是静默的）。所以记录人语义目前是「最后修改人」；要真正区分创建人/最后修改人得加列 + 触发器，不能只改前端
- **`patients_insert` 不给普通用户**：前端从不直接插病人（新建走 `create-patient` EF 用 service_role），策略留成 `auth.uid() is not null` 等于人人可插，配合 `savePatient` 的 upsert，`currentPatientId` 是脏值时会在云端插出没有任何成员的「孤儿」档案

### Android / APK

- gradle **必须在 `android` 目录**执行；在项目根跑会报 `Run gradle init to create a new Gradle build in this directory`
- **`android/gradlew` 必须保持 100755**：Windows 上提交会变成 100644，Linux runner 执行 `./gradlew` 直接 Permission denied；CI 里已加 `chmod +x gradlew` 兜底，但改动权限后仍要 `git ls-files -s android/gradlew` 确认是 100755
- CI 构建 APK 前**必须先 `npm run build` + `npx cap sync android`**，否则打进包里的 web 产物是旧的（甚至退化成单机版）；workflow 已内置这一步与产物校验
- `npx cap sync android` 会改写 `android/app/capacitor.build.gradle` 与 `android/capacitor.settings.gradle`（原生插件注册）——**必须一并提交**，否则别人 clone 后构建的 APK 会缺插件（例如 `@capacitor/preferences` 缺失会导致登录态存不住）
- gradle 即使 `BUILD SUCCESSFUL`，PowerShell 也可能因 stderr 报 `[exit code: 1]`，属正常噪音，看 BUILD 行判断成败
- 验证产物：`aapt2 dump badging <apk>` 看 versionCode/版本名；解包确认连的是生产库 —— `tar -xf <apk> -C <dir>`（`Expand-Archive` 不接受 `.apk` 扩展名）

### Windows / PowerShell 环境

- 给 `curl.exe` 传 JSON body 时引号会被 PowerShell 吃掉 → 把 body 写进临时文件再用 `--data-binary "@file"`
- 调 HTTP API、生成/解析 JSON **优先写 Node 脚本**（`[System.IO.File]::WriteAllText` + `node`），不要硬拼 PowerShell 字符串
- `git commit -m "…"` 的消息里**不要嵌双引号**，否则参数会被拆成 pathspec 导致提交失败
- PowerShell 5.1 直接读 UTF-8 中文文件可能显示乱码，**文件本身没问题**（是终端按 ANSI 解码）→ 用 node 读一次确认
- 本机没有全局 `supabase` / `wrangler`，用 `npx --yes supabase@latest` / `npx --yes wrangler@4` 即可

### 前端缓存与数据

- 云端缓存必须在**登出时清空**（`lib/cloudCache.ts` 的 `cacheClear()`），否则换账号会先看到上一个账号的数据
- 本地单机数据与云端缓存是**两个独立 IndexedDB**：`dialysis-db`（业务）与 `dialysis-cloud-cache`（缓存），不要混用
- 缓存 key 约定：`patient:` / `dryWeights:` / `session:` / `sessions:` / `bps:` / `bgs:` / `bfs:` / `ars:` / `myPatients:` / `members:`；写操作后要同步更新或删除对应 key
- 本地 IndexedDB 升级用 Dexie `version(n).stores(...)`，新增非索引字段无需升版本，但读取时要兼容旧数据（参见 `localRepository.normalizeSession`）
- **「缓存优先 + 后台刷新」必须有 `FRESH_MS` 闸门**：命中缓存就无条件后台刷新并 `cacheVersion++`，会和页面的 `watch(cacheVersion)` 组成自激循环（成员页曾因此每轮打一次 join 查询）。`cloudAdmin` 的两个读函数就漏了这道闸门，现已对齐 `cachedRepository.cacheFirst`
- **导入备份要「先整份校验 → 再在事务里清库写入」**：先 `clear()` 再 `bulkPut()` 的话，JSON 能解析但字段不合法时数据已经全清空，界面却只说「文件格式不正确」（数据没了却不知道）。现在 `localRepository.importAll` 先校验（结构/每行 id/version），失败时一个字节都不动

### 移动端输入与不可逆操作（本轮修复新增）

- **输入清洗必须处理全角标点**：`el.value.replace(/,/g, '.')` 只认半角逗号，中文输入法的「，」会被 `[^\d.]` 直接删掉 → `70，5` 变成 `705`（**10 倍体重误差**）。要用 `/[,，]/g` 并把「中文逗号/全角」写进测试
- **数值要有量程校验**：只判 `parseNum != null` 时，体重 0、血糖 999、粘贴进来的 `-5` 都能入库（Vant 的 number 输入实际允许一个前导负号）
- **每个写操作按钮都要 in-flight 守卫**：云端下一次保存要等网络，没有 loading/disabled 时用户会连点 ——「立即创建」连点两次就是两条透析记录，子记录弹窗同理
- **写失败必须给提示**：对非技术用户，「没有报错」＝「已经存好了」。曾经详情页所有写操作都没有 `catch`，断网时填的体重/血压静默丢失；同一项目的成员页却每个写操作都有 try/catch + toast
- **不可逆操作（导入覆盖、迁移到云端、删除、退出登录）要二次确认并写清后果**：包括「会删掉哪几个病人、共多少条记录」「本机数据会被覆盖且无法撤销」
- **「负数」在业务界面上要钳制**：脱水量算出来是「上机前实际体重 − 干体重」，称重忘了扣轮椅或干体重填错时会得到 -20 之类的值，
  直接显示「计划脱水 -20.0 L」会被家属读成「要往身体里输 20 升」→ 三个脱水量统一 `Math.max(0, x)`（`calc.ts` 的 `nonNegative`）。
  **但体重本身不钳制**：那是原始测量值，填错了要照实显示，否则用户永远发现不了

### GitHub Actions / CI

- **CI 红了却看不到日志**：GitHub 的完整 job 日志**需要登录**才能看（页面上的日志是懒加载的，未登录时 DOM 里根本没有内容）。
  公开仓库可以走 **check-run annotations**（免 token）：`GET /repos/<owner>/<repo>/actions/runs?per_page=N` 找 run →
  `GET .../actions/jobs/<job_id>` 拿 `check_run_url` → `GET <check_run_url>/annotations`。
  所以值得在 workflow 里把失败关键信息转成注解：`... | sed 's/^/::error::/'`。
  ⚠️ **每个 check-run 最多 50 条注解**，超了静默截断——诊断输出压到 5~6 行（曾输出 60 行覆盖率表格，把真正的错误挤没了）。
- **同一个提交、不同 workflow 跑同一套测试却一绿一红 = 测试不稳定（flaky）**，不是 runner 配置差异，别往那个方向查。
- **「测试全过、覆盖率达标，但退出码是 1」** → 几乎一定是 **Unhandled Errors**（见下一节）。
- **`paths:` 过滤**：`deploy-admin.yml` / `build-apk.yml` 只在特定路径变化时触发，**改测试或 workflow 不会触发部署**。
  要让后台/APK 重新出包，提交里必须包含 `src/**`、`public/**`、`admin/**` 这类路径；
  `workflow_dispatch` 需要权限（没 token 时无法手动重跑），所以只能靠再推一个匹配 paths 的提交。
- **CI 不会部署 Edge Functions**：`functions deploy` 只在本地手动跑（推送后别忘了，否则线上函数还是旧版）。
- 查状态比看页面快：`GET /repos/maxiaofeng94/dialysis-app/actions/runs?per_page=20`，再用 `run.jobs_url` 拿步骤级结论。

### 测试环境（vitest + jsdom）

- **「测试全过但退出码 1」的头号原因：未处理的错误**。vitest 把它打印在 `Test Files / Tests` 汇总**之前**，
  只看输出尾部会漏掉。本项目踩到的是 **Vant 的 Tabs/Swipe 挂的 `setTimeout`** 在 jsdom 销毁后才触发，
  抛 `window is not defined`。修法在 `tests/setup/setup.ts`：包装 `window.setTimeout` 记录 id，`afterEach` 里清掉。
  ⚠️ 这类问题**本地（Windows/快）常常躲过、CI（Linux/慢）几乎必现**，「本地全绿」不能当作 CI 会绿的理由。
- **`.env` 必须隔离**：`vitest.config.ts` 用 `envDir` 指向不存在的 `tests/.no-env`，`setup.ts` 再断言
  `VITE_SUPABASE_*` 为空。本机 `.env` 连的是测试库，一旦被带进测试，同一份用例在本地与 CI 的表现就会不一致。
- **假 Supabase 要支持多级排序**（`.order().order()`）：只保留最后一次 `order` 会让二级排序键失效，出现假绿。
- 断言 toast/提示时**必须过滤可见性**（见「浏览器实测」），否则读到的是历史残留。

### PWA 与生产产物

- **Service Worker 会缓存旧脚本**：部署完新版本后，用户（和验证时的你）可能仍看到旧版。
  实测生产环境前先清再刷新，否则会对着旧代码下结论（本轮就误判过一次）：
  ```js
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister()
  for (const k of await caches.keys()) await caches.delete(k)
  ```
- **别只看首页 HTML 判断版本**（浏览器会缓存它）：用 `fetch('/?v=' + Date.now(), { cache: 'reload' })` 抓最新 HTML，
  再看 `/assets/index-*.js` 的 hash 有没有变。
- **Vant 图标字体默认从 `at.alicdn.com` 加载**（运行时注入 @font-face）：生产 CSP 是 `font-src 'self' data:`，
  回退用的 woff 会被拦（控制台每次报 violation），**离线时图标直接空白**——对信号差的医院是硬伤。
  已本地化：字体放 `public/fonts/`，用 `.van-icon` 支持的 `--van-icon-font-family` 变量指向本地族名，
  样式在 `src/styles/vant-icon-font.css`，**必须 import 在 `vant/lib/index.css` 之后**。

### 浏览器实测（Playwright MCP）

- **Vant 的 toast / popup 关闭后 DOM 仍在**（只是高度/透明度为 0）：读提示必须过滤可见性，否则会拿到上一条历史提示、
  得出完全错误的结论；`body.innerText` 里也会残留已关闭弹窗的文本，不能据此判断「弹窗还开着」。
  ```js
  [...document.querySelectorAll('.van-toast')].find((e) => e.getBoundingClientRect().height > 0)?.innerText
  ```
- **元素定位的坑**：Vant 按钮是 `<button><span>文字</span></button>`，用 `children.length === 0` 匹配不到，要用
  `textContent.includes()`；数值常被拆进多个 `<span>`，`textContent === '7.8 mmol/L'` 会失败，改成 `closest('.card')`
  后在容器里找；`van-dialog` 只用于 `showDialog`，**普通弹窗是 `.van-popup`**，Element Plus 则是 `.el-dialog`。
- **弹窗操作优先用原生 DOM 点击**（`page.evaluate` 里 `el.click()`），比 locator 稳，省掉「不可见/不稳定」的重试等待。
- **验证下载型功能**（导出备份、报告图片）用 `page.on('download')` + `download.createReadStream()` 读内容，
  比只看「有没有触发下载」可靠得多，还能顺带核对备份里的表与条数。
- **`page.evaluate` 注入 DOM 当探针**很好用：插一个 `<i class="van-icon">` 再看 `document.fonts` 的状态，
  就能判断图标字体到底加载没有。
- **只读实测的纪律**：详情页/设置页的输入框有**防抖自动保存**，`fill()` 一下就等于改了线上数据。
  只读验证只做「导航 + 读文本 + 点页面跳转」，**绝不碰输入框、绝不点保存/创建/删除类按钮**。
- 未登录/只读状态下可测的面比想象中大：路由守卫、表单校验、错误文案、静态资源、响应头、manifest、SW，
  以及**产物里连的是哪个库**（grep 打包 JS 里的 `<ref>.supabase.co`）。

### Vite dev server（本地预览）

- **`--force` 会重建 `node_modules/.vite`**，而多个 dev server 共享这份缓存 → 其他端口的服务开始报
  `504 (Outdated Optimize Dep)`、页面白屏。要么别用 `--force`，要么把所有 dev server 一起重启。
- **Vite 监听 `.env` 变化并自动重启**：想「临时移走 `.env`」跑单机模式时，一把 `.env` 移回来服务就重启回云端模式。
  正确做法是**整个测试期间保持移走**，测完再恢复（恢复后要验证文件确实回来了）。
- **`npm ci` 会被运行中的 dev server 锁住文件**（Windows 直接报「文件被占用」）→ 先停服务再重装。
- **`npm run dev -- --port 5175` 的端口传不进去**：npm 会吃掉 `--port`、把 `5175` 当成 vite 的 root（页面 404）。
  直接用 `npx vite --port 5175`。

---

## 六、验证手段（改动后如何自证）

- **测试（推送前必跑）**：`npm test` —— 单元 / 数据层 / 组件 / Edge 接口 / 静态守卫；
  `npm run test:coverage` 带覆盖率阈值（CI 用这条）；`npm run verify` = 测试 + 两个构建。
  测试跑在**纯本地模式**（`.env` 被 `envDir` 隔离），要验云端分支须 `vi.mock('src/lib/supabase')`。
  静态守卫会把「敏感信息不得入库 / 后台不得碰病历表 / 结构三处同步 / gradlew 权限」等约定固化下来 —— 改了相关文件却忘了同步，这里会红。详见 `docs/测试说明.md`
- **构建**：`npm run build`（App）/ `npm run build:admin`（后台）
- **后台页面冒烟**：`npm run smoke:admin` —— 用 SSR 把 8 个后台页面各渲染一遍，抓「构建期发现不了」的问题（模板运行时错误、组件名写错被静默渲染成空）
- **后台预览资源链**：先起 `npm run dev:admin`，再跑 `npm run check:admin-dev` —— 沿 import 递归请求所有模块，抓「首页 200 但白屏」
- **线上产物连对库没有**：`curl` 首页拿到 `/assets/index-*.js` 路径，抓取该 JS 后 grep 项目 ref，确认是 `.env.production` 里的生产库 ref（而不是测试库的）
- **云端链路**：写 Node 脚本用 anon key + 测试账号跑一遍「注册 → 建病人 → 写记录 → 邀请成员 → 跨账号可见 → 权限拦截」，比点 UI 更彻底
- **Edge Function**：`GET /v1/projects/<ref>/functions` 看 status/verify_jwt 是否符合预期
- **后台越权**：不带 token 调 `admin-api` 应 401；普通用户 token 应 403；管理员直连 PostgREST 查 `sessions` 应读不到别人的病历（完整清单见 `docs/后台管理系统部署指南.md` 第六节）
- **CI 产出的 APK**：从 Release 直链下载后用 `apksigner verify --print-certs` 对比本机 keystore 指纹，并解包确认 web 产物连的是生产库
- **数据库结构**：用 Management API 的 `POST /v1/projects/<ref>/database/query` 跑 `information_schema` / `pg_policies` 查询核对
- 交付结论时给出**可复现的证据**（命令 + 输出），不要只说"应该没问题"

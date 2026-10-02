# 项目工作区指令（透析记录 App）

> 本文件由 DSH 自动加载，**本工作区（含子目录）的所有会话都必须遵守**。
> 优先级：用户当前指令 > 本文件 > 通用习惯。

---

## 一、交付流程（改代码后必须按三步走）

### 第 1 步 · 先起本地预览，等用户确认

- UI/交互改动 → `npm run dev`（http://127.0.0.1:5173 ，连**测试库**，带热更新，最快）
- 需要真实数据/构建产物 → `npm run build` 后 `npm run preview`（http://127.0.0.1:4173 ，连**生产库**）
- 用后台任务启动；端口已被占用就**复用**，不要重复起；改动涉及 `.env`、路由、依赖、构建配置时必须重启服务
- 启动后**验证可达**（`curl -s -o NUL -w "%{http_code}" <url>` 应为 200），然后告诉用户：**确切地址 + 该看哪个页面 + 预期效果**
- **停下等用户确认**，不要自行进入第 2、3 步

### 第 2 步 · 用户确认后才推送（触发自动部署）

- 推送前自查：`npm run build` 通过；未把 `.env`、`.env.production`、token 等加入提交
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
& "D:\ai\project\android-build\gradle\gradle-8.7\bin\gradle.bat" assembleDebug --console=plain
Set-Location ..
```

- 产物 `android/app/build/outputs/apk/debug/app-debug.apk` → 复制到项目根，命名 `透析记录-多人版-<版本>.apk`，用 `present` 交付
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
| 后端 | `supabase/schema.sql`（可重复执行）+ `supabase/functions/{register,create-patient,invite-member}` |
| 前端托管 | Cloudflare Pages 项目 `dialysis`，GitHub Actions 自动部署 |
| 移动端 | Capacitor Android，debug 签名可覆盖安装 |
| APK 产物 | GitHub Release `latest` 的 `dialysis-recorder.apk`，由 `build-apk.yml` 自动构建；手机直链 https://github.com/maxiaofeng94/dialysis-app/releases/download/latest/dialysis-recorder.apk |
| APK 签名 | CI 用 secret `ANDROID_DEBUG_KEYSTORE_BASE64` 还原本机 debug keystore（配合 `DEBUG_KEYSTORE_PATH`），保证与本地同签名 |

---

## 三、项目速览

- 技术栈：Vue 3 + Vite + TypeScript + Vant 4 + Dexie(IndexedDB) + ECharts + Capacitor
- **双模式**：不配 `.env` → 纯本地单机版；配了 → 手机号密码登录走 Supabase 多人版
- 数据访问统一走 `src/repo/`：
  - `localRepository.ts` 本地 IndexedDB；`lib/cloudRepository.ts` Supabase；
  - `repo/cachedRepository.ts` 云端的「缓存优先 + 后台刷新」包装（缓存实现 `lib/cloudCache.ts`）；
  - `repo/index.ts` 按登录态动态切换
- 页面：`src/views/`（Home / Session / Report / Trend / Settings / Login / Members）

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

---

## 六、验证手段（改动后如何自证）

- **构建**：`npm run build`
- **线上产物连对库没有**：`curl` 首页拿到 `/assets/index-*.js` 路径，抓取该 JS 后 grep 项目 ref，确认是 `.env.production` 里的生产库 ref（而不是测试库的）
- **云端链路**：写 Node 脚本用 anon key + 测试账号跑一遍「注册 → 建病人 → 写记录 → 邀请成员 → 跨账号可见 → 权限拦截」，比点 UI 更彻底
- **Edge Function**：`GET /v1/projects/<ref>/functions` 看 status/verify_jwt 是否符合预期
- **CI 产出的 APK**：从 Release 直链下载后用 `apksigner verify --print-certs` 对比本机 keystore 指纹，并解包确认 web 产物连的是生产库
- **数据库结构**：用 Management API 的 `POST /v1/projects/<ref>/database/query` 跑 `information_schema` / `pg_policies` 查询核对
- 交付结论时给出**可复现的证据**（命令 + 输出），不要只说"应该没问题"

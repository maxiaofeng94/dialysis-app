# 项目工作区指令（透析记录 App）

> 本文件由 DSH 自动加载，**本工作区（含子目录）的所有会话都必须遵守**。
> 规则优先级：用户当前指令 > 本文件 > 通用习惯。

---

## 一、改动代码后的交付流程（必须遵守）

**每次修改代码后，不要直接 `git push`，也不要直接打包 APK。必须按下面三步走。**

### 第 1 步 · 本地起预览服务，请用户确认

- 启动服务（用后台任务，不要前台阻塞）：
  - UI/交互改动 → `npm run dev`（默认 http://127.0.0.1:5173 ，连**测试库** `dialysis-test`，带热更新，最快）
  - 需要看真实数据/构建产物 → `npm run build` 后 `npm run preview`（默认 http://127.0.0.1:4173 ，连**生产库** `dialysis`）
- 若该端口已有服务在跑：**复用它**，不要重复启动；若改动涉及 `.env`、路由、依赖、构建配置，必须重启服务再让用户看
- 启动后**必须验证可达**（例如 `curl -s -o NUL -w "%{http_code}" <url>` 返回 200），并把**确切地址 + 该看哪个页面 + 预期效果**一并告诉用户
- 然后**停下来等用户确认**，不要自行继续第 2、3 步

### 第 2 步 · 用户确认后，推送代码触发自动部署

- 仅在用户明确表示"满足预期/可以推"之后执行
- 推送前自查：`npm run build` 必须通过；确认没有把 `.env`、`.env.production`、token 等敏感内容加入提交
- `git push origin main` → GitHub Actions（`.github/workflows/deploy.yml`）自动构建并部署到 Cloudflare Pages
- 生产地址：https://dialysis-49v.pages.dev （项目 `dialysis`）
- 推送后建议查一次运行结果：`https://api.github.com/repos/maxiaofeng94/dialysis-app/actions/runs?per_page=1`（公开仓库，无需 token）

### 第 3 步 · 打包 APK

```powershell
# 1) 确保 dist 最新
npm run build

# 2) 同步到 Android 工程
npx cap sync android

# 3) 构建（注意：gradle 必须在 android 目录执行，在根目录跑会报 "Run gradle init"）
$env:ANDROID_HOME = "D:\ai\project\android-sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:JAVA_HOME = "D:\Program Files\jdk-17.0.14"
Set-Location android
& "D:\ai\project\android-build\gradle\gradle-8.7\bin\gradle.bat" assembleDebug --console=plain
Set-Location ..
```

- 产物：`android/app/build/outputs/apk/debug/app-debug.apk`
- 复制到项目根并命名 `透析记录-多人版-<版本号>.apk`，用 `present` 交付给用户
- 功能有变化时，同步递增 `android/app/build.gradle` 里的 `versionCode` / `versionName`
- 交付时提醒用户：**覆盖安装，不要卸载**（卸载会清空 App 本地数据）

### 例外

- **纯文档改动**（`README.md`、`docs/*.md`、`AGENTS.md`）无需起服务验收，可直接提交推送，但仍要告知用户
- 用户明确说"直接推/不用看/你自己决定"时，可跳过第 1 步
- 无论何种情况，都不得跳过用户已知晓的验收环节做静默发布

---

## 二、环境与凭据（禁止把任何密钥写进本文件）

| 用途 | 说明 |
|---|---|
| 生产库 | Supabase 项目 `dialysis`（东京区），前端配置在 `.env.production` |
| 测试库 | Supabase 项目 `dialysis-test`（含测试账号与假数据），前端配置在 `.env` |
| 切换规则 | `npm run dev` 读 `.env`（测试库）；`npm run build` 读 `.env.production`（生产库） |
| 敏感文件 | `.env`、`.env.production`、`*token*` 均已忽略，**绝不能提交** |
| 后端结构 | `supabase/schema.sql`（可重复执行）+ `supabase/functions/{register,create-patient,invite-member}` |
| 前端托管 | Cloudflare Pages 项目 `dialysis`，GitHub Actions 自动部署 |
| 移动端 | Capacitor Android（debug 签名，可覆盖安装） |

---

## 三、项目速览

- 技术栈：Vue 3 + Vite + TypeScript + Vant 4 + Dexie(IndexedDB) + ECharts + Capacitor
- **双模式**：不配 `.env` → 纯本地单机版；配了 → 手机号密码登录后走 Supabase 多人版
- 数据访问统一走 `src/repo/` 的 `Repository` 接口：
  - `localRepository.ts`：本地 IndexedDB 实现
  - `lib/cloudRepository.ts`：Supabase 实现
  - `repo/cachedRepository.ts`：云端的「缓存优先 + 后台刷新」包装（本地缓存见 `lib/cloudCache.ts`）
  - 运行时代理按登录态自动切换（`repo/index.ts`）
- 页面：`src/views/`（Home / Session / Report / Trend / Settings / Login / Members）

---

## 四、其它约定

- 提交前必须 `npm run build` 通过（= `vue-tsc` 类型检查 + `vite build`）
- 提交信息用中文，说清「改了什么、为什么」
- 数据库结构变更需同步四处：`supabase/schema.sql`、`src/types.ts`、`cloudRepository` 映射、`localRepository`（以及 `lib/migrate.ts` 的迁移逻辑）
- 云端页面的请求要并行发出（`Promise.all`），不要串行 `await` 叠加网络往返
- 含输入表单的页面（详情页、设置页）**不要**让后台缓存刷新自动覆盖用户正在输入的内容
- 遇到云端报错，先看 Edge Function 的鉴权方式（必须显式传用户 access token，service 客户端自身没有 session）

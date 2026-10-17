# 项目工作区指令（透析记录 App）

> 本文件由 DSH 自动加载，**本工作区（含子目录）的所有会话都必须遵守**。
> 优先级：用户当前指令 > 本文件 > 通用习惯。

---

## 一、交付流程（改完代码自动走完，不再逐步等确认）

> 用户已授权：**改完代码自动起预览 → 自动实测 → 自动补测试 → 自动推送部署**。
> 不要停在「起好服务等用户点一下」。只有本节末尾列出的情况才需要先问。

### 第 1 步 · 起测试库预览

- UI/交互改动 → `npm run dev`（http://127.0.0.1:5173 ，连**测试库**，热更新）
- 后台管理端改动 → `npm run dev:admin`（http://127.0.0.1:5174 ，连**测试库**）
- 需要构建产物时 → `npm run build` 后 `npm run preview`（http://127.0.0.1:4173 ，连**生产库**，只读验证用）
- 用后台任务启动；**端口被占用就复用**，不要重复起；改过 `.env` / 路由 / 依赖 / 构建配置必须重启服务
- 起完先确认可达：`curl -s -o NUL -w "%{http_code}" <url>` 应为 200

### 第 2 步 · 用 Playwright MCP 自动实测一遍

对 5173 / 5174 跑**全量功能实测**，不是只确认首页能打开：

- **覆盖面**：登录 / 注册 / 路由守卫 → 首页（病人卡片、快速创建、记录列表分组）→ 记录详情（脱水计算、血压 / 血糖 / 血流量 / 不良反应 / 备注）→ 报告页 → 趋势页（三个分页签）→ 设置页 → 成员页；后台的概览 / 用户 / 病人 / 日志 / 账号
- **改了哪就重点测哪**，并回归相邻功能（改动影响面往往比想象大）
- **断言要核对数值，不是看元素存不存在**：例如「上机前称重 64.3 − 轮椅 13.4 = 上机前实际 50.9」「计划脱水 = 上机前实际 − 干体重」「实际脱水 = 上机前实际 − 下机后实际」「机器超滤 = 计划脱水 + 回水」
- 实测技巧与纪律见第五节「浏览器实测（Playwright MCP）」：**toast 必须过滤可见性**（否则读到上一条历史提示）、弹窗用原生 DOM 点击、注意 Vant 按钮的文字嵌在 `<span>` 里
- 测试库里**可以自由增删改**（那正是它的用途），但测完把临时数据清理掉，别留垃圾账号/病人
- **发现缺陷 → 修 → 重跑实测**，循环到通过；不要带着已知问题进入下一步

### 第 3 步 · 补充 / 调整测试用例

- 把实测中发现的问题**固化成 vitest 用例**（回归防线），不要只修代码
- 新增功能补对应用例；行为变了就同步改已有用例
- `npm test` 全绿，且 `npm run test:coverage` 不低于阈值（改了 `calc.ts` / `cloudRepository` / Edge Function 这类核心逻辑时尤其要补）

### 第 3.5 步 · 提交前的深度评审门禁（评审不通过，不许推送）

> 为什么设成**门禁**而不是「建议做一下」：曾经只给 `saveSession` 加了乐观锁，同一个模式在
> `savePatient` / `replaceAdverseReactions` / `confirmAbort` 上**连续漏了三次** ——
> 每一次都是「测试全绿 + 类型检查通过 + CI 通过」，**没有任何自动防线提醒**；
> 更早那轮的「批量刷新串数据」是改动**自己引入**的失败模式；
> 还有 4 条「假绿」用例（修复前照样通过，等于没有防线）。
> 结论：**测试全绿 ≠ 评审通过**，评审必须是独立的一道门。

#### 3.5.1 谁评审

- **自己**：逐条回答下面的 5 问，答案写进提交信息
- **独立的评审 agent（必须，不能省）**：至少一路，任务是**对抗性审查**（找问题，不是确认它对）。
  自己写的东西自己审有盲区 —— 上面「连漏三次」就是只靠自己看的结果。
  改动大或涉及并发 / 数据一致性时派两路（源码维度 + 测试有效性维度）

#### 3.5.2 评审范围

`git diff <上一个已评审/已发布的提交>..HEAD`，**只评本次改动**，不评整个仓库。

#### 3.5.3 5 问（写出答案，不要只在脑子里过）

1. **影响面**：改的这个函数 / 模块还有谁在调用？他们的假设还成立吗？
   （动 `Repository` 接口、`cloudCache`、`patient` store 这类共用件时，**逐个调用点**看一遍）
2. **同类问题**：同一个模式在别处还有吗？
   （乐观锁连漏三次就是没做这一步；`watch(isLoggedIn)`、写前量程校验、读接口的 `if (error) throw` 同理）
3. **新失败模式**：这次改动**引入**了什么以前不存在的失败可能？
   （`dedupe` 引入「单条读复用整批结果」；乐观锁引入「冲突后重新加载读到缓存旧值」）
4. **反向验证**：如果我是审查者，会从哪里挑刺？边界 / 并发 / 失败路径 / 提示文案 / 数据可恢复性
5. **验证强度**：证据是「测试通过」还是「实测过真实路径」？
   - 只跑单测不够：`savingPatient` 挡住覆盖保存的重试、冲突后读缓存旧值，单测都漏了
   - 只读代码也不够：`currentRole` 残留、`init()` 永久卡死，都是先写一个**会失败的用例**才坐实的
   - 关键用例要做**对抗性验证**：临时把代码回退成改之前的样子，确认用例**真的会红**
     （否则可能是「假绿」—— 守「串数据」的那条用例就曾经恒真）

#### 3.5.4 评审提出的问题**必须有佐证**，否则不采纳

每条问题必须给出下列**至少一项**，没有佐证的只能标成「待确认」并写明验证方法：

- 可复现的触发路径（操作顺序 / 数据状态 / 网络条件）
- 代码证据（`文件:行` + 关键几行）
- 实测证据（命令 + 输出，或浏览器实测到的现象）
- **一个会失败的用例**（先写用例坐实它，再改代码）

⚠️ **反向纪律同样重要**：不能因为「看着可疑」就改代码。
上轮就有一条被复核**证伪**（「首页在记录查询失败时显示空态」——
`Promise.all` 是原子的，三个赋值都不会执行，`loadFailed` 仍为 true，实际不成立）。
误改会引入新风险。

#### 3.5.5 通过标准（不满足就回到开发，**不许推送**）

- 所有**严重 / 中级**问题：**已修** 或 **已证伪（附证据）** 或 **明确记录为已知取舍**（写清理由与影响）
- 新增的 `if` / `catch` / 早返回分支有对应用例；确认的「假绿」用例已改强
- 本次核心风险点做过**对抗性验证**
- 5 问都有答案

#### 3.5.6 不通过就回到开发，直到通过

一轮 = **开发 → 测试 → 评审**。评审不通过（存在未决的严重 / 中级问题）→
**修复 → 补齐用例 → 重新评审**（新一轮，重新派独立评审），
**不允许带着未决问题进入第 4 步的推送**。

#### 3.5.7 能机械化的部分已经写成守卫（跟着 pre-push 跑，不要只靠自觉）

- `tests/guards/optimistic-lock.spec.ts` —— 新增写方法必须**显式归类**「要不要乐观锁」；
  并断言云端确实做了版本比对、缓存层确实回写了新版本、冲突恢复确实走 `fresh` 读
  （已用「注入未归类方法」验证过它会红并点名）
- `tests/guards/session-expiry.spec.ts` —— 每个读云端数据的页面都必须处理「被踢下线」
  （用 `stripComments` 后匹配，注释骗不过它）
- 既有守卫 —— 敏感信息不入库、后台不碰病历表、数据库结构三处同步、启动占位与 ES5 语法

### 第 4 步 · 通过后自动推送部署

- 推送前自查：`npm test` 全绿、`npm run build` 通过、`.env*` 与 token 未进提交，
  以及**第 3.5 步的评审已通过**（5 问有答案、未决问题为零、关键用例做过对抗性验证）
- `git push origin main`（pre-push 钩子会再跑一次「类型检查 + 全部测试」，不过则中止）
- CI 门禁：`deploy.yml` / `deploy-admin.yml` / `build-apk.yml` 都 `needs: test`，测试不过不会发布
- **推送后必须回查结果**：`GET https://api.github.com/repos/maxiaofeng94/dialysis-app/actions/runs?per_page=20` 确认相关工作流 `success`；失败就按第五节「GitHub Actions / CI」排查、修复并重推
- 部署完**验证线上产物**（见第六节）；生产地址 https://dialysis-49v.pages.dev

### 第 5 步 · APK（已自动化，本地构建仅兜底）

推送后 `build-apk.yml` 自动构建并发布，手机直链（签名与本机一致，可覆盖安装）：

```
https://github.com/maxiaofeng94/dialysis-app/releases/download/latest/dialysis-recorder.apk
```

仅在**没推送或 CI 不可用**时本地构建（必须先 `npm run build` + `npx cap sync android`，gradle **必须在 `android` 目录**执行）：

```powershell
$env:DISABLE_SW = "1"   # 必须！原生壳不能带 Service Worker（见第五节「启动与白屏」）
npm run build
if (Test-Path dist\sw.js) { throw "DISABLE_SW 没生效：dist 里仍有 sw.js" }
npx cap sync android
$env:ANDROID_HOME = "D:\ai\project\android-sdk"; $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:JAVA_HOME = "D:\Program Files\jdk-17.0.14"
Set-Location android
& "D:\ai\project\android-build\gradle\gradle-8.7\bin\gradle.bat" assembleRelease --console=plain   # release，与 CI 同签名
Set-Location ..
Remove-Item Env:\DISABLE_SW
```

- 产物在 `android/app/build/outputs/apk/{debug,release}/`，复制到项目根命名 `透析记录-多人版-<版本>.apk`，用 `present` 交付
- 功能有变化时递增 `android/app/build.gradle` 的 `versionCode` / `versionName`
- 提醒用户：**覆盖安装，不要卸载**（卸载会清空 App 本地数据）

### 什么情况仍然要先问用户

自动流程只覆盖**普通代码改动**（功能开发、修 bug、补测试、纯文档）。下面这些影响面超出代码本身，必须先问：

- **生产库的结构或数据变更**：把 `schema.sql` 执行到生产库、跑任何写 SQL、清理生产数据
- **生产库的写操作**：实测只在测试库做，生产环境只做只读验证
- **不可逆操作**：删数据、覆盖式迁移、把本地数据推上云端
- **「换了就回不去」的事**：改 APK 签名材料（= 用户必须卸载重装、丢本地数据）、改公开仓库设置、密钥轮换
- 用户明确说「先给我看效果」「这次别推」

其余情况一路自动走完，中途不需要征求同意。

---

## 二、环境与凭据（禁止把任何密钥写进本文件）

| 用途 | 说明 |
|---|---|
| 生产库 / 测试库 | Supabase 项目 `dialysis`（东京区，配置在 `.env.production`）/ `dialysis-test`（测试账号与假数据，配置在 `.env`） |
| 切换规则 | `npm run dev` 读 `.env`；`npm run build` 读 `.env.production` |
| 敏感文件 | `.env*` 已 git 忽略、**绝不能提交**；PAT 只走环境变量或临时文件 |
| PAT | 项目根 `.supabase-pat.local`（被 `*.local` 忽略）：`TEST_REF`/`TEST_PAT`、`PROD_REF`/`PROD_PAT`。跑 SQL / 部署函数从这里读。⚠️ 公开仓库，PAT 入库 = 交出两个项目的控制权 |
| 后端 | `supabase/schema.sql`（幂等可重跑）+ `supabase/functions/{register,create-patient,invite-member,admin-api}` |
| 托管 | App → Cloudflare Pages `dialysis`；后台 → `dialysis-admin`（https://dialysis-admin.pages.dev ，产物 `dist-admin/`，**不进 APK**） |
| 管理员名单 | 表 `public.admins`（后台无自助提权入口，首个管理员用 SQL Editor 手动 insert） |
| APK 签名 | CI 用 secret `ANDROID_DEBUG_KEYSTORE_BASE64` 还原本机既有 keystore（`KEYSTORE_PATH` 交给 Gradle），debug/release 同源。⚠️ 换密钥 = 换证书 = 用户必须卸载重装 |

---

## 三、项目速览

- 技术栈：Vue 3 + Vite + TypeScript + Vant 4 + Dexie(IndexedDB) + ECharts + Capacitor
- **双模式**：不配 `.env` → 纯本地单机版；配了 → 手机号密码登录走 Supabase 多人版
- 数据访问统一走 `src/repo/`：`localRepository.ts`（IndexedDB）、`lib/cloudRepository.ts`（Supabase）、`repo/cachedRepository.ts`（缓存优先 + 后台刷新，缓存实现在 `lib/cloudCache.ts`）、`repo/index.ts`（按登录态分发）
- 页面：`src/views/`（Home / Session / Report / Trend / Settings / Login / Members）
- **后台管理端**（独立产物，与 App 互不影响）：入口 `admin/index.html` + `src/admin/**`（Element Plus + hash 路由），构建产物 `dist-admin/index.html`（dev 用中间件把 `/` 指向 `/admin/index.html`，构建用 `closeBundle` 提升为 `index.html`，否则 Pages 根路径 404）；后端唯一入口 `supabase/functions/admin-api/`
- **隐私边界：后台看不到任何病历明细**（刻意不动 `sessions` / `blood_pressures` 的 RLS），只给账号、成员关系、病人基础配置与记录聚合数字 —— 不要"顺手"开放。文档见 `docs/后台管理系统设计说明.md`、`docs/后台管理系统部署指南.md`

---

## 四、改代码的硬性约定

- 提交前 `npm run build` 必须通过（= `vue-tsc` + `vite build`）；提交信息用中文，说清「改了什么、为什么」
- 数据库结构变更同步四处：`supabase/schema.sql`、`src/types.ts`、`cloudRepository` 映射、`localRepository`（以及 `lib/migrate.ts`）
- 云端页面的请求用 `Promise.all` **并行**发出，不要串行 `await` 叠加往返
- 含表单的页面（详情页、设置页）**不要**让后台缓存刷新覆盖用户正在输入的内容
- 推送前扫敏感信息（`sbp_` / `eyJhbGciOi` / `service_role` / anon key 实值）确认没进 diff

---

## 五、踩坑清单（重犯即事故）

### Supabase / 云端

- `supabase.auth.getUser()` **无参永远拿不到用户**（service 客户端自身没 session）→ 必须传入请求头里的 token
- 前端调 Edge Function 要带 `Authorization: Bearer <access_token>` **且** `apikey` 头；只有注册接口能用 anon key
- **改过 `schema.sql` 必须重新执行**（幂等，重复跑不清数据）：`drop policy if exists` + `add column if not exists`
- RLS 策略里引用外层表列**必须带表名**（`users.id`）：`patient_members` 也有 `id`，裸写会解析成 `pm.user_id = pm.id`（恒假），导致看不到记录人姓名
- `sessions.operator_id` 外键必须指向 **`public.users`**；指向 `auth.users` 时 PostgREST 关联不出记录人姓名
- **RLS 拦截是静默过滤**：删除 0 行也返回 204、error 为 null → 判断是否被拦要看**数据是否还在**，不能只看状态码（详见下一节）
- 管理员标记**绝不能**放 `public.users`（`users_update` 允许改自己那行 = 自我提权后门）→ 独立表 `public.admins`，且**不建任何写策略**；`users` 的 UPDATE 权限已收窄到仅 `name` 列
- `security definer` 函数要收口：`revoke all ... from public` 再按需 `grant execute ... to service_role`。例外是 `is_admin()` / `is_member()` —— RLS 策略需要所有角色可执行
- 部署函数：`npx supabase functions deploy <name> --project-ref <ref> --use-api`；**`register` 必须加 `--no-verify-jwt`**（注册时还没登录），`admin-api` 反过来**必须保持默认 JWT 校验**
- 本地迁移：本地病人 id 是 `patient-default`（**不是 uuid**）→ 必须重映射，并同步改子表的 `patient_id` / `session_id`
- 「最后登录时间 / 禁用状态」在 `auth.users` 里，PostgREST 读不到（service_role 也一样）→ 只能走 Admin API `auth.admin.listUsers` 分页取，再与 `public.users` 合并
- PAT 有权限边界：能跑 SQL、部署函数，但建项目属组织级操作（常见 403），项目名单 API 也可能不可见
- **「首页 200 但页面白屏」**：dev server 返回 200 不代表能用（入口脚本可能 404 或被 SPA fallback 成 HTML）→ 动过 `vite.admin.config.ts` 的 root 或脚本路径后，必须跑 `npm run check:admin-dev`

### 云端读写（读 / 写 / 删各有各的坑）

- **读接口必须 `if (error) throw error`**：PostgREST 出错时 `data` 为 null，`(data ?? []).map(...)` 会把「查询失败」静默变成「没有数据」——断网时首页显示「请先建立病人档案」，用户以为数据全丢、可能去重建档案（二次伤害）
- **写接口同理**：`savePatient` 曾用 `update`，命中 0 行时不报错 → 档案「看着保存成功其实没写进去」。所有写一律 `upsert` 或显式检查影响行数
- **删除必须复查行数**：`.delete().eq('id', id).select('id')` 把被删的行要回来，空数组就抛错（`cloudRepository` 的 `assertDeleted()`）。否则会「删了又复活」——前端以为成功、清缓存跳走，几秒后刷新记录重现
- **不要写别人的 `operator_id`**：`sessions_insert/update` 的 `with check` 强制 `operator_id = auth.uid()`，想"保留原记录人"反而让整条更新被拒（且静默）。记录人语义目前是「最后修改人」；要区分创建人得加列 + 触发器
- **`patients_insert` 不给普通用户**：前端从不直接插病人（新建走 `create-patient` EF 用 service_role）。留成 `auth.uid() is not null` 等于人人可插，配上 upsert 语义，`currentPatientId` 是脏值时会在云端插出没有成员的「孤儿」档案
- **本地默认 id 别拿去查云端**：`patient-default` 不是 uuid，PostgREST 直接 400 → 读接口抛错、首页显示成「加载失败」。`cloudRepository` 已对这类 id 短路返回空

### 启动与白屏（用户反馈「打开经常一片空白」的根因）

- **原生壳绝不能带 Service Worker**。覆盖安装后 WebView 里还是上一次的 SW 与预缓存，它用
  `NavigationRoute` 返回**旧的 `index.html`**；而旧 HTML 引用的旧 hash 资源会被新 SW 的
  `skipWaiting` + 预缓存清理删掉 → 脚本 404 → 白屏。
  - 原生端：构建时关掉（`DISABLE_SW=1`，见 `vite.config.ts`；`build-apk.yml` 已设并有 dist 守卫）
  - Web 端：保留 SW（离线可用），但必须在 `controllerchange` 后**自动 reload**（`src/main.ts`），
    否则「旧页面 + 新 SW」同样 404。⚠️ 首次注册的 `controllerchange` 只是「SW 接管了本页」，
    别 reload —— 每次第一次访问都会白刷一下
- **老用户覆盖安装要清残留**：新 APK 里没有 `sw.js` 时，SW 的更新检查会 404 → 浏览器自动注销它，
  但那一屏可能仍是旧的。真正的兜底是 **`MainActivity.onCreate` 在 WebView 创建前删掉
  `app_webview/*/Default/Service Worker`** —— Web 侧的 unregister 要等页面脚本跑起来，
  而白屏恰恰发生在脚本跑起来之前。⚠️ **只删这一棵子树**，IndexedDB（业务数据 / 云端缓存）与
  SharedPreferences（登录态、当前病人）一概不能碰（`build-invariants.spec.ts` 有断言守着）
- **`#app` 不能是空的**：2MB 的首屏包在低端机上要解析几秒，以前这段时间就是纯白。现在
  `index.html` 里有内联样式的启动占位，以及「打开失败 → 重新打开」兜底（只对 SCRIPT /
  stylesheet 的加载失败报错 —— 图标 404 不该把正常页面换成错误页）。
  ⚠️ 占位必须在 `#app` **外面**，放里面会被 `app.mount()` 清掉
- **不要在模块顶层 `app.mount()`**：路由守卫要 await 登录态恢复与病人校准，这期间 `router-view`
  是空的 —— 提前挂载会先清掉占位、再渲染出一片空白，用户看到的仍是白屏。现在等
  `router.isReady()` 再挂载，另有 12 秒兜底挂载 + `App.vue` 的 `routeReady` 占位
- **守卫里每个 await 都要有上限**：`getSession()` 在 token 过期时会顺手刷新、`listMyPatients()`
  是网络请求，弱网下都可能挂住 → 永久白屏。统一用 `utils/timeout.ts` 的 `withTimeout` 封顶
- ⚠️ **内联引导脚本必须用 ES5**（老 WebView 解析不了箭头函数 / 模板字符串 = 直接白屏），
  `tests/guards/boot-splash.spec.ts` 会断言这一点

### 网络与登录（用户反馈「总要提示网络失败，多点几次才行」）

- **supabase-js 既不超时也不重试**：手机上首次请求要现做 DNS + TLS 握手，偶发直接失败，
  用户看到「网络连接失败」、再点一次（连接已建立）就好了。
  - `lib/supabase.ts` 注入带超时的 `resilientFetch`（15 秒）；**只在 fetch 层对 GET/HEAD 的
    连接类失败**自动重试
  - 写入类（POST）与超时中止（AbortError）**一律不重试**：前者可能重复插入记录，
    后者请求可能已经到达服务端并被处理
  - 登录 / 注册的重试放在 `stores/auth.ts` 里显式做（3 次，退避 500 / 1500ms）
- **只有「网络类」失败才值得重试**，判定必须用 supabase 返回的**英文原文** ——
  `friendlyAuthMessage` 转成中文之后就认不出来了，会把密码错误也重试三遍
- **后台管理端与 App 端必须用同一套超时**：`src/admin/lib/supabase.ts` 与
  `src/admin/lib/api.ts` 曾经都没有超时（前者缺 `global.fetch`，后者是裸 fetch）——
  弱网下后台页面会永久转圈，因为「超时是唯一能让 finally 跑起来的东西」。
  `lib/resilientFetch.ts` **无依赖**，两边共用；改完记得对照两端别再走散
- **`currentUid()` 只能读本地登录态**（`readPersistedUser()`）：`getUser()` 每次都要发
  一趟 `/auth/v1/user`，失败时会被 `if (!uid) return []` 静默变成「一个病人都没有」；
  换成 `getSession()` 也不够 —— 它在 token 过期时会顺手刷新，弱网下挂住会把路由守卫里的
  病人校准一起拖住（实测进首页要 20 秒）
- 后端返回的**业务错误不重试**：密码错、账号被禁、注册手机号已存在，重试一万次也一样
- 验证手段：用 Playwright 的 `page.route` 把 `**/auth/v1/token**` 第一次 `abort`，
  断言请求数 = 2 且间隔 ≈500ms；再断言「密码错误」时请求数 = 1
- **首屏耗时要有量化概念**：生产库（东京）实测**首次**请求 1489ms、后续 ~310ms ——
  那 1.2 秒就是 DNS + TLS 握手的成本，也正是「再点一次就好了」的原因
- **登录页要先「预检 + 预热」**：用户反馈「App 只开移动数据时一登录就报网络异常」。
  `preflightCloud()`（GoTrue 的 `/auth/v1/health`，8 秒封顶）在进页面时跑一次 ——
  能连上就把 DNS + TLS 握手提前做掉；连不上就显示「当前网络连不上服务器」+「重新检测」，
  **别让用户填完手机号再干等 15 秒 × 3 次重试**。探测不抛错、不阻塞提交（可能只是抖动）
- **`index.html` 的 preconnect 由 vite 插件注入**（`supabasePreconnect`，域名取自 `.env*`）：
  用户还在输手机号时连接就建好了。换库不用改插件，但**要确认 `_headers` 的 CSP `connect-src`
  仍允许该域名**，否则 preconnect 会被静默忽略（不报错、只是没生效）
- **重试必须可见**：`login(phone, password, onRetry?)` 的第三个参数用于显示
  「网络较慢，正在重试（第 N/3 次）…」—— 15 秒 × 3 的等待毫无反馈，用户只会以为卡死、反复点
- **退出登录后「直接回 /login」也必须作废病人上下文**：设置页的退出登录是 `await logout()` 之后
  **直接** `router.replace('/login')`，守卫走的是 `to.path === '/login'` 那条分支并直接 `return` ——
  从前那里不重置 `patientContextUid`，于是**重新登录同一个账号**时被判定成「上下文已建好」、
  跳过 `ensureCloudPatient()`；而登出时 `clearCurrentPatient()` 已经把当前病人抹成
  `patient-default`（本地默认 id，**不是 uuid**），首页拿它去查云端会被 `cloudRepository`
  短路成空 → **一个病人、一条记录都没有**（用户报的「APK 重新登录后没有任何记录、Web 端却有」
  就是这个：Web 端一直登录着走冷启动路径，`patientContextUid` 是 undefined，所以看不出来）
  - 三道防线 + `tests/router/router.spec.ts` 的回归用例：①回到登录页就作废 `patientContextUid`；
    ②`currentPatientId` 仍是默认值时一律重新校准；③首页在「已登录 + 当前病人是默认 id」时
    自己补一次校准（防守卫超时/被绕过）
  - 通用教训：**凡是「跨登录态的模块级缓存」（uid、当前病人、上下文标记），登出路径上必须显式作废** ——
    别指望「跳登录页」顺带清理，守卫的分支顺序常常不给你这个机会

### 启动与白屏 · APK 还有一条独立成因

- **产物语法门槛必须显式压下来**。Vite 8 默认 target 打出的入口 chunk 需要 **ES2022
  （Chrome 94+）**，而 Capacitor 认为「WebView 够用」的门槛只有 **60**
  （`Bridge.DEFAULT_ANDROID_WEBVIEW_VERSION`），`minSdkVersion` 又允许装到 Android 5.1 ——
  中间那一整段设备打开就是入口脚本 SyntaxError → 白屏，且 Capacitor 不拦、只静默加载。
  → `vite.config.ts` 显式 `build.target: 'es2017'`（实测入口压到 ES2020、体积只 +1%），
  再用 `capacitor.config.json` 的 `minWebViewVersion` + `server.errorPath` 兜住真正太老的设备
  （显示「请更新 Android System WebView」，而不是白屏）
- **`public/boot.js` 必须是真 ES5**：它是最后一道兜底，语法不过关就跟着一起白屏。
  踩过的坑是函数实参**尾随逗号**（ES2017，Chrome 58+）—— 文件头注释写着 ES5 也没用，
  守卫已扩展到箭头函数 / 模板字符串 / let-const / 尾随逗号 / 展开符 / class / async / 可选链

### 生产环境差异（dev 一切正常、线上或真机才暴露）

- **CSP 才是产物的真实约束**：`_headers` 里是 `script-src 'self'`，**内联脚本会被直接拦掉**
  （兜底逻辑等于没写）；dev 环境没有 CSP，所以这类问题**只有线上能发现**。
  `boot.js` 必须保持外链，`tests/guards/boot-splash.spec.ts` 会断言
  「index.html / admin/index.html 都没有内联 script」
- **Cloudflare Pages 把「资源不存在」伪装成 `200 + text/html`**（连 `/assets/xxx.js` 也是），
  配上 `nosniff` 就是 MIME 报错 + 白屏，而状态码是 200 —— 排查时先怀疑
  「HTML 引用的 hash 资源在新部署里没了」，别被 200 骗了
- **`/assets/*` 要长缓存**（文件名自带 hash，`_headers` 已配 `immutable`）；
  但 `/`、`/boot.js`、`/sw.js` **绝不能**长缓存，否则再也更新不了
- **字体要显式写进 `includeAssets`**：workbox 默认的 `globPatterns` 只覆盖 js/css/html，
  漏掉 `fonts/vant-icon.*` 的话离线时图标全空白 —— 正好废掉「字体本地化」的初衷
- **APK 里没有 CSP**（Capacitor 不读 `_headers`）：凡是 Web 端被 CSP 拦下的东西在 APK 里都照跑，
  所以「APK 正常、网页白屏」这类差异会反复出现
- **dev server 的局域网 IP 不是 secure context**：`navigator.share / canShare` 在
  `http://192.168.x.x:5173` 下根本不存在，分享分支只能在 `localhost` 上测

### 前端缓存与数据

- 云端缓存必须在**登出时清空**（`cloudCache.cacheClear()`），否则换账号会先看到上一个账号的数据
- 本地数据与云端缓存是**两个独立 IndexedDB**：`dialysis-db`（业务）与 `dialysis-cloud-cache`（缓存），不要混用
- 缓存 key：`patient:` / `dryWeights:` / `session:` / `sessions:` / `bps:` / `bgs:` / `bfs:` / `ars:` / `myPatients:` / `members:`；写操作后要同步更新或删除对应 key
- Dexie 升级用 `version(n).stores(...)`；新增非索引字段无需升版本，但读取要兼容旧数据（见 `localRepository.normalizeSession`）
- **「缓存优先 + 后台刷新」必须有 `FRESH_MS` 闸门 + 在途去重**：命中缓存就无条件刷新 + `cacheVersion++`，
  会和页面的 `watch(cacheVersion)` 组成自激循环（成员页曾每轮打一次 join 查询）。
  - 闸门只看「上次写入时间」，**管不住「在途」**：刷新还没回来时该 key 依旧是陈旧的，
    于是页面每被唤醒一次就再刷一次。把库请求人为延迟 800ms 后打开趋势页，
    30 秒内打出 **131614 个请求**（血压 63028 + 血糖 62603）且停不下来 ——
    用户反馈的「web 端长期打开后手机发烫、耗电激增」就是它（实测该页静置 20 秒 CPU 占用为 0，
    发烫完全来自请求风暴，不是图表或动画）
  - 修法：`cloudCache.cacheFirstWithRevalidate` / `dedupe` 是**唯一实现**，`cachedRepository` 与
    `cloudAdmin` 共用，别再各写一份（历史上就是一边漏了闸门、另一边漏了 error 检查）
- **一次请求覆盖多个 key 时，要按 key 登记「在刷」**（`cloudCache.shareRefresh` +
  `isRefreshing` / `refreshInFlight`）：写回是逐个 key 落库的，写到一半时页面重读会看到
  「少几个 id」的陈旧集合 —— 只拿这一批 id 列表当去重键的话，键一变就失效、又发一次批量请求。
  把延迟提到 3 秒（= `FRESH_MS`）时表现为「每 3.2 秒刷一轮、几十秒不停」
- **趋势页的子表必须批量拉**：`Promise.all(recent.map(listBloodPressures))` 是 30 次往返，
  血压 + 血糖 = 60 个请求，还各自带一套后台刷新。用 `listBloodPressuresMany` /
  `listBloodGlucosesMany`（PostgREST `in.(…)`，80 个一批分批）：一次请求 + 按 key 回填缓存，
  详情页随后照样命中缓存。实测趋势页 153 个请求 → 5 个
- **页面静置的验收口径**：把库请求延迟 3 秒 + 把 `dialysis-cloud-cache` 所有行的 `updatedAt` 置 0，
  再进页面 —— 请求数应是个位数并且 1~2 秒内收敛（首页 4、趋势页 2、详情页 8、报告页 7、设置页 4、成员页 2）。
  造场景用 `page.route('**/rest/v1/**', …)` 延迟，别只看「首页能打开」
- **导入备份要「先整份校验 → 再在事务里清库写入」**：先 `clear()` 再 `bulkPut()` 时，JSON 能解析但字段不合法，数据已全清空、界面只说「格式不正确」

### 多人同时编辑（乐观锁）

- **整行 `upsert` = last-write-wins，会静默丢数据**：两个家属同时开着同一条透析记录，
  后点保存的人会把先保存的人刚填的体重 / 备注 / 中止原因整段抹掉，双方都毫无察觉。
  → `saveSession(session, expectedUpdatedAt?)` 带版本条件：
  `update … .eq('id', id).eq('updated_at', expected)`，只在版本没变时才写入
- **版本号是 `DialysisSession.updatedAtIso`（库里的原始 ISO 字符串），不是 `updatedAt`**：
  `timestamptz` 是微秒精度，换算成毫秒时间戳再回传会**永远匹配不上** → 变成「永远冲突」。
  读取时 `sessionFromRow` 保留原始字符串，保存成功后必须把它更新成返回值
  （`cachedRepository.saveSession` 负责写回对象与缓存）——否则页面下一次 400ms 防抖保存
  就会拿旧版本去比，**自己跟自己冲突**
- 冲突要给**可操作**的选择，不能替用户决定：
  `ConflictError` → 弹「重新加载（放弃我的修改）/ 覆盖保存（用我的盖掉对方的）」；
  `NotFoundError`（另一端删掉了）→ 提示并回首页，重试没有意义
- ⚠️ **「覆盖保存」必须不带版本条件写（传 `null`）**。曾经写成「先 `getSession()` 取回最新版本号
  再带条件重试」，而 `getSession` 是**缓存优先**的、拿回来的往往还是旧版本 → 又冲突一次、
  再弹一次窗，用户点了覆盖却什么都没写进去（实测：界面显示 62.5，库里还是 62）。
  用户既然明确选了覆盖，就 `upsert` 无条件写
- 判断冲突用 `err.name`（`lib/errors.ts` 的 `isConflictError`），不要用 `instanceof` ——
  同一份代码可能被打进不同 chunk，跨 bundle 的 `instanceof` 会失效
- 子表不需要乐观锁：血压 / 血糖 / 血流量是按 id **追加删除**（不会互相覆盖）；
  只有不良反应是「整表替换」，用 `savingReactions` 串行化 + 失败回滚勾选

### 移动端输入与不可逆操作

- **输入清洗要处理全角标点**：`replace(/,/g,'.')` 只认半角，中文输入法的「，」会被 `[^\d.]` 删掉 → `70，5` 变成 `705`（**10 倍体重误差**）。用 `/[,，]/g` 并写进测试
- **数值要量程校验**：只判 `parseNum != null` 时，体重 0、血糖 999、粘贴的 `-5` 都能入库（Vant 的 number 输入允许前导负号）
- **每个写操作按钮都要 in-flight 守卫**：云端保存要等网络，没 loading/disabled 时用户会连点 ——「立即创建」连点两次就是两条记录
- **写失败必须给提示**：对非技术用户「没有报错」＝「已经存好了」。详情页曾所有写操作都没 `catch`，断网时填的体重静默丢失
- **不可逆操作要二次确认并写清后果**（导入覆盖、迁移、删除、退出登录）：包括「会删掉哪几个病人、多少条记录」
- **业务数值为负要钳制**：脱水量 = 上机前实际体重 − 干体重，称重忘了扣轮椅时会得到 -20 之类，显示「计划脱水 -20.0 L」会被读成「要输 20 升」→ 三个脱水量统一 `Math.max(0, x)`（`calc.ts` 的 `nonNegative`）。**但体重本身不钳制**（原始测量值要照实显示，否则发现不了填错）

### 移动端布局与交互（真机才暴露）

- **`viewport-fit=cover` 必须配安全区适配**：`index.html` 声明了 cover，页面会一直铺到
  iPhone 的刘海 / 灵动岛区域 —— 而**状态栏那一块会拦截触摸**，顶部导航不加
  `padding-top: env(safe-area-inset-top)` 就成了「看得见、点不到」
  （实际症状：首页右上角的「＋ 新建」点不动，用户报的「顶部操作栏被遮挡」就是它）。
  底部 tabbar 同理要避开手势条。安全区统一用 `--app-safe-top/bottom` 包一层
  （见 `src/style.css`），这样 Playwright 能覆盖变量复现刘海布局 ——
  `env()` 在桌面浏览器里恒为 0，**不包一层就没法自动化验证**
- ⚠️ 安全区**只加在 `.van-nav-bar` 与 `.van-tabbar--fixed` 上**，不要顺手给 `.page` 也加，
  否则两层 padding 叠加，正常机型上也会多出一大块空白
- **Android 返回键必须自己接管**：Capacitor 只在 JS 侧注册了 `backButton` 监听时才不执行
  系统默认的 `finish()`。不注册 = 在任何页面（**包括弹窗打开时**）按返回都直接退出 App，
  正在弹窗里填的血压 / 血糖全丢 —— 用户的感受就是「App 又没了」。
  优先级：关弹层 → 退回上一页 → 首页双击退出（`src/lib/backButton.ts`）
- ⚠️ 返回键的两个坑：**Vant 弹窗关闭后 DOM 仍在（高度为 0）**，不过滤可见性就永远
  「还有弹窗开着」、返回键彻底失灵；**命令式对话框只能点「取消」** ——
  点确认等于替用户确认了删除记录 / 删除病人这类不可逆操作
- ⚠️ 只在 Android 上接管：iOS 没有系统返回键，而且 Apple 不允许应用主动退出
- 装原生插件后必须 `npx cap sync android`，并把 `android/app/capacitor.build.gradle`、
  `android/capacitor.settings.gradle`、`android/app/src/main/assets/capacitor.plugins.json`
  一并提交，否则别人 clone 后构建的 APK 缺插件

### GitHub Actions / CI

- **CI 红了却看不到日志**：完整 job 日志**需要登录**（页面日志是懒加载的，未登录时 DOM 里没有内容）。公开仓库改走 **check-run annotations**（免 token）：`GET /repos/<o>/<r>/actions/runs` 找 run → `GET .../actions/jobs/<id>` 拿 `check_run_url` → `GET <check_run_url>/annotations`。所以值得把失败关键信息转成注解（`... | sed 's/^/::error::/'`）。⚠️ **每个 check-run 最多 50 条注解**，超了静默截断 —— 诊断输出压到 5~6 行
- **同一提交、不同 workflow 跑同一套测试却一绿一红 = flaky**，别去查 runner 配置
- **「测试全过、覆盖率达标，但退出码 1」** → 几乎一定是 Unhandled Errors（见下节）
- **`paths:` 过滤**：`deploy-admin.yml` / `build-apk.yml` 只在特定路径变化时触发，**改测试或 workflow 不会触发部署**。要重新出包，提交必须包含 `src/**`、`public/**`、`admin/**` 之类路径；`workflow_dispatch` 需要权限，没 token 时只能靠再推一个匹配 paths 的提交
- **CI 不会部署 Edge Functions**：`functions deploy` 只在本地手动跑，推送后别忘了
- 查状态比看页面快：`GET .../actions/runs?per_page=20` + 各 run 的 `jobs_url` 拿步骤级结论

### 测试（vitest + jsdom）

- **「测试全过但退出码 1」的头号原因：未处理的错误**。vitest 把它打印在 `Test Files / Tests` 汇总**之前**，只看尾部会漏掉。本项目踩到的是 **Vant 的 Tabs/Swipe 挂的 `setTimeout`** 在 jsdom 销毁后触发、抛 `window is not defined` → 修法在 `tests/setup/setup.ts`：包装 `window.setTimeout` 记录 id、`afterEach` 清掉。⚠️ 这类问题**本地（快）常躲过、CI（慢）几乎必现**，「本地全绿」≠「CI 会绿」
- **`.env` 必须隔离**：`vitest.config.ts` 的 `envDir` 指向不存在的 `tests/.no-env`，`setup.ts` 再断言 `VITE_SUPABASE_*` 为空。本机 `.env` 连的是测试库，被带进测试就会让本地与 CI 表现不一致
- **假 Supabase 要支持多级排序**（`.order().order()`）：只保留最后一次 `order` 会让二级排序键失效，出现假绿
- 断言 toast/提示**必须过滤可见性**（见下节），否则读到的是历史残留

### 浏览器实测（Playwright MCP）

> 测试库（5173/5174）**可以自由增删改**，这是交付流程第 2 步的主战场；
> 标了「生产环境」的条目只在验线上时适用。

- **〔生产环境〕Service Worker 会缓存旧脚本**：部署后用户（和验证时的你）可能仍看到旧版。实测前先清再刷新，否则会对着旧代码下结论：
  ```js
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister()
  for (const k of await caches.keys()) await caches.delete(k)
  ```
- **别只看首页 HTML 判断版本**（浏览器会缓存它）：`fetch('/?v=' + Date.now(), { cache: 'reload' })` 抓最新 HTML，再看 `/assets/index-*.js` 的 hash 有没有变
- **Vant 图标字体默认从 `at.alicdn.com` 加载**（运行时注入 @font-face）：生产 CSP 是 `font-src 'self' data:`，回退的 woff 被拦、**离线时图标空白**（对信号差的医院是硬伤）。已本地化：字体在 `public/fonts/`，用 `--van-icon-font-family` 指向本地族名，样式 `src/styles/vant-icon-font.css` **必须 import 在 `vant/lib/index.css` 之后**
- **Vant 的 toast / popup 关闭后 DOM 仍在**（只是高度/透明度为 0）：读提示必须过滤可见性，否则会拿到上一条历史提示、得出完全错误的结论；`body.innerText` 也残留已关闭弹窗的文本，不能据此判断「弹窗还开着」
  ```js
  [...document.querySelectorAll('.van-toast')].find((e) => e.getBoundingClientRect().height > 0)?.innerText
  ```
- **元素定位**：Vant 按钮是 `<button><span>文字</span></button>`，`children.length === 0` 匹配不到，要用 `textContent.includes()`；数值常被拆进多个 `<span>`，精确等值会失败，改成 `closest('.card')` 后在容器里找；`van-dialog` 只用于 `showDialog`，**普通弹窗是 `.van-popup`**，Element Plus 是 `.el-dialog`
- **弹窗操作优先用原生 DOM 点击**（`page.evaluate` 里 `el.click()`），比 locator 稳，省掉「不可见/不稳定」的重试
- **验证下载型功能**（导出备份、报告图片）用 `page.on('download')` + `download.createReadStream()` 读内容，比只看"有没有触发下载"可靠，还能核对备份里的表与条数
- **注入 DOM 当探针**：插一个 `<i class="van-icon">` 再看 `document.fonts` 状态，就能判断图标字体到底加载没有
- **〔生产环境〕只读实测纪律**：详情页/设置页输入框有**防抖自动保存**，`fill()` 一下就等于改了线上数据 → 只做「导航 + 读文本 + 点页面跳转」，**绝不碰输入框、绝不点保存/创建/删除类按钮**（测试库不受此限，正常写入才能测出问题）
- 未登录/只读状态可测的面比想象中大：路由守卫、表单校验、错误文案、静态资源、响应头、manifest、SW，以及**产物连的是哪个库**（grep 打包 JS 里的 `<ref>.supabase.co`）

### Vite dev server

- **`--force` 会重建 `node_modules/.vite`**，而多个 dev server 共享这份缓存 → 其他端口开始报 `504 (Outdated Optimize Dep)`、页面白屏。要么别用，要么把所有 dev server 一起重启
- **Vite 监听 `.env` 变化并自动重启**：想「临时移走 `.env`」跑单机模式时，移回来服务就重启回云端模式 → 正确做法是**整个测试期间保持移走**，测完再恢复（并验证文件确实回来了）
- **`npm ci` 会被运行中的 dev server 锁住文件**（Windows 报「文件被占用」）→ 先停服务再重装
- **`npm run dev -- --port 5175` 端口传不进去**（npm 吃掉 `--port`，把 `5175` 当成 vite 的 root → 页面 404）→ 直接 `npx vite --port 5175`

### Android / APK

- gradle **必须在 `android` 目录**执行（在项目根跑会报 `Run gradle init to create a new Gradle build in this directory`）
- **`android/gradlew` 必须保持 100755**：Windows 上提交会变成 100644，Linux runner 执行 `./gradlew` 直接 Permission denied。CI 已加 `chmod +x gradlew` 兜底，改完权限仍要 `git ls-files -s android/gradlew` 确认
- `npx cap sync android` 会改写 `android/app/capacitor.build.gradle` 与 `android/capacitor.settings.gradle`（原生插件注册）——**必须一并提交**，否则别人 clone 后构建的 APK 会缺插件（如 `@capacitor/preferences` 缺失会导致登录态存不住）
- gradle 即使 `BUILD SUCCESSFUL`，PowerShell 也可能因 stderr 报 `[exit code: 1]`，属正常噪音，看 BUILD 行判断成败
- 验证产物：`aapt2 dump badging <apk>` 看 versionCode / 版本名；解包用 `tar -xf <apk> -C <dir>`（`Expand-Archive` 不接受 `.apk` 扩展名）

### Windows / PowerShell

- 给 `curl.exe` 传 JSON body 时引号会被吃掉 → body 写临时文件再用 `--data-binary "@file"`
- 调 HTTP API、解析 JSON **优先写 Node 脚本**，不要硬拼 PowerShell 字符串
- `git commit -m "…"` 消息里**不要嵌双引号**（会被拆成 pathspec 导致提交失败）
- PowerShell 5.1 读 UTF-8 中文文件可能显示乱码，**文件本身没问题**（终端按 ANSI 解码）→ 用 node 读一次确认
- 本机没有全局 `supabase` / `wrangler` → 用 `npx --yes supabase@latest` / `npx --yes wrangler@4`

---

## 六、验证手段（改动后如何自证）

- **测试**：`npm test`（单元 / 数据层 / 组件 / Edge 接口 / 静态守卫）；`npm run test:coverage` 带覆盖率阈值（CI 用这条）；`npm run verify` = 测试 + 两个构建。测试跑在**纯本地模式**，要验云端分支须 `vi.mock('src/lib/supabase')`。静态守卫固化了「敏感信息不得入库 / 后台不得碰病历表 / 结构三处同步 / gradlew 权限」等约定，忘了同步这里会红。详见 `docs/测试说明.md`
- **构建**：`npm run build`（App）/ `npm run build:admin`（后台）
- **后台冒烟**：`npm run smoke:admin`（SSR 渲染 8 个页面，抓模板运行时错误）；再配合 `npm run check:admin-dev`（沿 import 递归请求，抓「200 但白屏」）
- **线上产物连对库没有**：抓首页的 `/assets/index-*.js` 后 grep 项目 ref，确认是 `.env.production` 的生产库（不是测试库）
- **白屏防线**：`tests/guards/boot-splash.spec.ts` 钉住了启动占位 / 兜底页 / 挂载时机。现场复现用 Playwright：
  把入口脚本 `page.route` 成 `abort` → 应出现「打开失败 + 重新打开」，点一下要能恢复；
  把入口脚本延迟 5 秒 → 这期间应看到「正在打开…」而不是纯白
- **APK 里确实没有 SW**：`DISABLE_SW=1 npm run build` 后断言 `dist/sw.js` 与 `dist/registerSW.js` 都不存在
  （`build-apk.yml` 里也有同样的守卫）；解包线上 APK 时 `ls assets/public` 不该出现 `sw.js`
- **云端链路**：写 Node 脚本用 anon key + 测试账号跑「注册 → 建病人 → 写记录 → 邀请成员 → 跨账号可见 → 权限拦截」，比点 UI 更彻底
- **Edge Function**：`GET /v1/projects/<ref>/functions` 看 status / verify_jwt 是否符合预期
- **后台越权**：不带 token 调 `admin-api` 应 401；普通用户 token 应 403；管理员直连 PostgREST 查 `sessions` 应读不到别人的病历
- **数据库结构**：Management API 的 `POST /v1/projects/<ref>/database/query` 跑 `information_schema` / `pg_policies` 核对
- **CI 产出的 APK**：Release 直链下载后 `apksigner verify --print-certs` 对比 keystore 指纹，并解包确认 web 产物连的是生产库
- 交付结论要给**可复现的证据**（命令 + 输出），不要只说"应该没问题"

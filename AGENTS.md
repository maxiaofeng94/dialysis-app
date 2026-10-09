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

### 第 4 步 · 通过后自动推送部署

- 推送前自查：`npm test` 全绿、`npm run build` 通过、`.env*` 与 token 未进提交
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
npm run build; npx cap sync android
$env:ANDROID_HOME = "D:\ai\project\android-sdk"; $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:JAVA_HOME = "D:\Program Files\jdk-17.0.14"
Set-Location android
& "D:\ai\project\android-build\gradle\gradle-8.7\bin\gradle.bat" assembleRelease --console=plain   # release，与 CI 同签名
Set-Location ..
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

### 前端缓存与数据

- 云端缓存必须在**登出时清空**（`cloudCache.cacheClear()`），否则换账号会先看到上一个账号的数据
- 本地数据与云端缓存是**两个独立 IndexedDB**：`dialysis-db`（业务）与 `dialysis-cloud-cache`（缓存），不要混用
- 缓存 key：`patient:` / `dryWeights:` / `session:` / `sessions:` / `bps:` / `bgs:` / `bfs:` / `ars:` / `myPatients:` / `members:`；写操作后要同步更新或删除对应 key
- Dexie 升级用 `version(n).stores(...)`；新增非索引字段无需升版本，但读取要兼容旧数据（见 `localRepository.normalizeSession`）
- **「缓存优先 + 后台刷新」必须有 `FRESH_MS` 闸门**：命中缓存就无条件刷新 + `cacheVersion++`，会和页面的 `watch(cacheVersion)` 组成自激循环（成员页曾每轮打一次 join 查询）。`cloudAdmin` 的两个读函数现已对齐 `cachedRepository.cacheFirst`
- **导入备份要「先整份校验 → 再在事务里清库写入」**：先 `clear()` 再 `bulkPut()` 时，JSON 能解析但字段不合法，数据已全清空、界面只说「格式不正确」

### 移动端输入与不可逆操作

- **输入清洗要处理全角标点**：`replace(/,/g,'.')` 只认半角，中文输入法的「，」会被 `[^\d.]` 删掉 → `70，5` 变成 `705`（**10 倍体重误差**）。用 `/[,，]/g` 并写进测试
- **数值要量程校验**：只判 `parseNum != null` 时，体重 0、血糖 999、粘贴的 `-5` 都能入库（Vant 的 number 输入允许前导负号）
- **每个写操作按钮都要 in-flight 守卫**：云端保存要等网络，没 loading/disabled 时用户会连点 ——「立即创建」连点两次就是两条记录
- **写失败必须给提示**：对非技术用户「没有报错」＝「已经存好了」。详情页曾所有写操作都没 `catch`，断网时填的体重静默丢失
- **不可逆操作要二次确认并写清后果**（导入覆盖、迁移、删除、退出登录）：包括「会删掉哪几个病人、多少条记录」
- **业务数值为负要钳制**：脱水量 = 上机前实际体重 − 干体重，称重忘了扣轮椅时会得到 -20 之类，显示「计划脱水 -20.0 L」会被读成「要输 20 升」→ 三个脱水量统一 `Math.max(0, x)`（`calc.ts` 的 `nonNegative`）。**但体重本身不钳制**（原始测量值要照实显示，否则发现不了填错）

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
- **云端链路**：写 Node 脚本用 anon key + 测试账号跑「注册 → 建病人 → 写记录 → 邀请成员 → 跨账号可见 → 权限拦截」，比点 UI 更彻底
- **Edge Function**：`GET /v1/projects/<ref>/functions` 看 status / verify_jwt 是否符合预期
- **后台越权**：不带 token 调 `admin-api` 应 401；普通用户 token 应 403；管理员直连 PostgREST 查 `sessions` 应读不到别人的病历
- **数据库结构**：Management API 的 `POST /v1/projects/<ref>/database/query` 跑 `information_schema` / `pg_policies` 核对
- **CI 产出的 APK**：Release 直链下载后 `apksigner verify --print-certs` 对比 keystore 指纹，并解包确认 web 产物连的是生产库
- 交付结论要给**可复现的证据**（命令 + 输出），不要只说"应该没问题"

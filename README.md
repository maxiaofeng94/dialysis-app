# 透析记录 App

透析病人体重与生命体征记录系统，一套代码支持 **华为 / 苹果手机**（PWA + Android APK），可免费部署。
支持「纯本地单机」与「手机号登录的多人家属协作」两种模式，并带一个独立的**后台管理系统**。

## 在线地址

| 用途 | 地址 |
|---|---|
| App（病人家属用） | https://dialysis-49v.pages.dev |
| 后台管理（管理员用） | https://dialysis-admin.pages.dev |
| Android APK 直链 | https://github.com/maxiaofeng94/dialysis-app/releases/download/latest/dialysis-recorder.apk |

手机浏览器打开 App 网址 → 「添加到主屏幕」即可全屏使用（iOS Safari、华为浏览器均支持）；APK 支持**覆盖安装**升级，不必卸载（卸载会清空 App 本地数据）。

## 功能一览

**记录与计算**

- **快速创建**：首页一键记录「上机前体重（含轮椅）」，自动扣轮椅重量、算计划脱水量
- **体重与脱水**：上/下机体重、计划脱水量、实际脱水量、回水量（默认 300ml）、机器超滤设置
  - 只填上机前体重 → 仅显示计划脱水量；填了下机后体重 → 计划 + 实际都显示
- **医生设定脱水量**：按 ml 录入（不参与自动计算），报告页按 L 展示
- **血压**：手动记录高压 / 低压（每小时一次），带偏高 / 偏低判定
- **血糖**：mmol/L，带判定
- **血流量**：一次透析可记录多条（ml/min）
- **不良反应**：呕吐、腿脚无力、头晕、低血压、抽筋、头痛、其他（多选 + 自定义文字）

**状态与报告**

- **透析状态**：进行中 / 已完成 / 已中止
  - 「已中止」用于血管条件差、穿刺失败、低血压等原因本次透析未做完的情况，可记录**中止时间**与**中止原因**（常用原因多选 + 补充描述），历史记录也能补录
- **报告**：汇总页、导出图片 / 分享给医生
- **趋势**：体重、血压、血糖历史曲线（Y 轴自适应实际数据范围）
- **干体重历史**：按日期取「当时有效干体重」，历史记录稳定

**数据与协作**

- **数据**：本地 IndexedDB 存储、JSON 备份 / 恢复（APK 内走系统分享保存）、记录人字段
- **多人协作（可选）**：配置 Supabase 后可手机号 + 密码登录，多端同步、邀请家属/医生共同记录；不配置则保持纯本地单机模式

## 技术栈

- **App**：Vue 3 · Vite · TypeScript · Vant 4 · Dexie(IndexedDB) · ECharts · html2canvas · vite-plugin-pwa · Capacitor(Android)
- **后台管理端**：Vue 3 · Element Plus（独立入口，独立产物，不进 APK）
- **后端**：Supabase（Postgres + RLS + Auth + Edge Functions）· Cloudflare Pages 托管

## 本地运行

```bash
npm install

npm run dev          # App      → http://localhost:5173 （连测试库 .env，带热更新）
npm run dev:admin    # 后台管理 → http://localhost:5174 （连测试库 .env）
```

两个服务互相独立，可以同时跑。后台管理端在测试库需要先跑过 `supabase/schema.sql` 并部署 `admin-api`，否则登录后无法使用（见 `docs/后台管理系统部署指南.md`）。

## 构建与自检

```bash
npm run build         # App 产物      → dist/         （读 .env.production，连生产库）
npm run build:admin   # 后台产物      → dist-admin/   （产出 index.html，Pages 根路径直接可访问）

npm run smoke:admin      # 后台页面冒烟：SSR 渲染 8 个页面，抓模板错误与写错的组件名
npm run check:admin-dev  # 后台预览自检：沿 import 递归检查资源链（需先起 dev:admin）
npm run preview          # 预览 App 构建产物 → http://localhost:4173
```

> `npm run build` 会先跑 `vue-tsc` 类型检查，**类型不过就不能提交**。

## 开发与发布流程（重要）

改动代码后**按三步走**（完整规则见 `AGENTS.md`，工作区内的 AI 会话会自动遵守）：

1. **本地预览确认**
   - App 改动：`npm run dev` → http://localhost:5173 （连**测试库**）
   - 后台改动：`npm run dev:admin` → http://localhost:5174 （连**测试库**），再跑 `npm run check:admin-dev`
   - 看真实数据：`npm run build && npm run preview` → http://localhost:4173 （连**生产库**）
2. **确认无误后推送**：`git push origin main` → GitHub Actions 自动完成：
   - App 部署到 Cloudflare Pages（`deploy.yml`）→ https://dialysis-49v.pages.dev
   - 后台部署到 Cloudflare Pages（`deploy-admin.yml`，仅当改动命中后台相关路径）→ https://dialysis-admin.pages.dev
   - 构建 APK 并**滚动发布**到 GitHub Release `latest`（`build-apk.yml`）
3. **拿 APK**：直接用上面的固定直链下载，覆盖安装即可

> 环境分工：`npm run dev` / `dev:admin` 读 `.env`（测试库），`npm run build` / `build:admin` 读 `.env.production`（生产库）；两个文件都已 git 忽略，**不入库**。
>
> 本地手打 APK 仅作兜底：`npm run build && npx cap sync android`，再在 `android` 目录执行 `gradle assembleDebug`（需先设好 `ANDROID_HOME` / `JAVA_HOME`）。

## 后台管理系统

管理员在 https://dialysis-admin.pages.dev 用**手机号 + 密码**登录（与 App 同一套账号，无需单独注册）。

**能做什么**

- **用户**：查看注册用户（手机号、姓名、注册时间、最后登录、名下病人与角色）；修改姓名、重置密码、禁用 / 解禁、代建账号、删除用户、授予 / 撤销管理员
- **病人**：查看全部病人与成员；修改基础配置（姓名 / 生日 / 轮椅重量 / 回水量）；添加 / 移除成员、调整角色、转移创建者、删除病人及其数据
- **操作日志**：所有管理动作留痕（操作人、动作、对象、变更摘要），可追溯

**不能做什么（刻意的隐私边界）**

后台**没有任何病历明细的查询入口** —— 透析记录、血压、血糖、血流量、不良反应、干体重都不开放，只提供记录条数与首末日期这类聚合数字。
这条边界是在**数据库层**实现的：管理员的所有读写都经 Edge Function 的 `service_role` 完成，`sessions` 等业务表的 RLS 策略一行未动，即使拿着管理员 token 直连 PostgREST 也读不到。

> ⚠️ **但"后台没有查询入口" ≠ "管理员看不到病历"**：后台保留了「重置任意用户密码」的能力（用户详情页），管理员可以借此进入某个账号的视角，看到该账号有权访问的全部数据；这类操作也不会留下"看了病历"的痕迹。
> 换句话说，**管理员在信任模型上就是超级权限角色**。因此：后台入口建议用 Cloudflare Access 收口、管理员账号启用 MFA，并且只把管理员给完全可信的人。

**首次配置管理员**

后台不提供自助提权入口，第一个管理员需在 Supabase SQL Editor 手动执行一次：

```sql
insert into public.admins(user_id, note)
select id, '初始管理员' from public.users where phone = '你的手机号'
on conflict (user_id) do nothing;
```

实现细节见 `docs/后台管理系统设计说明.md`，部署与验收清单见 `docs/后台管理系统部署指南.md`。

## 目录结构

```
index.html            App 入口
admin/index.html      后台管理入口（Vite root 仍是项目根，dev 中间件把 / 指向它）
vite.config.ts        App 构建配置      → dist/
vite.admin.config.ts  后台构建配置      → dist-admin/（closeBundle 把产物提升为 index.html）

src/
  types.ts            数据模型
  constants.ts        常量与不良反应字典
  utils/              计算、格式化、id
  db/database.ts      IndexedDB(Dexie) 表结构
  repo/               数据访问抽象（本地实现 + 接口，运行时按登录态切换云端）
  lib/                Supabase 客户端 / 云端仓储 / 成员管理 / 本地→云端迁移
  stores/             登录态、当前病人
  router/             路由 + 登录守卫
  components/         BaseChart 图表封装
  views/              Home/Session/Report/Trend/Settings/Login/Members
  admin/              后台管理端（Element Plus：登录/概览/用户/病人/操作日志/我的账号）

scripts/              后台自检脚本（页面冒烟、预览资源链）
supabase/             多人版后端：schema.sql + Edge Functions（含 admin-api）+ 配置/验证脚本
docs/                 需求与设计文档、部署指南
.github/workflows/    App 部署、后台部署、APK 构建
```

## 多人 / 多设备（可选）

同一套代码支持两种模式，由是否配置云端决定：

- **单机模式**（默认）：不配 `.env`，数据只存在手机本地，无需注册登录；
- **多人模式**：按 `docs/多人版部署指南.md` 配好 Supabase，注册登录后数据存云端，可创建/切换多个病人、按手机号邀请家属或医生（owner / caregiver / doctor / viewer 四种角色，由数据库 RLS 行级权限控制），记录自动带出记录人。

两种模式共用同一套页面与计算公式，数据访问经 `Repository` 接口动态切换。设计细节见 `docs/需求与设计文档.md` 第 10 章。

## 文档

| 文档 | 内容 |
|---|---|
| `docs/需求与设计文档.md` | 完整需求、页面原型、数据库设计 |
| `docs/多人版部署指南.md` | Supabase + 前端部署步骤 |
| `docs/前端部署指南.md` | 静态托管部署说明 |
| `docs/后台管理系统设计说明.md` | 后台的权限模型、接口设计、隐私边界、验证结果 |
| `docs/后台管理系统部署指南.md` | 后台部署步骤与验收清单 |
| `AGENTS.md` | 工作区规则、环境与凭据说明、踩坑清单、验证手段 |

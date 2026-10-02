# Supabase 多人版后端 — 部署说明

本目录是多人版后端代码：
- `schema.sql` — 建表 + RLS 权限 + 辅助函数（**可重复执行**，重复跑只补缺的部分）
- `functions/register/` — 注册（手机号 + 密码，服务端建号）
- `functions/create-patient/` — 创建病人（建病人 + owner 成员）
- `functions/invite-member/` — 按手机号邀请成员
- `functions/admin-api/` — **后台管理唯一入口**（管理员校验 + 用户/病人/成员管理 + 操作审计）
- `deploy-functions.ps1` — 一键部署脚本

数据表：`users`、`patients`、`dry_weights`、`sessions`（含医生设定脱水量、中止时间/原因）、`blood_pressures`、`blood_glucoses`、`blood_flows`、`adverse_reactions`、`patient_members`。

> 记录人姓名靠 `sessions.operator_id → public.users` 关联带出，所以该外键必须指向 `public.users`（旧版指向 `auth.users`，重跑一次 `schema.sql` 即可修正）。

## 登录方式：手机号 + 密码

- 注册：填手机号 + 密码（至少 6 位）→ 服务端用伪邮箱 `{手机号}@phone.local` 建号；
- 登录：手机号 + 密码 → `signInWithPassword` 直接登录；
- 无需短信服务商，**0 成本、无资质要求**。

## 一、创建 Supabase 项目

1. 打开 https://supabase.com → 用 GitHub 登录 → **New project**
2. 填写：Name（如 `dialysis`）、数据库密码（记好）、Region 选 `Southeast Asia (Singapore)`
3. 等待 1~2 分钟创建完成

## 二、建表

1. 左侧 **SQL Editor** → New query
2. 把 `schema.sql` 的内容**全部粘贴**进去 → **Run**
3. 看到 `Success. No rows returned` 即成功

## 三、部署 Edge Functions

前置：电脑安装 Supabase CLI（https://supabase.com/docs/guides/cli），并登录（也可直接设环境变量 `SUPABASE_ACCESS_TOKEN`）：

```bash
supabase login
cd 项目根目录（含 supabase/ 文件夹）
```

部署三个函数（不必 `supabase link`，直接指定 `--project-ref`）：

```bash
# register 必须免 JWT 校验：注册时用户还没登录
supabase functions deploy register      --project-ref <ref> --no-verify-jwt --use-api
supabase functions deploy create-patient --project-ref <ref> --use-api
supabase functions deploy invite-member  --project-ref <ref> --use-api
```

- `--use-api`：不依赖 Docker，由平台侧构建
- 另两个函数保持默认 JWT 校验，前端会带用户 access token 调用
- 也可用脚本：`powershell -File supabase/deploy-functions.ps1 -ProjectRef <ref>`

## 四、获取前端连接信息

左侧 **Project Settings → API**：
- **Project URL**：如 `https://xxxx.supabase.co`
- **anon public key**：客户端匿名密钥

这两个值配置到前端环境变量：开发调试用 `.env`（建议测试库）、生产构建用 `.env.production`（生产库），两者都已被 git 忽略：
```
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
```

## 四·五、后台管理（2026-10-02 新增）

`schema.sql` 第 9～13 节为后台增量（幂等，可重复执行）：

- `public.admins` — 管理员名单（**无写策略**，只有 SQL Editor / service_role 能写）
- `public.is_admin()` — 判定函数（security definer）
- `public.admin_audit_logs` — 后台操作留痕（管理员可读，仅 service_role 可写）
- `public.admin_patient_stats()` — 按病人聚合记录数/首末日期（**仅 service_role 可执行**）
- `revoke update on public.users` + `grant update (name)` — 用户只能改自己的姓名

部署后台接口（**保持默认 JWT 校验**，不要加 `--no-verify-jwt`）：

```bash
supabase functions deploy admin-api --project-ref <ref> --use-api
```

设置首个管理员（换成你自己的手机号，在 SQL Editor 执行一次）：

```sql
insert into public.admins(user_id, note)
select id, '初始管理员' from public.users where phone = '13800000000'
on conflict (user_id) do nothing;
```

后台前端是独立入口（`admin/index.html` + `src/admin/**`，Element Plus），构建 `npm run build:admin` 输出 `dist-admin/`，
完整步骤与验收清单见 `docs/后台管理系统部署指南.md`。

## 五、安全说明

- 密码登录由 Supabase Auth 托管（加密存储），前端用 anon key + RLS 访问；
- `register`/`create-patient`/`invite-member` 用服务端密钥，负责建号与成员管理；
- 业务表全部启用 RLS，按 `patient_members` 的角色控制读写权限。

## 六、成本

- Supabase 免费层：500MB 数据库 / 5 万月活，足够家庭/小团队使用。

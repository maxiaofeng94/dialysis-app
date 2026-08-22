# Supabase 多人版后端 — 部署说明

本目录是多人版后端代码：
- `schema.sql` — 建表 + RLS 权限 + 辅助函数
- `functions/register/` — 注册（手机号 + 密码，服务端建号）
- `functions/create-patient/` — 创建病人（建病人 + owner 成员）
- `functions/invite-member/` — 按手机号邀请成员
- `deploy-functions.ps1` — 一键部署脚本

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

前置：电脑安装 Supabase CLI（https://supabase.com/docs/guides/cli），并登录：

```bash
supabase login
cd 项目根目录（含 supabase/ 文件夹）
supabase link --project-ref <你的项目引用ID>
```

部署三个函数（或用脚本 `deploy-functions.ps1` 交互式执行）：

```bash
supabase functions deploy register
supabase functions deploy create-patient
supabase functions deploy invite-member
```

## 四、获取前端连接信息

左侧 **Project Settings → API**：
- **Project URL**：如 `https://xxxx.supabase.co`
- **anon public key**：客户端匿名密钥

这两个值配置到前端环境变量（`.env`）：
```
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
```

## 五、安全说明

- 密码登录由 Supabase Auth 托管（加密存储），前端用 anon key + RLS 访问；
- `register`/`create-patient`/`invite-member` 用服务端密钥，负责建号与成员管理；
- 业务表全部启用 RLS，按 `patient_members` 的角色控制读写权限。

## 六、成本

- Supabase 免费层：500MB 数据库 / 5 万月活，足够家庭/小团队使用。

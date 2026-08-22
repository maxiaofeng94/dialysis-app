# Supabase 多人版后端 — 部署说明

本目录是多人版后端代码：
- `schema.sql` — 建表 + RLS 权限 + 辅助函数
- `functions/send-otp/` — 发送短信验证码（腾讯云 SMS）
- `functions/verify-otp/` — 校验验证码并登录/注册

## 一、创建 Supabase 项目

1. 打开 https://supabase.com → 用 GitHub 登录 → **New project**
2. 填写：Name（如 `dialysis`）、数据库密码（记好）、Region 选 `Southeast Asia (Singapore)`
3. 等待 1~2 分钟创建完成

## 二、建表

1. 左侧 **SQL Editor** → New query
2. 把 `schema.sql` 的内容**全部粘贴**进去 → **Run**
3. 看到 `Success. No rows returned` 即成功

## 三、配置腾讯云短信（需实名认证）

1. 打开 https://console.cloud.tencent.com/smsv2 → 注册/登录并**实名认证**（个人即可）
2. **应用管理** → 创建应用 → 得到 **SmsSdkAppId**（如 `1400xxxxxx`）
3. **签名管理** → 创建签名（如「透析记录」，审核约 1~2 个工作日，免费）
4. **正文模板管理** → 创建模板，示例：
   > 您的验证码为 ${1}，5 分钟内有效，请勿泄露。
   审核通过后得到 **TemplateId**
5. **访问管理 CAM**：https://console.cloud.tencent.com/cam/capi → 创建子用户或直接拿主账号的 **SecretId / SecretKey**
   （推荐创建子用户，仅授予 `sms:SendSms` 权限，更安全）

## 四、部署 Edge Functions 并配置密钥

前置：电脑安装 Supabase CLI（https://supabase.com/docs/guides/cli），并登录：

```bash
supabase login
cd 项目根目录（含 supabase/ 文件夹）
supabase link --project-ref <你的项目引用ID>   # 在项目 Settings → General 里找
```

部署两个函数：

```bash
supabase functions deploy send-otp
supabase functions deploy verify-otp
```

配置密钥（在 Dashboard → Edge Functions → 对应函数 → Secrets 里添加，或 CLI）：

```bash
supabase secrets set TENCENT_SECRET_ID=xxxx TENCENT_SECRET_KEY=xxxx
supabase secrets set TENCENT_SMS_APP_ID=1400xxxxxx
supabase secrets set TENCENT_SMS_SIGN=透析记录
supabase secrets set TENCENT_SMS_TEMPLATE_ID=1234567
supabase secrets set TENCENT_SMS_REGION=ap-guangzhou   # 与短信应用区域一致
```

> `SUPABASE_URL` 与 `SUPABASE_SERVICE_ROLE_KEY` 由 Supabase 自动注入，无需手动设置。

## 五、获取前端连接信息

左侧 **Project Settings → API**：
- **Project URL**：如 `https://xxxx.supabase.co`
- **anon public key**：客户端匿名密钥

这两个值配置到前端环境变量（`.env`）：
```
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
```

## 六、安全说明

- 腾讯云 `SecretId/SecretKey` **只存在 Edge Function 服务端**，绝不进前端；
- `otp_codes` 表未开任何 RLS 策略，客户端无法直接读写，只有 Edge Function（服务端密钥）可访问；
- 业务表全部启用 RLS，按 `patient_members` 的角色控制读写权限。

## 七、成本

- Supabase：免费层（500MB 数据库 / 5 万月活）；
- 腾讯云短信：约 ¥0.05/条，家庭小规模每月几毛到几元。

# ============================================================
# 一键部署：关联 Supabase 项目 + 部署 Edge Functions（手机号 + 密码登录版）
# 前置：已安装 Supabase CLI（npm i -g supabase 或 winget install supabase.cli）
#       并已执行 supabase login
# 用法：powershell -ExecutionPolicy Bypass -File supabase\deploy-functions.ps1
# ============================================================

$ErrorActionPreference = "Stop"

Write-Host "=== 检查 Supabase CLI ===" -ForegroundColor Cyan
if (-not (Get-Command supabase -ErrorAction SilentlyContinue)) {
  Write-Host "未找到 supabase 命令，请先安装：npm install -g supabase" -ForegroundColor Red
  exit 1
}

Write-Host "=== 1. 关联 Supabase 项目 ===" -ForegroundColor Cyan
$ref = Read-Host "请输入项目引用ID（Project Ref，形如 abcdwxyz）"
if (-not $ref) { Write-Host "项目引用ID不能为空"; exit 1 }
supabase link --project-ref $ref
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "=== 2. 部署 Edge Functions ===" -ForegroundColor Cyan
supabase functions deploy register
if ($LASTEXITCODE -ne 0) { exit 1 }
supabase functions deploy create-patient
if ($LASTEXITCODE -ne 0) { exit 1 }
supabase functions deploy invite-member
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "=== 部署完成 ✅ ===" -ForegroundColor Green
Write-Host "接下来：把 Project Settings -> API 里的 Project URL 和 anon public key 填入项目 .env"

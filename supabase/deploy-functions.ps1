# ============================================================
# 一键部署 Edge Functions（手机号 + 密码版）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File supabase\deploy-functions.ps1 -ProjectRef <项目引用ID>
#
# 若已设置环境变量 SUPABASE_ACCESS_TOKEN（https://supabase.com/dashboard/account/tokens 生成），
# 脚本会跳过浏览器登录步骤，可完全无人值守。
#
# 说明：
# - register 必须 --no-verify-jwt（注册时用户还没登录）
# - --use-api 表示不依赖 Docker，由平台侧构建
# ============================================================

param(
  [string]$ProjectRef = ''
)

$ErrorActionPreference = 'Stop'

function Invoke-Supa {
  param([string[]]$CliArgs)
  & npx --yes supabase@latest @CliArgs
  if ($LASTEXITCODE -ne 0) { throw "执行失败：supabase $($CliArgs -join ' ')" }
}

if (-not $ProjectRef) {
  $ProjectRef = Read-Host '请输入项目引用ID（Project Ref，形如 abcdwxyz）'
}
if (-not $ProjectRef) {
  Write-Host '项目引用ID不能为空' -ForegroundColor Red
  exit 1
}

if (-not $env:SUPABASE_ACCESS_TOKEN) {
  Write-Host '=== 登录 Supabase（会打开浏览器授权）===' -ForegroundColor Cyan
  Invoke-Supa @('login')
} else {
  Write-Host '=== 已检测到 SUPABASE_ACCESS_TOKEN，跳过登录 ===' -ForegroundColor Cyan
}

Write-Host '=== 1/3 部署 register（免 JWT 校验）===' -ForegroundColor Cyan
Invoke-Supa @('functions', 'deploy', 'register', '--project-ref', $ProjectRef, '--no-verify-jwt', '--use-api')

Write-Host '=== 2/3 部署 create-patient（需登录用户调用）===' -ForegroundColor Cyan
Invoke-Supa @('functions', 'deploy', 'create-patient', '--project-ref', $ProjectRef, '--use-api')

Write-Host '=== 3/3 部署 invite-member（需登录用户调用）===' -ForegroundColor Cyan
Invoke-Supa @('functions', 'deploy', 'invite-member', '--project-ref', $ProjectRef, '--use-api')

Write-Host '=== 部署完成 ===' -ForegroundColor Green
Write-Host '接下来：把 Project Settings -> API 里的 Project URL 与 anon public key 填入前端 .env（测试库）或 .env.production（生产库）'

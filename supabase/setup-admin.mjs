#!/usr/bin/env node
/**
 * 后台管理系统 · 数据库一键配置（测试库/生产库通用）
 *
 * 做三件事：
 *   ① 执行 supabase/schema.sql（幂等，重复跑不清数据）
 *   ② 校验新增对象是否齐备（admins / admin_audit_logs / is_admin / admin_patient_stats）
 *   ③ 可选：把某个已注册手机号设为管理员
 *
 * 用法：
 *   $env:SUPABASE_ACCESS_TOKEN = "sbp_xxx"
 *   node supabase/setup-admin.mjs --ref <project-ref> [--phone 13800000000]
 *
 * 之后还需部署函数（脚本会打印命令）：
 *   npx --yes supabase@latest functions deploy admin-api --project-ref <ref> --use-api
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const args = process.argv.slice(2)

function arg(name, fallback = '') {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const ref = arg('ref')
const phone = arg('phone')
if (!ref) {
  console.error('用法：node supabase/setup-admin.mjs --ref <project-ref> [--phone 13800000000]')
  process.exit(1)
}

const token = process.env.SUPABASE_ACCESS_TOKEN
if (!token) {
  console.error('缺少环境变量 SUPABASE_ACCESS_TOKEN（Supabase PAT）')
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const schemaSql = readFileSync(resolve(here, 'schema.sql'), 'utf8')

async function query(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`SQL 执行失败（HTTP ${res.status}）：${text.slice(0, 500)}`)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function escapeSql(value) {
  return String(value).replace(/'/g, "''")
}

console.log(`\n=== 后台管理系统 · 配置项目 ${ref} ===\n`)

console.log('① 执行 schema.sql（幂等）…')
await query(schemaSql)
console.log('   ✅ 已执行')

console.log('② 校验对象与权限收口…')
const checks = await query(`
  select
    (select count(*) from information_schema.tables
      where table_schema = 'public' and table_name = 'admins')::int          as admins_table,
    (select count(*) from information_schema.tables
      where table_schema = 'public' and table_name = 'admin_audit_logs')::int as audit_table,
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'is_admin')::int            as is_admin_fn,
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'admin_patient_stats')::int as stats_fn,
    has_function_privilege('anon', 'public.admin_patient_stats()', 'EXECUTE')          as anon_can_run_stats,
    has_function_privilege('authenticated', 'public.admin_patient_stats()', 'EXECUTE') as user_can_run_stats,
    has_function_privilege('service_role', 'public.admin_patient_stats()', 'EXECUTE')  as service_can_run_stats,
    has_column_privilege('authenticated', 'public.users', 'name', 'UPDATE')  as user_can_update_name,
    has_column_privilege('authenticated', 'public.users', 'phone', 'UPDATE') as user_can_update_phone
`)
const row = Array.isArray(checks) ? checks[0] : checks

const expectations = [
  ['admins 表存在', row?.admins_table === 1],
  ['admin_audit_logs 表存在', row?.audit_table === 1],
  ['is_admin() 函数存在', row?.is_admin_fn === 1],
  ['admin_patient_stats() 函数存在', row?.stats_fn === 1],
  ['anon 不能执行 admin_patient_stats()', row?.anon_can_run_stats === false],
  ['authenticated 不能执行 admin_patient_stats()', row?.user_can_run_stats === false],
  ['service_role 能执行 admin_patient_stats()', row?.service_can_run_stats === true],
  ['用户能改自己的 name', row?.user_can_update_name === true],
  ['用户不能改自己的 phone（加固生效）', row?.user_can_update_phone === false],
]
for (const [label, pass] of expectations) {
  console.log(`   ${pass ? '✅' : '❌'} ${label}`)
}

const policies = await query(`
  select tablename, cmd, policyname from pg_policies
  where schemaname = 'public' and tablename in ('admins', 'admin_audit_logs')
  order by tablename, cmd
`)
console.log('   策略清单：' + JSON.stringify(policies))
const policyList = Array.isArray(policies) ? policies : []
const writePolicies = policyList.filter((p) => p.cmd !== 'SELECT')
console.log(
  writePolicies.length
    ? `   ❌ admins / admin_audit_logs 上出现了写策略：${JSON.stringify(writePolicies)}（应只有 SELECT）`
    : '   ✅ 两张表都只有 SELECT 策略（普通请求写不进去）',
)

if (phone) {
  console.log(`③ 把 ${phone} 设为管理员…`)
  await query(`
    insert into public.admins(user_id, note)
    select id, '初始管理员' from public.users where phone = '${escapeSql(phone)}'
    on conflict (user_id) do nothing
  `)
  const list = await query(`
    select u.phone, u.name, a.created_at
    from public.admins a join public.users u on u.id = a.user_id
    order by a.created_at
  `)
  const admins = Array.isArray(list) ? list : []
  console.log('   当前管理员：' + JSON.stringify(admins))
  if (!admins.length) {
    console.log('   ⚠️ 管理员列表为空：该手机号可能还没在 App 里注册过（public.users 里没有记录）')
  }
} else {
  console.log('③ 跳过设置管理员（未传 --phone）')
}

console.log(`\n④ 还剩一步 —— 部署后台函数（保持默认 JWT 校验，不要加 --no-verify-jwt）：\n`)
console.log(`   npx --yes supabase@latest functions deploy admin-api --project-ref ${ref} --use-api\n`)
console.log('   部署后可验证：')
console.log(`   curl -s -o NUL -w "%{http_code}" "https://${ref}.supabase.co/functions/v1/admin-api" -H "Authorization: Bearer <anon key>"`)
console.log('   （期望 401 = 已部署且开启 JWT 校验；404 = 还没部署）\n')

#!/usr/bin/env node
/**
 * 后台管理接口 · 越权与权限验证（对应 docs/后台管理系统部署指南.md 第六节 A 组）
 *
 * 用法（普通账号的凭据用于验证「非管理员会被拦截」）：
 *   node supabase/verify-admin-api.mjs --env .env \
 *     --phone 13800000001 --password 普通用户密码 \
 *     --admin-phone 13800000000 --admin-password 管理员密码
 *
 * 验证项：
 *   A1  不带 token 调 admin-api            → 期望 401
 *   A2  普通用户 token 调 user.list        → 期望 403
 *   A3  普通用户 token 调 patient.delete   → 期望 403
 *   A4  普通用户 PostgREST 写 admins       → 期望被拒（防自我提权）
 *   A5  普通用户 PostgREST 改自己 phone    → 期望被拒（列级权限）
 *   A5b 普通用户 PostgREST 改自己 name     → 期望成功（App 功能不受影响）
 *   A6  普通用户直连查 sessions            → 期望 200（RLS 仍生效）
 *   B1  管理员 whoami                      → 期望 isAdmin=true
 *   B2  管理员 user.list                   → 期望 200
 *   B3  管理员直连查 sessions              → 期望读不到（隐私边界）
 */
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
function arg(name, fallback = '') {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const envFile = arg('env', '.env')
const envText = readFileSync(envFile, 'utf8')
const url = (envText.match(/VITE_SUPABASE_URL=([^\s]+)/) ?? [])[1]
const anon = (envText.match(/VITE_SUPABASE_ANON_KEY=([^\s]+)/) ?? [])[1]
if (!url || !anon) {
  console.error(`无法从 ${envFile} 读取 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY`)
  process.exit(1)
}

const results = []
function record(id, desc, expected, actual, pass, extra = '') {
  results.push({ id, desc, expected, actual, pass, extra })
  console.log(`${pass ? '✅' : '❌'} ${id} ${desc}\n     期望 ${expected} / 实际 ${actual}${extra ? ' — ' + extra : ''}`)
}

async function signIn(phone, password) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anon },
    body: JSON.stringify({ email: `${phone}@phone.local`, password }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.access_token) {
    throw new Error(`登录失败（${phone}）：${body.error_description ?? body.msg ?? res.status}`)
  }
  return { token: body.access_token, userId: body.user?.id }
}

async function adminApi(action, payload, token) {
  const res = await fetch(`${url}/functions/v1/admin-api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anon,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ action, payload: payload ?? {} }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

/** 直接打 PostgREST，返回 { status, text } */
async function rest(path, token, init = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: anon,
      Authorization: `Bearer ${token}`,
      Prefer: 'return=representation',
      ...(init.headers ?? {}),
    },
  })
  return { status: res.status, text: await res.text() }
}

console.log(`\n=== 后台接口验证 @ ${url} ===\n`)

// A1 无 token
{
  const r = await adminApi('user.list', {}, null)
  record('A1', '不带 token 调 user.list', '401', String(r.status), r.status === 401)
}

const userPhone = arg('phone')
const userPassword = arg('password')
if (userPhone && userPassword) {
  const user = await signIn(userPhone, userPassword)
  {
    const r = await adminApi('user.list', {}, user.token)
    record('A2', '普通用户调 user.list', '403', String(r.status), r.status === 403, r.body?.error ?? '')
  }
  {
    const r = await adminApi('patient.delete', { patientId: 'x', confirmName: 'x' }, user.token)
    record('A3', '普通用户调 patient.delete', '403', String(r.status), r.status === 403, r.body?.error ?? '')
  }
  {
    const r = await rest('admins', user.token, {
      method: 'POST',
      body: JSON.stringify({ user_id: '00000000-0000-0000-0000-000000000000' }),
    })
    record('A4', '普通用户写 public.admins（防自我提权）', '被拒（4xx）', String(r.status), r.status >= 400, r.text.slice(0, 90))
  }
  {
    const r = await rest(`users?id=eq.${user.userId}`, user.token, {
      method: 'PATCH',
      body: JSON.stringify({ phone: '10000000000' }),
    })
    record('A5', '普通用户改自己 phone（列级加固）', '被拒（权限不足）', String(r.status), r.status >= 400, r.text.slice(0, 90))
  }
  {
    const r = await rest(`users?id=eq.${user.userId}`, user.token, {
      method: 'PATCH',
      body: JSON.stringify({ name: '验证改名' }),
    })
    record('A5b', '普通用户改自己 name（App 功能不受影响）', '2xx', String(r.status), r.status < 300, r.text.slice(0, 60))
  }
  {
    const r = await rest('sessions?select=id&limit=1', user.token)
    record('A6', '普通用户直连查 sessions（RLS 仍生效）', '200', String(r.status), r.status === 200)
  }
} else {
  console.log('⚠️ 未提供 --phone/--password，跳过 A2～A6')
}

const adminPhone = arg('admin-phone')
const adminPassword = arg('admin-password')
if (adminPhone && adminPassword) {
  const admin = await signIn(adminPhone, adminPassword)
  {
    const r = await adminApi('whoami', {}, admin.token)
    record('B1', '管理员 whoami', 'isAdmin=true', String(r.body?.data?.isAdmin), r.body?.data?.isAdmin === true)
  }
  {
    const r = await adminApi('user.list', { page: 1, size: 5 }, admin.token)
    record('B2', '管理员 user.list', '200', String(r.status), r.status === 200, `共 ${r.body?.data?.total ?? '?'} 个用户`)
  }
  {
    const r = await rest('sessions?select=id&limit=1', admin.token)
    const readable = r.status === 200 && r.text !== '[]'
    record('B3', '管理员直连查 sessions（隐私边界）', '读不到别人的病历', readable ? '读到了数据' : '空结果', !readable, r.text.slice(0, 60))
  }
} else {
  console.log('⚠️ 未提供 --admin-phone/--admin-password，跳过 B1～B3')
}

const failed = results.filter((r) => !r.pass)
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length) {
  console.log('未通过：' + failed.map((f) => f.id).join('、'))
  process.exit(1)
}

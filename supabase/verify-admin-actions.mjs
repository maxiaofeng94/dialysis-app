#!/usr/bin/env node
/**
 * admin-api 正向功能验证：用管理员账号把每个 action 都真实跑一遍。
 *
 * 与 verify-admin-api.mjs（验证「越权被拦」）互补，本脚本验证「管理员能用」。
 * 所有写操作都用**临时数据**或**可逆操作**，跑完不留残留（除审计日志外）。
 *
 * 用法：
 *   node supabase/verify-admin-actions.mjs --env .env \
 *     --admin-phone 13900000099 --admin-password Test123456 \
 *     --plain-phone 13900000098 --plain-password Test123456
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
const adminPhone = arg('admin-phone')
const adminPassword = arg('admin-password')
const plainPhone = arg('plain-phone')
const plainPassword = arg('plain-password')
if (!url || !anon || !adminPhone || !plainPhone) {
  console.error('用法：node supabase/verify-admin-actions.mjs --env .env --admin-phone <管理员手机号> --admin-password <密码> --plain-phone <普通账号> --plain-password <密码>')
  process.exit(1)
}

const results = []
function record(id, desc, pass, extra = '') {
  results.push({ id, desc, pass, extra })
  console.log(`${pass ? '✅' : '❌'} ${id} ${desc}${extra ? ' — ' + extra : ''}`)
}

async function signIn(phone, password) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anon },
    body: JSON.stringify({ email: `${phone}@phone.local`, password }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.access_token) {
    throw new Error(body.error_description ?? body.msg ?? `HTTP ${res.status}`)
  }
  return { token: body.access_token, userId: body.user?.id }
}

async function call(action, payload, token) {
  const res = await fetch(`${url}/functions/v1/admin-api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anon, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, payload: payload ?? {} }),
  })
  const body = await res.json().catch(() => ({}))
  if (res.status !== 200 || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  if (body.warning) console.log(`   ⚠️ ${body.warning}`)
  return body.data
}

/** 跑一步，断言返回值；返回 data 供后续步骤使用 */
async function step(id, desc, fn, assert) {
  try {
    const data = await fn()
    const ok = assert ? assert(data) : true
    record(id, desc, ok, ok ? '' : `结果不符预期：${JSON.stringify(data).slice(0, 100)}`)
    return data
  } catch (err) {
    record(id, desc, false, `失败：${err.message}`)
    return null
  }
}

console.log(`\n=== admin-api 正向功能验证 @ ${url} ===\n`)

const admin = await signIn(adminPhone, adminPassword)
let plain = await signIn(plainPhone, plainPassword)
console.log(`管理员 ${adminPhone} 已登录；普通账号 ${plainPhone} 已登录\n`)

// ---------- 读接口 ----------
await step('R1', 'stats.overview 概览统计', () => call('stats.overview', {}, admin.token), (d) => typeof d.userCount === 'number' && d.userCount > 0)
await step(
  'R2',
  'user.list 搜索手机号',
  () => call('user.list', { search: plainPhone, page: 1, size: 10 }, admin.token),
  (d) => d.rows.length === 1 && d.rows[0].phone === plainPhone,
)
await step(
  'R3',
  'user.get 用户详情（含名下病人与最后登录）',
  () => call('user.get', { userId: plain.userId }, admin.token),
  (d) => d.user.id === plain.userId,
)
await step(
  'R4',
  'patient.list 病人列表（含成员与记录聚合）',
  () => call('patient.list', { page: 1, size: 50 }, admin.token),
  (d) => Array.isArray(d.rows) && d.rows.length > 0,
)
await step(
  'R5',
  'audit.list 操作日志',
  () => call('audit.list', { page: 1, size: 5 }, admin.token),
  (d) => typeof d.total === 'number',
)

// ---------- 造一个临时病人（由普通账号用 App 的 create-patient 建，顺带验证 App 侧链路） ----------
let tempPatientId = null
await step(
  'R6',
  '普通账号用 create-patient 建临时病人（验证 App 侧链路未被影响）',
  async () => {
    const res = await fetch(`${url}/functions/v1/create-patient`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anon, Authorization: `Bearer ${plain.token}` },
      body: JSON.stringify({ name: '后台验证临时病人', wheelchairWeight: 1500, rinseBackVolume: 300 }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.patient) throw new Error(body.error ?? `HTTP ${res.status}`)
    return body.patient
  },
  (p) => {
    tempPatientId = p?.id ?? null
    return Boolean(tempPatientId)
  },
)

await step(
  'R7',
  'patient.get 临时病人详情（成员数应为 1）',
  () => call('patient.get', { patientId: tempPatientId }, admin.token),
  (d) => d.members.length === 1 && d.patient.name === '后台验证临时病人',
)

// ---------- 写接口 ----------
await step(
  'W1',
  'patient.update 修改病人配置（轮椅重量 1500→2000）',
  () => call('patient.update', { patientId: tempPatientId, wheelchairWeight: 2000 }, admin.token),
  () => true,
)
await step(
  'W1b',
  '回读确认配置已生效',
  () => call('patient.get', { patientId: tempPatientId }, admin.token),
  (d) => d.patient.wheelchairWeight === 2000,
)

await step(
  'W2',
  'member.add 把另一个账号加为成员（caregiver）',
  () => call('member.add', { patientId: tempPatientId, phone: adminPhone, role: 'caregiver' }, admin.token),
  () => true,
)
await step(
  'W3',
  'member.setRole 改成 doctor',
  () => call('member.setRole', { patientId: tempPatientId, userId: admin.userId, role: 'doctor' }, admin.token),
  () => true,
)
await step(
  'W3b',
  '回读确认角色已变更',
  () => call('patient.get', { patientId: tempPatientId }, admin.token),
  (d) => d.members.find((m) => m.userId === admin.userId)?.role === 'doctor',
)
await step(
  'W4',
  'member.remove 移除该成员',
  () => call('member.remove', { patientId: tempPatientId, userId: admin.userId }, admin.token),
  () => true,
)
await step(
  'W5',
  'patient.transferOwner 转移创建者（应把原创建者降为 caregiver）',
  () => call('patient.transferOwner', { patientId: tempPatientId, toUserId: admin.userId }, admin.token),
  (d) => Array.isArray(d.demoted) && d.demoted.includes(plain.userId),
)
await step(
  'W5b',
  'owner 保护：移除唯一创建者应被拒绝',
  async () => {
    try {
      await call('member.remove', { patientId: tempPatientId, userId: admin.userId }, admin.token)
      return { blocked: false }
    } catch (err) {
      return { blocked: true, message: err.message }
    }
  },
  (d) => d.blocked === true,
)

await step(
  'W6',
  'user.rename 改用户姓名',
  () => call('user.rename', { userId: plain.userId, name: '后台验证改名' }, admin.token),
  () => true,
)
await step(
  'W7',
  'user.resetPassword 重置密码（重置为原密码）',
  () => call('user.resetPassword', { userId: plain.userId, password: plainPassword }, admin.token),
  (d) => d.password === plainPassword,
)
await step(
  'W8',
  'user.setBanned 禁用账号',
  () => call('user.setBanned', { userId: plain.userId, banned: true }, admin.token),
  () => true,
)
await step(
  'W8b',
  '被禁用后无法登录',
  async () => {
    try {
      await signIn(plainPhone, plainPassword)
      return { blocked: false }
    } catch (err) {
      return { blocked: true, message: err.message }
    }
  },
  (d) => d.blocked === true,
)
await step(
  'W9',
  'user.setBanned 解禁后可以登录',
  async () => {
    await call('user.setBanned', { userId: plain.userId, banned: false }, admin.token)
    plain = await signIn(plainPhone, plainPassword)
    return { ok: true, userId: plain.userId }
  },
  (d) => d.ok === true,
)

await step(
  'W10',
  'admin.grant 授予管理员',
  async () => {
    await call('admin.grant', { userId: plain.userId, note: '验证用' }, admin.token)
    const who = await call('whoami', {}, plain.token)
    return who
  },
  (d) => d.isAdmin === true,
)
await step(
  'W11',
  'admin.revoke 撤销管理员（且不能撤销自己）',
  async () => {
    await call('admin.revoke', { userId: plain.userId }, admin.token)
    const who = await call('whoami', {}, plain.token)
    let selfBlocked = false
    try {
      await call('admin.revoke', { userId: admin.userId }, admin.token)
    } catch {
      selfBlocked = true
    }
    return { isAdmin: who.isAdmin, selfBlocked }
  },
  (d) => d.isAdmin === false && d.selfBlocked === true,
)

// 临时账号：建 → 删
let tempUserId = null
await step(
  'W12',
  'user.create 代建账号',
  () => call('user.create', { phone: '13900000097', password: 'Test123456', name: '临时代建账号' }, admin.token),
  (d) => {
    tempUserId = d?.userId ?? null
    return Boolean(tempUserId)
  },
)
await step(
  'W13',
  '代建账号可以登录',
  async () => {
    const t = await signIn('13900000097', 'Test123456')
    return { ok: Boolean(t.userId) }
  },
  (d) => d.ok === true,
)
await step(
  'W14',
  'user.delete 删除代建账号（detach 模式）',
  () => call('user.delete', { userId: tempUserId, mode: 'detach', confirmPhone: '13900000097' }, admin.token),
  () => true,
)
await step(
  'W14b',
  '删除后无法登录',
  async () => {
    try {
      await signIn('13900000097', 'Test123456')
      return { blocked: false }
    } catch {
      return { blocked: true }
    }
  },
  (d) => d.blocked === true,
)

// 清理临时病人
await step(
  'W15',
  'patient.delete 删除临时病人（校验姓名）',
  () => call('patient.delete', { patientId: tempPatientId, confirmName: '后台验证临时病人' }, admin.token),
  () => true,
)
await step(
  'W15b',
  '删除后查不到该病人',
  async () => {
    try {
      await call('patient.get', { patientId: tempPatientId }, admin.token)
      return { gone: false }
    } catch {
      return { gone: true }
    }
  },
  (d) => d.gone === true,
)

// ---------- 审计留痕 ----------
await step(
  'L1',
  '审计日志覆盖本轮所有写动作',
  () => call('audit.list', { page: 1, size: 100 }, admin.token),
  (d) => {
    const actions = new Set(d.rows.map((r) => r.action))
    const expected = [
      'patient.update',
      'member.add',
      'member.setRole',
      'member.remove',
      'patient.transferOwner',
      'user.rename',
      'user.resetPassword',
      'user.ban',
      'user.unban',
      'admin.grant',
      'admin.revoke',
      'user.create',
      'user.delete',
      'patient.delete',
    ]
    const missing = expected.filter((a) => !actions.has(a))
    if (missing.length) {
      record('L1-detail', '缺失的动作', false, missing.join('、'))
      return false
    }
    console.log(`   （日志共 ${d.total} 条，覆盖动作：${[...actions].sort().join(', ')}）`)
    return true
  },
)

const failed = results.filter((r) => !r.pass)
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length) {
  console.log('未通过：' + failed.map((f) => `${f.id}(${f.extra})`).join('；'))
  process.exit(1)
}

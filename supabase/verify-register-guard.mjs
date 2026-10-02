#!/usr/bin/env node
/**
 * 注册接口抗滥用验证（对应 supabase/schema.sql 第 14 节 + supabase/functions/register）
 *
 * 用法：
 *   node supabase/verify-register-guard.mjs --env .env
 *   node supabase/verify-register-guard.mjs --env .env --create-account   # 额外做一次真实注册
 *   node supabase/verify-register-guard.mjs --env .env --no-wait          # 不等待窗口滚动
 *
 * 验证项：
 *   G1 非法手机号（函数可达）           → 期望 400
 *   G2 连发 8 次                        → 期望 前 5 次 400、之后 429（每 IP 每分钟 5 次）
 *   G3 429 响应头 Retry-After           → 期望存在
 *   G4 窗口滚动后恢复                   → 期望重新 400（默认等最多 60 秒）
 *   G5 未执行第 14 节 SQL 时 fail closed → 期望 503（而不是"无限制地 400"）
 *   G6 --create-account：真实注册一次    → 期望 success:true（会建一个账号，请自行清理）
 *
 * 注意：全程用**非法手机号**做限流探测，不会创建任何账号；只有显式加 --create-account 才建号。
 */
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
function has(name) {
  return args.includes(`--${name}`)
}
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
const host = new URL(url).host

const results = []
function record(id, desc, expected, actual, pass, extra = '') {
  results.push({ id, desc, expected, actual, pass })
  console.log(
    `${pass ? '✅' : '❌'} ${id} ${desc}\n     期望 ${expected} / 实际 ${actual}${extra ? ' — ' + extra : ''}`,
  )
}

async function callRegister(phone, password = 'x') {
  const res = await fetch(`${url}/functions/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anon },
    body: JSON.stringify({ phone, password }),
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body, retryAfter: res.headers.get('retry-after') }
}

async function main() {
  console.log(`\n=== 注册接口抗滥用验证 · ${host} ===\n`)

  // G1 + G2：连发 8 次非法手机号
  const statuses = []
  let firstRetryAfter = null
  let sawSideEffects = false
  for (let i = 0; i < 8; i++) {
    const r = await callRegister('0')
    statuses.push(r.status)
    if (r.status === 503) sawSideEffects = true
    if (r.status === 429 && !firstRetryAfter) firstRetryAfter = r.retryAfter
  }
  const seq = statuses.join(',')

  if (sawSideEffects) {
    record(
      'G1/G2',
      '限流是否生效',
      '400×5 后转 429',
      seq,
      false,
      '出现 503：说明 register 已更新但第 14 节 SQL 未执行（fail closed 生效，属预期保护）',
    )
    console.log('\n👉 请先在 SQL Editor 执行 supabase/schema.sql 的第 14 节，再重跑本脚本。\n')
    return finish()
  }

  const expected = ['400', '400', '400', '400', '400', '429', '429', '429']
  const passG2 = seq === expected.join(',')
  record('G1/G2', '每 IP 每分钟 5 次后转 429', '400×5 → 429×3', seq, passG2,
    passG2 ? '' : '（若全 400 = 限流没生效；若前几次就 429 = 本机额度已被占用，等 1 分钟重跑）')

  record('G3', '429 带 Retry-After 响应头', '存在且为秒数', firstRetryAfter ?? '(缺失)',
    Boolean(firstRetryAfter && /^\d+$/.test(firstRetryAfter)))

  // G4：等窗口滚动
  if (!has('no-wait')) {
    const waitMs = 62_000
    console.log(`\n⏳ 等待 ${Math.round(waitMs / 1000)} 秒让限流窗口滚动……`)
    await new Promise((r) => setTimeout(r, waitMs))
    const after = await callRegister('0')
    record('G4', '窗口滚动后恢复', '400', String(after.status), after.status === 400)
  } else {
    console.log('\n⏭  跳过 G4（--no-wait）')
  }

  // G6：可选真实注册
  if (has('create-account')) {
    const phone = arg('phone', '19900000001')
    const password = arg('password', 'Verify123456')
    const r = await callRegister(phone, password)
    record(
      'G6',
      `真实注册 ${phone}`,
      '200 success:true',
      `${r.status} ${JSON.stringify(r.body)}`,
      r.status === 200 && r.body?.success === true,
      '（该账号仅用于验证，请在后台删除）',
    )
  }

  return finish()
}

function finish() {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
  if (failed.length) {
    console.log('未通过项：')
    for (const f of failed) console.log(`  · ${f.id} ${f.desc}（期望 ${f.expected}，实际 ${f.actual}）`)
    process.exitCode = 1
  }
  console.log()
}

main().catch((err) => {
  console.error('脚本异常：', err)
  process.exit(1)
})

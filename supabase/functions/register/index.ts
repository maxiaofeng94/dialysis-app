// ============================================================
// 注册：手机号 + 密码（服务端密钥建号）
//
// 部署：npx supabase functions deploy register --project-ref <ref> --no-verify-jwt --use-api
//   · 必须先执行 supabase/schema.sql 第 14 节（rate_limits 表 + check_rate_limit 函数），
//     否则本函数会 fail closed（返回 503），不会带着"没有限流"的状态继续放行。
//
// 说明：用伪邮箱 {手机号}@phone.local 作为 Supabase Auth 邮箱，
//       密码为用户设置的密码；登录用 signInWithPassword 直接登录。
//
// 为什么本函数要自己扛滥用（它是全网唯一免登录入口）：
//   · 注册不验证手机号归属（产品上保留自助注册），所以只能靠「限流 + 人机验证」
//     把批量抢占手机号、批量枚举手机号的成本抬上去；
//   · 建号走的是 auth.admin.createUser（Admin API），**不受 GoTrue 自带注册限流约束**，
//     必须在函数里自己数。
//
// 限流维度（计数落 public.rate_limits）：
//   register:ip:minute    每 IP 每分钟 5 次   —— 放最前面，连非法请求/扫描也计数
//   register:ip:hour      每 IP 每小时 20 次
//   register:global:hour  全局每小时 300 次   —— 即使 IP 头不可信也刷不爆
//   register:phone:hour   每手机号每小时 3 次
//
// 人机验证（可选，不配也能跑）：
//   设置环境变量 TURNSTILE_SECRET_KEY 后，必须带合法的 Cloudflare Turnstile token；
//   未设置则该步自动跳过，只剩上面四道限流兜底。
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2'
import { preflight, jsonResponse } from '../_shared/cors.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

interface Rule {
  bucket: string
  window: number
  max: number
}

const IP_RULES: Rule[] = [
  { bucket: 'register:ip:minute', window: 60, max: 5 },
  { bucket: 'register:ip:hour', window: 3600, max: 20 },
]
const GLOBAL_RULES: Rule[] = [{ bucket: 'register:global:hour', window: 3600, max: 300 }]
const PHONE_RULES: Rule[] = [{ bucket: 'register:phone:hour', window: 3600, max: 3 }]

/** 取调用方 IP：Supabase 网关会带上 x-forwarded-for */
function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for') ?? ''
  const first = xff.split(',')[0]?.trim()
  return (
    first ||
    req.headers.get('cf-connecting-ip')?.trim() ||
    req.headers.get('x-real-ip')?.trim() ||
    'unknown'
  )
}

type LimitState = 'ok' | 'limited' | 'error'

/**
 * 依次校验一组规则。
 * 任一 RPC 报错都返回 'error'（fail closed）——宁可短暂拒绝注册，
 * 也不能在"以为有限流、其实一次都没数上"的状态下对外服务。
 */
async function checkRules(rules: Rule[], key: string): Promise<LimitState> {
  for (const r of rules) {
    const { data, error } = await supabase.rpc('check_rate_limit', {
      p_bucket: r.bucket,
      p_key: key,
      p_max: r.max,
      p_window_seconds: r.window,
    })
    if (error) {
      console.error(`[register] 限流调用失败 bucket=${r.bucket}: ${error.message}`)
      return 'error'
    }
    if (data !== true) return 'limited'
  }
  return 'ok'
}

/** 校验 Cloudflare Turnstile；未配置 secret 时直接放行（只靠限流） */
async function verifyTurnstile(token: unknown, ip: string): Promise<boolean> {
  const secret = Deno.env.get('TURNSTILE_SECRET_KEY')
  if (!secret) return true
  if (typeof token !== 'string' || !token) return false

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
    })
    const data = (await res.json()) as { success?: boolean }
    return data?.success === true
  } catch (err) {
    console.error('[register] turnstile 校验异常：', err instanceof Error ? err.message : String(err))
    return false
  }
}

Deno.serve(async (req) => {
  // CORS 头按 Origin 白名单下发（见 _shared/cors.ts）
  const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
    jsonResponse(req, data, status, extra)
  const tooMany = (retryAfter: number) =>
    json({ error: '操作过于频繁，请稍后再试' }, 429, { 'Retry-After': String(retryAfter) })
  const serviceBusy = () => json({ error: '注册服务暂时不可用，请稍后再试' }, 503)

  if (req.method === 'OPTIONS') return preflight(req)
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)

  try {
    const ip = clientIp(req)

    // ① IP 维度：放在参数校验之前，扫描/试探也要计数
    const ipState = await checkRules(IP_RULES, ip)
    if (ipState === 'error') return serviceBusy()
    if (ipState === 'limited') return tooMany(60)

    // ② 全局兜底
    const globalState = await checkRules(GLOBAL_RULES, 'all')
    if (globalState === 'error') return serviceBusy()
    if (globalState === 'limited') return tooMany(300)

    const body = (await req.json().catch(() => ({}))) as {
      phone?: string
      password?: string
      turnstileToken?: string
    }
    const { phone, password, turnstileToken } = body

    if (!/^1[3-9]\d{9}$/.test(phone ?? '')) return json({ error: '手机号格式不正确' }, 400)
    if (typeof password !== 'string' || password.length < 6) {
      return json({ error: '密码至少 6 位' }, 400)
    }

    // ③ 手机号维度：同一号码反复注册直接拒（也顺带压住枚举速率）
    const phoneState = await checkRules(PHONE_RULES, phone!)
    if (phoneState === 'error') return serviceBusy()
    if (phoneState === 'limited') return tooMany(3600)

    // ④ 人机验证（未配置 Turnstile 时自动跳过）
    if (!(await verifyTurnstile(turnstileToken, ip))) {
      return json({ error: '人机验证未通过，请重试' }, 400)
    }

    console.log(`[register] ip=${ip} 已通过限流与人机验证`)

    const email = `${phone}@phone.local`
    const { error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { phone, name: '' },
    })
    if (error) {
      const msg = (error.message ?? '').toLowerCase()
      if (msg.includes('already') || msg.includes('exists') || msg.includes('registered')) {
        return json({ error: '该手机号已注册，请直接登录' }, 400)
      }
      return json({ error: error.message }, 400)
    }
    return json({ success: true })
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : '注册失败' }, 500)
  }
})

// ============================================================
// 发送短信验证码（腾讯云 SMS）
// 部署：supabase functions deploy send-otp
// 环境变量：TENCENT_SECRET_ID / TENCENT_SECRET_KEY /
//           TENCENT_SMS_APP_ID / TENCENT_SMS_SIGN /
//           TENCENT_SMS_TEMPLATE_ID / TENCENT_SMS_REGION(可选)
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const tcSecretId = Deno.env.get('TENCENT_SECRET_ID')!
const tcSecretKey = Deno.env.get('TENCENT_SECRET_KEY')!
const tcAppId = Deno.env.get('TENCENT_SMS_APP_ID')!
const tcSign = Deno.env.get('TENCENT_SMS_SIGN')!
const tcTemplateId = Deno.env.get('TENCENT_SMS_TEMPLATE_ID')!
const tcRegion = Deno.env.get('TENCENT_SMS_REGION') || 'ap-guangzhou'

const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

function isChinaMobile(phone: string): boolean {
  return /^1[3-9]\d{9}$/.test(phone)
}

function genCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000))
}

// ---------------- TC3-HMAC-SHA256 签名 ----------------
function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message))
  return new Uint8Array(sig)
}

async function sha256Hex(message: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message))
  return toHex(new Uint8Array(hash))
}

async function sendTencentSms(phone: string, code: string): Promise<void> {
  const service = 'sms'
  const host = 'sms.tencentcloudapi.com'
  const action = 'SendSms'
  const version = '2021-01-11'
  const timestamp = Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)

  const payload = JSON.stringify({
    SmsSdkAppId: tcAppId,
    SignName: tcSign,
    TemplateId: tcTemplateId,
    TemplateParamSet: [code],
    PhoneNumberSet: [`+86${phone}`],
  })

  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`
  const signedHeaders = 'content-type;host'
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    await sha256Hex(payload),
  ].join('\n')

  const credentialScope = `${date}/${service}/tc3_request`
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n')

  const secretDate = await hmacSha256(tcSecretKey, date)
  const secretService = await hmacSha256(secretDate, service)
  const secretSigning = await hmacSha256(secretService, 'tc3_request')
  const signature = toHex(await hmacSha256(secretSigning, stringToSign))

  const authorization =
    `TC3-HMAC-SHA256 Credential=${tcSecretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const res = await fetch(`https://${host}/`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json; charset=utf-8',
      Host: host,
      'X-TC-Action': action,
      'X-TC-Version': version,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Region': tcRegion,
    },
    body: payload,
  })
  const data = await res.json()
  if (!res.ok || data.Response?.Error) {
    throw new Error(JSON.stringify(data.Response?.Error ?? data))
  }
}

// ---------------- 主入口 ----------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)

  try {
    const { phone } = await req.json()
    if (!isChinaMobile(phone)) return json({ error: '手机号格式不正确' }, 400)

    // 限流：同一手机号 60 秒内只能发一次
    const recent = await supabase
      .from('otp_codes')
      .select('id')
      .eq('phone', phone)
      .gte('created_at', new Date(Date.now() - 60000).toISOString())
      .limit(1)
    if (recent.data?.length) return json({ error: '发送太频繁，请 60 秒后重试' }, 429)

    // 限流：每天最多 10 条
    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)
    const today = await supabase
      .from('otp_codes')
      .select('id', { count: 'exact', head: true })
      .eq('phone', phone)
      .gte('created_at', dayStart.toISOString())
    if ((today.count ?? 0) >= 10) return json({ error: '今日发送次数已达上限' }, 429)

    const code = genCode()
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()

    const { error: insertErr } = await supabase
      .from('otp_codes')
      .insert({ phone, code, expires_at: expiresAt })
    if (insertErr) throw insertErr

    try {
      await sendTencentSms(phone, code)
    } catch (smsErr) {
      // 短信发送失败，删除验证码，避免产生无效验证码
      await supabase.from('otp_codes').delete().eq('phone', phone).eq('code', code)
      throw smsErr
    }

    return json({ success: true, message: '验证码已发送' })
  } catch (err) {
    console.error('send-otp error:', err)
    return json({ error: err instanceof Error ? err.message : '发送失败' }, 500)
  }
})

/**
 * Edge Function 统一的 CORS 工具。
 *
 * 只给白名单内的 Origin 回 CORS 头；未命中就不回，浏览器会拦下跨源读取。
 * 没有 Origin 的请求（curl / Node 脚本 / 服务端调用）照常处理 —— CORS 从来不是服务端防护，
 * 它的作用是不让任意网页拿访客的浏览器当跳板来调我们的接口。
 *
 * 新增部署域名时改 ALLOWED_ORIGINS / PREVIEW_SUFFIXES，然后重新部署用到它的函数。
 */

const ALLOWED_ORIGINS = new Set([
  // —— 线上 ——
  'https://dialysis-49v.pages.dev', // App（Cloudflare Pages 项目 dialysis）
  'https://dialysis-admin.pages.dev', // 后台管理端（项目 dialysis-admin）
  // —— 本地开发 ——
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  // —— Capacitor WebView（Android 用 https://localhost，iOS 用 capacitor://localhost） ——
  'https://localhost',
  'capacitor://localhost',
  'http://localhost',
])

/** Cloudflare Pages 的预览/分支域名：<hash>.dialysis-49v.pages.dev 这类 */
const PREVIEW_SUFFIXES = ['.dialysis-49v.pages.dev', '.dialysis-admin.pages.dev']

export function allowedOrigin(req: Request): string | null {
  const origin = req.headers.get('Origin')
  if (!origin) return null
  if (ALLOWED_ORIGINS.has(origin)) return origin
  try {
    const { protocol, hostname } = new URL(origin)
    if (protocol === 'https:' && PREVIEW_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
      return origin
    }
  } catch {
    // Origin 不是合法 URL：当作不允许
  }
  return null
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = allowedOrigin(req)
  const vary = { Vary: 'Origin' }
  if (!origin) return vary
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    ...vary,
  }
}

/** OPTIONS 预检：浏览器在预检里不带凭据，必须无条件放行 */
export function preflight(req: Request): Response {
  return new Response('ok', { headers: corsHeaders(req) })
}

export function jsonResponse(
  req: Request,
  data: unknown,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req), ...extra },
  })
}

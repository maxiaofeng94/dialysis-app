import { ref } from 'vue'
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY, isConfigured } from './supabase'
import type {
  AdminUserRow,
  AuditRow,
  ListQuery,
  OverviewStats,
  Paged,
  PatientDetail,
  PatientRow,
  UserDetail,
  Whoami,
} from './types'

/** 后台接口错误：带上 HTTP 状态码，401/403 由调用方做差异化处理 */
export class AdminApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'AdminApiError'
    this.status = status
  }
}

/** 最近一次请求返回的告警（例如审计日志写入失败），由界面提示用户 */
export const lastWarning = ref<string | null>(null)

/**
 * 登录态失效（401）时的回调，由 auth.ts 注册。
 * 放在这里用注册制，是为了避免 api.ts ↔ auth.ts 循环依赖。
 */
let unauthorizedHandler: (() => void) | null = null

export function setUnauthorizedHandler(fn: () => void): void {
  unauthorizedHandler = fn
}

/**
 * 无后台权限（403）时的回调，同样由 auth.ts 注册。
 * 403 不等于「登录态失效」：可能是权限刚被撤销，也可能是单个 action 被拒，
 * 所以这里只上报，由 auth.ts 复核 whoami 后再决定是否登出（避免误伤）。
 */
let forbiddenHandler: (() => Promise<void> | void) | null = null

export function setForbiddenHandler(fn: () => Promise<void> | void): void {
  forbiddenHandler = fn
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase!.auth.getSession()
  const token = data.session?.access_token
  if (!token) {
    // 本地已经没有登录凭证了：单抛错的话页面会一直停在原地反复报「登录已过期」，
    // 所以同样上报给 auth.ts，统一登出并回到登录页。
    unauthorizedHandler?.()
    throw new AdminApiError('登录已过期，请重新登录', 401)
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    apikey: SUPABASE_ANON_KEY,
  }
}

/** 调用 admin-api（唯一入口） */
export async function call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!isConfigured) {
    throw new AdminApiError('未配置 Supabase 连接（缺少 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY）', 500)
  }

  // 取 token 失败（无 session）时抛的是 401，必须原样上传，不能被下面的断网分支吞掉
  const headers = await authHeaders()

  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/admin-api`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action, payload }),
    })
  } catch {
    // 断网 / DNS 失败 / 被拦截：浏览器只给 TypeError: Failed to fetch，转成中文提示
    throw new AdminApiError('网络连接失败，请检查网络后重试', 0)
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; data?: T; warning?: string }

  // 登录凭证失效：交给 auth.ts 统一登出并回到登录页，避免页面反复报错却停在原地
  if (res.status === 401) unauthorizedHandler?.()

  // 无后台权限：交给 auth.ts 复核身份（确认已不是管理员才登出）
  if (res.status === 403 && forbiddenHandler) {
    try {
      await forbiddenHandler()
    } catch {
      // 复核身份本身失败不影响把原始 403 抛给页面
    }
  }

  if (!res.ok || body.error) {
    throw new AdminApiError(body.error ?? `请求失败（HTTP ${res.status}）`, res.status)
  }
  lastWarning.value = body.warning ?? null
  return body.data as T
}

export function messageOf(err: unknown): string {
  if (err instanceof AdminApiError) return err.message
  if (err instanceof Error) return err.message
  return '操作失败'
}

/** 统一的接口封装，页面只调这里 */
export const api = {
  // ---- 读 ----
  whoami: () => call<Whoami>('whoami'),
  overview: () => call<OverviewStats>('stats.overview'),
  users: (query: ListQuery = {}) => call<Paged<AdminUserRow>>('user.list', { ...query }),
  user: (userId: string) => call<UserDetail>('user.get', { userId }),
  patients: (query: ListQuery = {}) => call<Paged<PatientRow>>('patient.list', { ...query }),
  patient: (patientId: string) => call<PatientDetail>('patient.get', { patientId }),
  audit: (query: ListQuery = {}) => call<Paged<AuditRow>>('audit.list', { ...query }),

  // ---- 用户 ----
  renameUser: (userId: string, name: string) => call<{ userId: string }>('user.rename', { userId, name }),
  setBanned: (userId: string, banned: boolean) => call<{ note?: string }>('user.setBanned', { userId, banned }),
  resetPassword: (userId: string, password?: string) =>
    call<{ password: string }>('user.resetPassword', { userId, password }),
  createUser: (phone: string, password: string, name: string) =>
    call<{ userId: string }>('user.create', { phone, password, name }),
  deleteUser: (userId: string, mode: 'detach' | 'purge', confirmPhone: string) =>
    call<{ deletedPatients: string[] }>('user.delete', { userId, mode, confirmPhone }),

  // ---- 管理员 ----
  grantAdmin: (userId: string, note?: string) => call<unknown>('admin.grant', { userId, note }),
  revokeAdmin: (userId: string) => call<unknown>('admin.revoke', { userId }),

  // ---- 成员 ----
  addMember: (patientId: string, phone: string, role: string) =>
    call<unknown>('member.add', { patientId, phone, role }),
  setMemberRole: (patientId: string, userId: string, role: string) =>
    call<unknown>('member.setRole', { patientId, userId, role }),
  removeMember: (patientId: string, userId: string) => call<unknown>('member.remove', { patientId, userId }),

  // ---- 病人 ----
  updatePatient: (
    patientId: string,
    patch: { name?: string; birthday?: string; wheelchairWeight?: number; rinseBackVolume?: number },
  ) => call<unknown>('patient.update', { patientId, ...patch }),
  transferOwner: (patientId: string, toUserId: string) =>
    call<{ demoted: string[] }>('patient.transferOwner', { patientId, toUserId }),
  deletePatient: (patientId: string, confirmName: string) =>
    call<{ removedSessions: number }>('patient.delete', { patientId, confirmName }),
}

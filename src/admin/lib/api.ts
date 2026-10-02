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

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase!.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new AdminApiError('登录已过期，请重新登录', 401)
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

  const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-api`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ action, payload }),
  })
  const body = (await res.json().catch(() => ({}))) as { error?: string; data?: T; warning?: string }

  // 登录凭证失效：交给 auth.ts 统一登出并回到登录页，避免页面反复报错却停在原地
  if (res.status === 401) unauthorizedHandler?.()

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

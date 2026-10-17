import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY, readPersistedUser } from './supabase'
import { resilientFetch } from './resilientFetch'
import { cacheFirstWithRevalidate } from './cloudCache'
import { withTimeout } from '../utils/timeout'
import type { Patient } from '../types'

/** 取 access token 的上限：超时退回 anon key，别让「新建病人」按钮一直转 */
const EDGE_TOKEN_TIMEOUT_MS = 8000

export interface MemberInfo {
  userId: string
  name: string | null
  phone: string | null
  role: string
}

function patientFromRow(r: any): Patient {
  return {
    id: r.id,
    name: r.name,
    birthday: r.birthday ?? '',
    wheelchairWeight: Number(r.wheelchair_weight ?? 0),
    rinseBackVolume: Number(r.rinse_back_volume ?? 300),
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: new Date(r.updated_at).getTime(),
  }
}

/**
 * 当前登录用户的 id —— 只读本地存储，**不发任何网络请求**。
 *
 * 两个坑都踩过：
 * - 原来用 `getUser()`：每次都要发一趟 `/auth/v1/user`，弱网下既慢又可能失败，
 *   而失败时 `data.user` 为 null，会被调用方的 `if (!uid) return []` 静默变成
 *   「一个病人都没有」→ 首页显示「还没有病人档案，去『设置』新建」，用户会真的去建重复档案；
 * - 改成 `getSession()` 之后仍然会挂：access token 过期时它会顺手去刷新，
 *   弱网下卡住的话，路由守卫里的病人校准也要跟着一起等（实测进首页要 20 秒）。
 *
 * 这里只需要一个 id，读持久化的登录态就够了；真过期了后续请求会 401，
 * 由读接口的 error 检查与 onAuthStateChange 去处理。
 */
async function currentUid(): Promise<string | null> {
  const user = await readPersistedUser()
  return user?.id ?? null
}

/**
 * 调用 Edge Function 的请求头：
 * - Authorization 必须是当前登录用户的 access token（函数靠它识别调用者）；
 * - apikey 带上项目 key，供函数网关识别项目。
 *
 * `getSession()` 在 token 过期时会顺手刷新，弱网下可能挂住 —— 新建病人/邀请成员
 * 的按钮就会一直转。这里封 8 秒上限，超时退回 anon key（函数那边会按未登录处理并给出明确错误）。
 */
async function edgeHeaders(): Promise<Record<string, string>> {
  const session = await withTimeout(supabase!.auth.getSession(), EDGE_TOKEN_TIMEOUT_MS, null)
  const token = session?.data?.session?.access_token || SUPABASE_ANON_KEY
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    apikey: SUPABASE_ANON_KEY,
  }
}

/** 当前用户可访问的病人列表（含角色）—— 带本地缓存，先显示再后台刷新 */
export async function listMyPatients(): Promise<{ patient: Patient; role: string }[]> {
  const uid = await currentUid()
  // ⚠️ 读不到 uid 时必须**抛错**，不能返回空数组：
  // 调用方会把「空」理解成「这个账号一个病人都没有」——首页显示
  // 「还没有病人档案，去『设置』新建或上传本地数据」，用户于是真的去建一个重复档案
  // （App 内删不掉，只能上后台/跑 SQL）。抛错则各处已有的 catch 会把页面显示成
  // 「加载失败」，那才是对的语义，用户会去重试而不是重建。
  if (!uid) throw new Error('登录状态读取失败，请重新登录后再试')
  return cacheFirstWithRevalidate(`myPatients:${uid}`, async () => {
    const { data, error } = await supabase!.from('patient_members').select('role, patients(*)').eq('user_id', uid)
    // 读接口必须检查 error：PostgREST 出错时 data 为 null，`(data ?? []).map(...)`
    // 会把「查询失败」静默变成「一个病人都没有」——首页据此显示
    // 「还没有病人档案，去『设置』新建」，用户会真的去建一个重复档案（数据污染）。
    // 之前只有 cloudRepository 做了检查，这里的三个读函数漏了。
    if (error) throw error
    return (data ?? []).map((r: any) => ({
      patient: patientFromRow(r.patients),
      role: r.role,
    }))
  })
}

/** 某病人的成员列表 —— 带本地缓存，先显示再后台刷新 */
export async function listMembers(patientId: string): Promise<MemberInfo[]> {
  return cacheFirstWithRevalidate(`members:${patientId}`, async () => {
    const { data, error } = await supabase!
      .from('patient_members')
      .select('user_id, role, users(name, phone)')
      .eq('patient_id', patientId)
    // 同上：不检查 error 的话，成员页会把「查询失败」显示成「暂无成员」，
    // 用户会以为自己被移出了、家里人的账号都没了。
    if (error) throw error
    return (data ?? []).map((r: any) => ({
      userId: r.user_id,
      name: r.users?.name ?? null,
      phone: r.users?.phone ?? null,
      role: r.role,
    }))
  })
}

/** 我的资料（public.users）—— 记录人显示用 */
export async function getMyProfile(): Promise<{ name: string | null; phone: string | null } | null> {
  const uid = await currentUid()
  if (!uid) return null
  const { data, error } = await supabase!.from('users').select('name, phone').eq('id', uid).maybeSingle()
  if (error) throw error
  return data ? { name: data.name ?? null, phone: data.phone ?? null } : null
}

/** 修改我的姓名（记录人显示时优先用姓名，为空则显示手机号） */
export async function updateMyName(name: string) {
  const uid = await currentUid()
  if (!uid) return { ok: false, error: '未登录' }
  const { error } = await supabase!.from('users').update({ name: name || null }).eq('id', uid)
  return { ok: !error, error: error?.message }
}

/** 创建病人（Edge Function 原子完成：病人 + owner 成员） */
export async function createPatient(name: string, wheelchairWeight = 0, rinseBackVolume = 300) {
  // 用 resilientFetch 拿到 15 秒超时：裸 fetch 在「连上了但服务端不响应」时永不返回，
  // 按钮会一直转、调用方的 finally 永远不执行。非幂等 POST 不会被它重试。
  const res = await resilientFetch(`${SUPABASE_URL}/functions/v1/create-patient`, {
    method: 'POST',
    headers: await edgeHeaders(),
    body: JSON.stringify({ name, wheelchairWeight, rinseBackVolume }),
  })
  return { ok: res.ok, data: await res.json().catch(() => ({})) }
}

/** 按手机号邀请成员（Edge Function，仅 owner） */
export async function inviteMember(patientId: string, phone: string, role: string) {
  const res = await resilientFetch(`${SUPABASE_URL}/functions/v1/invite-member`, {
    method: 'POST',
    headers: await edgeHeaders(),
    body: JSON.stringify({ patientId, phone, role }),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, error: data?.error }
}

/**
 * 成员表的写操作也要 `.select()` 复查影响行数。
 * RLS 对无权限的行是静默过滤的：更新/删除 0 行同样返回 204、error 为 null，
 * 前端如果只看 error，就会提示「已移除 / 角色已更新」，实际什么都没发生。
 */
function memberWriteFailed(data: unknown[] | null, action: string): { ok: false; error: string } | null {
  if (data?.length) return null
  return { ok: false, error: `${action}失败：可能没有权限，或该成员已被其他人处理` }
}

/** 设置成员角色（RLS 仅 owner 可改） */
export async function setMemberRole(patientId: string, userId: string, role: string) {
  const { data, error } = await supabase!
    .from('patient_members')
    .update({ role })
    .eq('patient_id', patientId)
    .eq('user_id', userId)
    .select('user_id')
  if (error) return { ok: false, error: error.message }
  return memberWriteFailed(data, '修改成员角色') ?? { ok: true }
}

/** 移除成员（RLS 仅 owner 可删） */
export async function removeMember(patientId: string, userId: string) {
  const { data, error } = await supabase!
    .from('patient_members')
    .delete()
    .eq('patient_id', patientId)
    .eq('user_id', userId)
    .select('user_id')
  if (error) return { ok: false, error: error.message }
  return memberWriteFailed(data, '移除成员') ?? { ok: true }
}

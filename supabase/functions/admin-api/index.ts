// ============================================================
// 后台管理接口（唯一入口）—— 透析记录多人版
// 设计说明：docs/后台管理系统设计说明.md
//
// 部署：supabase functions deploy admin-api --project-ref <ref> --use-api
//       （保持默认的 verify_jwt 校验；register 才需要 --no-verify-jwt）
//
// 鉴权链：网关校验 JWT → getUser(token) 识别调用者 → 查 public.admins
//   · whoami 对任何登录用户开放（前端用它判断「是不是管理员」）
//   · 其余 action 一律要求管理员，否则 403
// 权限：读写全部由 service_role 执行（绕过 RLS），因此不需要改动任何现有业务表策略
// 留痕：所有写操作成功后写 public.admin_audit_logs
// 隐私：只返回账号 / 成员关系 / 病人基础配置 / 记录聚合数字，不返回任何病历明细
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2'
import { preflight, jsonResponse } from '../_shared/cors.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

// ---------- 基础工具 ----------

/** 抛出带 HTTP 状态码的错误，由入口统一转成 { error } */
function fail(message: string, status = 400): never {
  const err = new Error(message) as Error & { status?: number }
  err.status = status
  throw err
}

type Row = Record<string, any>

const ROLES = ['owner', 'caregiver', 'doctor', 'viewer'] as const
const ROLE_LABELS: Record<string, string> = {
  owner: '创建者',
  caregiver: '家属/护工',
  doctor: '医生',
  viewer: '只读',
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function requireId(v: unknown, label: string): string {
  const id = str(v)
  if (!id) fail(`缺少${label}参数`, 400)
  return id
}

function requirePhone(v: unknown): string {
  const phone = str(v)
  if (!/^1[3-9]\d{9}$/.test(phone)) fail('手机号格式不正确', 400)
  return phone
}

function requireRole(v: unknown): string {
  const role = str(v)
  if (!(ROLES as readonly string[]).includes(role)) fail('角色不正确', 400)
  return role
}

function parsePaging(payload: any, defSize = 20) {
  const page = Math.max(1, Math.floor(Number(payload?.page ?? 1)) || 1)
  const raw = Math.floor(Number(payload?.size ?? defSize)) || defSize
  const size = Math.min(100, Math.max(5, raw))
  return { page, size }
}

function isBanned(bannedUntil?: string | null): boolean {
  if (!bannedUntil) return false
  const t = Date.parse(bannedUntil)
  return Number.isFinite(t) && t > Date.now()
}

function randomPassword(len = 10): string {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => chars[b % chars.length]).join('')
}

// ---------- 数据读取辅助 ----------

/** 绕过 PostgREST 默认 1000 行上限，分页拉全量（带安全阀） */
async function selectAll(table: string, columns: string, build?: (q: any) => any): Promise<Row[]> {
  const size = 1000
  const out: Row[] = []
  for (let from = 0; from < 50000; from += size) {
    let q: any = supabase.from(table).select(columns).range(from, from + size - 1)
    if (build) q = build(q)
    const { data, error } = await q
    if (error) fail(`读取 ${table} 失败：${error.message}`, 500)
    const rows = (data ?? []) as Row[]
    out.push(...rows)
    if (rows.length < size) break
  }
  return out
}

async function countRows(table: string, build?: (q: any) => any): Promise<number> {
  let q: any = supabase.from(table).select('*', { count: 'exact', head: true })
  if (build) q = build(q)
  const { count, error } = await q
  if (error) fail(`统计 ${table} 失败：${error.message}`, 500)
  return count ?? 0
}

function loadProfiles(): Promise<Row[]> {
  return selectAll('users', 'id, name, phone, created_at')
}

function loadMembers(): Promise<Row[]> {
  return selectAll('patient_members', 'id, patient_id, user_id, role, created_at')
}

function loadPatients(): Promise<Row[]> {
  return selectAll(
    'patients',
    'id, name, birthday, wheelchair_weight, rinse_back_volume, created_at, updated_at',
  )
}

async function loadAdminIds(): Promise<Set<string>> {
  const rows = await selectAll('admins', 'user_id')
  return new Set(rows.map((r) => r.user_id as string))
}

interface AuthInfo {
  email: string | null
  createdAt: string | null
  lastSignIn: string | null
  bannedUntil: string | null
}

/**
 * auth.users 的数据 PostgREST 读不到（不暴露 auth schema），只能用 Admin API。
 * 家庭应用量级下按 1000/页循环取完即可。
 */
async function loadAuthUsers(): Promise<Map<string, AuthInfo>> {
  const map = new Map<string, AuthInfo>()
  const perPage = 1000
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await (supabase.auth.admin as any).listUsers({ page, perPage })
    if (error) fail(`读取账号列表失败：${error.message}`, 500)
    const users: Row[] = data?.users ?? []
    for (const u of users) {
      map.set(u.id, {
        email: u.email ?? null,
        createdAt: u.created_at ?? null,
        lastSignIn: u.last_sign_in_at ?? null,
        bannedUntil: u.banned_until ?? null,
      })
    }
    if (users.length < perPage) break
  }
  return map
}

interface PatientStat {
  count: number
  firstDate: string | null
  lastDate: string | null
}

/** 只取聚合数字（记录条数 / 首末日期），不读病历内容 */
async function patientStats(): Promise<Map<string, PatientStat>> {
  const { data, error } = await supabase.rpc('admin_patient_stats')
  if (error) fail(`读取记录统计失败：${error.message}`, 500)
  const map = new Map<string, PatientStat>()
  for (const r of (data ?? []) as Row[]) {
    map.set(r.patient_id, {
      count: Number(r.session_count ?? 0),
      firstDate: r.first_date ?? null,
      lastDate: r.last_date ?? null,
    })
  }
  return map
}

async function getProfile(uid: string): Promise<Row | null> {
  const { data } = await supabase
    .from('users')
    .select('id, name, phone, created_at')
    .eq('id', uid)
    .maybeSingle()
  return data ?? null
}

// ---------- 上下文与分发类型 ----------

interface Ctx {
  uid: string
  isAdmin: boolean
  name: string | null
  phone: string | null
}

interface Audit {
  action: string
  targetType?: string
  targetId?: string
  detail?: Row
}

interface HandlerResult {
  data?: unknown
  audit?: Audit
}

type Handler = (payload: any, ctx: Ctx) => Promise<HandlerResult>

// ============================================================
// 读接口
// ============================================================

/** 概览统计 */
async function statsOverview(): Promise<HandlerResult> {
  const since = new Date(Date.now() - 7 * 864e5).toISOString()
  const [userCount, patientCount, sessionCount, newUsers7d, newSessions7d, admins] =
    await Promise.all([
      countRows('users'),
      countRows('patients'),
      countRows('sessions'),
      countRows('users', (q) => q.gte('created_at', since)),
      countRows('sessions', (q) => q.gte('created_at', since)),
      loadAdminIds(),
    ])

  const [profiles, members, patients, stats, authUsers] = await Promise.all([
    loadProfiles(),
    loadMembers(),
    loadPatients(),
    patientStats(),
    loadAuthUsers(),
  ])

  const usersWithPatient = new Set(members.map((m) => m.user_id))
  const patientsWithMember = new Set(members.map((m) => m.patient_id))
  const sevenDaysAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)

  // 历史数据体检：auth 里有账号但 public.users 没有资料行（触发器是后加的）
  const profileIds = new Set(profiles.map((p) => p.id))
  let missingProfile = 0
  for (const id of authUsers.keys()) if (!profileIds.has(id)) missingProfile++

  return {
    data: {
      userCount,
      patientCount,
      sessionCount,
      newUsers7d,
      newSessions7d,
      adminCount: admins.size,
      usersWithoutPatient: profiles.filter((p) => !usersWithPatient.has(p.id)).length,
      patientsWithoutMember: patients.filter((p) => !patientsWithMember.has(p.id)).length,
      activePatients7d: [...stats.values()].filter((s) => (s.lastDate ?? '') >= sevenDaysAgo)
        .length,
      missingProfile,
    },
  }
}

/** 用户列表（分页 / 搜索 / 排序） */
async function userList(payload: any): Promise<HandlerResult> {
  const { page, size } = parsePaging(payload)
  const search = str(payload?.search).toLowerCase()
  const sort = str(payload?.sort) === 'lastSignIn' ? 'lastSignIn' : 'createdAt'
  const desc = str(payload?.order) !== 'asc'

  const [profiles, members, patients, admins, authUsers] = await Promise.all([
    loadProfiles(),
    loadMembers(),
    loadPatients(),
    loadAdminIds(),
    loadAuthUsers(),
  ])

  const patientName = new Map(patients.map((p) => [p.id, p.name as string]))
  const byUser = new Map<string, Row[]>()
  for (const m of members) {
    const list = byUser.get(m.user_id) ?? []
    list.push(m)
    byUser.set(m.user_id, list)
  }

  const rows: Row[] = profiles.map((p) => {
    const auth = authUsers.get(p.id)
    const ms = byUser.get(p.id) ?? []
    return {
      id: p.id,
      phone: p.phone ?? null,
      name: p.name ?? null,
      createdAt: p.created_at ?? null,
      lastSignInAt: auth?.lastSignIn ?? null,
      banned: isBanned(auth?.bannedUntil),
      bannedUntil: auth?.bannedUntil ?? null,
      isAdmin: admins.has(p.id),
      profileMissing: false,
      patientCount: ms.length,
      roles: ms.map((m) => ({
        patientId: m.patient_id,
        patientName: patientName.get(m.patient_id) ?? '（病人已删除）',
        role: m.role,
      })),
    }
  })

  // 仅有 auth 账号、没有资料行的历史账号也列出来，便于排查
  const profileIds = new Set(profiles.map((p) => p.id))
  for (const [id, auth] of authUsers) {
    if (profileIds.has(id)) continue
    rows.push({
      id,
      phone: null,
      name: null,
      createdAt: auth.createdAt,
      lastSignInAt: auth.lastSignIn,
      banned: isBanned(auth.bannedUntil),
      bannedUntil: auth.bannedUntil,
      isAdmin: admins.has(id),
      profileMissing: true,
      patientCount: 0,
      roles: [],
    })
  }

  const filtered = search
    ? rows.filter(
        (r) =>
          String(r.phone ?? '').toLowerCase().includes(search) ||
          String(r.name ?? '').toLowerCase().includes(search),
      )
    : rows

  filtered.sort((a, b) => {
    const av = String(a[sort] ?? '')
    const bv = String(b[sort] ?? '')
    if (av === bv) return String(a.id).localeCompare(String(b.id))
    return (desc ? -1 : 1) * (av < bv ? -1 : 1)
  })

  return {
    data: {
      total: filtered.length,
      page,
      size,
      rows: filtered.slice((page - 1) * size, page * size),
    },
  }
}

/** 用户详情 */
async function userGet(payload: any): Promise<HandlerResult> {
  const userId = requireId(payload?.userId, '用户')
  const [profiles, members, patients, stats, admins, authUsers] = await Promise.all([
    loadProfiles(),
    loadMembers(),
    loadPatients(),
    patientStats(),
    loadAdminIds(),
    loadAuthUsers(),
  ])

  const profile = profiles.find((p) => p.id === userId)
  const auth = authUsers.get(userId)
  if (!profile && !auth) fail('用户不存在', 404)

  const patientMap = new Map(patients.map((p) => [p.id, p]))
  const memberships = members
    .filter((m) => m.user_id === userId)
    .map((m) => {
      const pid = m.patient_id as string
      const patient = patientMap.get(pid)
      const st = stats.get(pid)
      const owners = members
        .filter((x) => x.patient_id === pid && x.role === 'owner')
        .map((x) => x.user_id as string)
      return {
        patientId: pid,
        patientName: patient?.name ?? '（病人已删除）',
        role: m.role,
        roleLabel: ROLE_LABELS[m.role] ?? m.role,
        joinedAt: m.created_at ?? null,
        patientCreatedAt: patient?.created_at ?? null,
        sessionCount: st?.count ?? 0,
        lastSessionDate: st?.lastDate ?? null,
        ownerCount: owners.length,
      }
    })

  return {
    data: {
      user: {
        id: userId,
        phone: profile?.phone ?? null,
        name: profile?.name ?? null,
        createdAt: profile?.created_at ?? auth?.createdAt ?? null,
        lastSignInAt: auth?.lastSignIn ?? null,
        banned: isBanned(auth?.bannedUntil),
        bannedUntil: auth?.bannedUntil ?? null,
        isAdmin: admins.has(userId),
        profileMissing: !profile,
        authEmail: auth?.email ?? null,
      },
      patients: memberships,
    },
  }
}

/** 病人列表（分页 / 搜索） */
async function patientList(payload: any): Promise<HandlerResult> {
  const { page, size } = parsePaging(payload)
  const search = str(payload?.search).toLowerCase()

  const [patients, members, profiles, stats] = await Promise.all([
    loadPatients(),
    loadMembers(),
    loadProfiles(),
    patientStats(),
  ])

  const userMap = new Map(profiles.map((p) => [p.id, p]))
  const byPatient = new Map<string, Row[]>()
  for (const m of members) {
    const list = byPatient.get(m.patient_id) ?? []
    list.push(m)
    byPatient.set(m.patient_id, list)
  }

  const rows = patients.map((p) => {
    const pid = p.id as string
    const ms = byPatient.get(pid) ?? []
    const st = stats.get(pid)
    const memberInfo = ms.map((m) => ({
      userId: m.user_id,
      name: userMap.get(m.user_id)?.name ?? null,
      phone: userMap.get(m.user_id)?.phone ?? null,
      role: m.role,
      roleLabel: ROLE_LABELS[m.role] ?? m.role,
      joinedAt: m.created_at ?? null,
    }))
    return {
      id: pid,
      name: p.name,
      birthday: p.birthday ?? '',
      wheelchairWeight: Number(p.wheelchair_weight ?? 0),
      rinseBackVolume: Number(p.rinse_back_volume ?? 300),
      createdAt: p.created_at ?? null,
      updatedAt: p.updated_at ?? null,
      memberCount: ms.length,
      ownerCount: ms.filter((m) => m.role === 'owner').length,
      owners: memberInfo.filter((m) => m.role === 'owner').map((m) => m.name || m.phone || '未命名'),
      members: memberInfo,
      sessionCount: st?.count ?? 0,
      firstSessionDate: st?.firstDate ?? null,
      lastSessionDate: st?.lastDate ?? null,
    }
  })

  const filtered = search ? rows.filter((r) => String(r.name).toLowerCase().includes(search)) : rows
  filtered.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))

  return {
    data: {
      total: filtered.length,
      page,
      size,
      rows: filtered.slice((page - 1) * size, page * size),
    },
  }
}

/** 病人详情 */
async function patientGet(payload: any): Promise<HandlerResult> {
  const patientId = requireId(payload?.patientId, '病人')
  const [patients, members, profiles, stats] = await Promise.all([
    loadPatients(),
    loadMembers(),
    loadProfiles(),
    patientStats(),
  ])
  const patient = patients.find((p) => p.id === patientId)
  if (!patient) fail('病人不存在', 404)

  const userMap = new Map(profiles.map((p) => [p.id, p]))
  const ms = members.filter((m) => m.patient_id === patientId)
  const st = stats.get(patientId)

  return {
    data: {
      patient: {
        id: patient.id,
        name: patient.name,
        birthday: patient.birthday ?? '',
        wheelchairWeight: Number(patient.wheelchair_weight ?? 0),
        rinseBackVolume: Number(patient.rinse_back_volume ?? 300),
        createdAt: patient.created_at ?? null,
        updatedAt: patient.updated_at ?? null,
      },
      members: ms.map((m) => ({
        userId: m.user_id,
        name: userMap.get(m.user_id)?.name ?? null,
        phone: userMap.get(m.user_id)?.phone ?? null,
        profileMissing: !userMap.has(m.user_id),
        role: m.role,
        roleLabel: ROLE_LABELS[m.role] ?? m.role,
        joinedAt: m.created_at ?? null,
      })),
      stats: {
        sessionCount: st?.count ?? 0,
        firstSessionDate: st?.firstDate ?? null,
        lastSessionDate: st?.lastDate ?? null,
      },
    },
  }
}

/** 操作日志 */
async function auditList(payload: any): Promise<HandlerResult> {
  const { page, size } = parsePaging(payload, 30)
  const from = (page - 1) * size
  const { data, error, count } = await supabase
    .from('admin_audit_logs')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, from + size - 1)
  if (error) fail(`读取日志失败：${error.message}`, 500)

  const adminIds = [...new Set((data ?? []).map((r: Row) => r.admin_id).filter(Boolean))]
  const nameMap = new Map<string, Row>()
  if (adminIds.length) {
    const { data: admins } = await supabase
      .from('users')
      .select('id, name, phone')
      .in('id', adminIds as string[])
    for (const a of (admins ?? []) as Row[]) nameMap.set(a.id, a)
  }

  return {
    data: {
      total: count ?? 0,
      page,
      size,
      rows: (data ?? []).map((r: Row) => ({
        id: r.id,
        adminId: r.admin_id,
        adminName: nameMap.get(r.admin_id)?.name ?? null,
        adminPhone: nameMap.get(r.admin_id)?.phone ?? null,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        detail: r.detail ?? {},
        createdAt: r.created_at,
      })),
    },
  }
}

// ============================================================
// 写接口（所有写操作都会写审计日志）
// ============================================================

/** 修改用户姓名 */
async function userRename(payload: any): Promise<HandlerResult> {
  const userId = requireId(payload?.userId, '用户')
  const name = str(payload?.name)
  if (!name) fail('姓名不能为空', 400)
  if (name.length > 30) fail('姓名过长', 400)

  const profile = await getProfile(userId)
  if (!profile) fail('用户不存在', 404)
  const { error } = await supabase.from('users').update({ name }).eq('id', userId)
  if (error) fail(error.message, 400)

  return {
    data: { userId, name },
    audit: {
      action: 'user.rename',
      targetType: 'user',
      targetId: userId,
      detail: { from: profile.name ?? null, to: name, phone: profile.phone ?? null },
    },
  }
}

/** 禁用 / 解禁账号 */
async function userSetBanned(payload: any, ctx: Ctx): Promise<HandlerResult> {
  const userId = requireId(payload?.userId, '用户')
  const banned = Boolean(payload?.banned)
  if (userId === ctx.uid) fail('不能禁用自己', 400)

  const profile = await getProfile(userId)
  if (!profile) fail('用户不存在', 404)

  const { error } = await (supabase.auth.admin as any).updateUserById(userId, {
    ban_duration: banned ? '876000h' : 'none',
  })
  if (error) fail(error.message, 400)

  return {
    data: { userId, banned, note: banned ? '已签发 token 最长 1 小时后失效' : '已解禁' },
    audit: {
      action: banned ? 'user.ban' : 'user.unban',
      targetType: 'user',
      targetId: userId,
      detail: { phone: profile.phone ?? null, name: profile.name ?? null },
    },
  }
}

/** 重置密码：密码由管理员指定，或由服务端生成一次性随机密码 */
async function userResetPassword(payload: any): Promise<HandlerResult> {
  const userId = requireId(payload?.userId, '用户')
  const provided = str(payload?.password)
  if (provided && provided.length < 6) fail('密码至少 6 位', 400)
  const password = provided || randomPassword(10)

  const profile = await getProfile(userId)
  if (!profile) fail('用户不存在', 404)

  const { error } = await (supabase.auth.admin as any).updateUserById(userId, { password })
  if (error) fail(error.message, 400)

  return {
    data: { userId, password },
    audit: {
      action: 'user.resetPassword',
      targetType: 'user',
      targetId: userId,
      detail: { phone: profile.phone ?? null, generated: !provided },
    },
  }
}

/** 代建账号（帮不会注册的老人建号） */
async function userCreate(payload: any): Promise<HandlerResult> {
  const phone = requirePhone(payload?.phone)
  const password = str(payload?.password)
  const name = str(payload?.name)
  if (password.length < 6) fail('密码至少 6 位', 400)
  if (name.length > 30) fail('姓名过长', 400)

  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('phone', phone)
    .maybeSingle()
  if (existing) fail('该手机号已注册', 400)

  const { data, error } = await (supabase.auth.admin as any).createUser({
    email: `${phone}@phone.local`,
    password,
    email_confirm: true,
    user_metadata: { phone, name },
  })
  if (error) {
    const msg = String(error.message ?? '').toLowerCase()
    if (msg.includes('already') || msg.includes('exists') || msg.includes('registered')) {
      fail('该手机号已注册', 400)
    }
    fail(error.message, 400)
  }

  const userId = data?.user?.id as string
  if (name && userId) {
    await supabase.from('users').update({ name }).eq('id', userId)
  }

  return {
    data: { userId, phone, name },
    audit: {
      action: 'user.create',
      targetType: 'user',
      targetId: userId,
      detail: { phone, name },
    },
  }
}

/** 删除用户 */
async function userDelete(payload: any, ctx: Ctx): Promise<HandlerResult> {
  const userId = requireId(payload?.userId, '用户')
  const mode = str(payload?.mode) === 'purge' ? 'purge' : 'detach'
  if (userId === ctx.uid) fail('不能删除自己', 400)

  const [profile, members, patients] = await Promise.all([
    getProfile(userId),
    loadMembers(),
    loadPatients(),
  ])
  if (!profile) fail('用户不存在', 404)
  if (str(payload?.confirmPhone) !== String(profile.phone ?? '')) {
    fail('确认手机号不匹配，请输入该用户的完整手机号', 400)
  }

  const ownersByPatient = new Map<string, string[]>()
  for (const m of members) {
    if (m.role !== 'owner') continue
    const list = ownersByPatient.get(m.patient_id) ?? []
    list.push(m.user_id)
    ownersByPatient.set(m.patient_id, list)
  }
  const soleOwnedIds = [...ownersByPatient.entries()]
    .filter(([, owners]) => owners.length === 1 && owners[0] === userId)
    .map(([pid]) => pid)
  const patientName = new Map(patients.map((p) => [p.id, p.name as string]))
  const soleOwnedNames = soleOwnedIds.map((pid) => patientName.get(pid) ?? '（未知病人）')

  if (soleOwnedIds.length && mode !== 'purge') {
    fail(
      `该用户是「${soleOwnedNames.join('、')}」的唯一创建者。请先转移创建者，或改用「连同病人数据一并删除」。`,
      400,
    )
  }

  if (mode === 'purge' && soleOwnedIds.length) {
    const { error } = await supabase.from('patients').delete().in('id', soleOwnedIds)
    if (error) fail(`删除病人数据失败：${error.message}`, 400)
  }

  const { error } = await (supabase.auth.admin as any).deleteUser(userId)
  if (error) fail(error.message, 400)

  const deletedPatients = mode === 'purge' ? soleOwnedNames : []

  return {
    data: { userId, mode, deletedPatients },
    audit: {
      action: 'user.delete',
      targetType: 'user',
      targetId: userId,
      detail: {
        phone: profile.phone ?? null,
        name: profile.name ?? null,
        mode,
        deletedPatients,
      },
    },
  }
}

/** 授予管理员 */
async function adminGrant(payload: any, ctx: Ctx): Promise<HandlerResult> {
  const userId = requireId(payload?.userId, '用户')
  const profile = await getProfile(userId)
  if (!profile) fail('用户不存在（没有资料行，无法授予）', 404)

  const { error } = await supabase
    .from('admins')
    .insert({ user_id: userId, created_by: ctx.uid, note: str(payload?.note) || null })
  if (error && !String(error.message).includes('duplicate')) fail(error.message, 400)

  return {
    data: { userId },
    audit: {
      action: 'admin.grant',
      targetType: 'admin',
      targetId: userId,
      detail: { phone: profile.phone ?? null, name: profile.name ?? null },
    },
  }
}

/** 撤销管理员 */
async function adminRevoke(payload: any, ctx: Ctx): Promise<HandlerResult> {
  const userId = requireId(payload?.userId, '用户')
  if (userId === ctx.uid) fail('不能撤销自己的管理员权限，请让另一位管理员操作', 400)

  const admins = await loadAdminIds()
  if (!admins.has(userId)) fail('该用户不是管理员', 400)
  if (admins.size <= 1) fail('至少保留一名管理员', 400)

  const profile = await getProfile(userId)
  const { error } = await supabase.from('admins').delete().eq('user_id', userId)
  if (error) fail(error.message, 400)

  return {
    data: { userId },
    audit: {
      action: 'admin.revoke',
      targetType: 'admin',
      targetId: userId,
      detail: { phone: profile?.phone ?? null, name: profile?.name ?? null },
    },
  }
}

/** 添加成员（管理员不受「仅创建者可邀请」限制） */
async function memberAdd(payload: any): Promise<HandlerResult> {
  const patientId = requireId(payload?.patientId, '病人')
  const phone = requirePhone(payload?.phone)
  const role = requireRole(payload?.role ?? 'caregiver')

  const [patients, profiles, members] = await Promise.all([loadPatients(), loadProfiles(), loadMembers()])
  const patient = patients.find((p) => p.id === patientId)
  if (!patient) fail('病人不存在', 404)

  const target = profiles.find((p) => p.phone === phone)
  if (!target) fail('该手机号尚未注册，请先让对方注册（或用「代建账号」）', 404)
  if (members.some((m) => m.patient_id === patientId && m.user_id === target.id)) {
    fail('该用户已是此病人的成员', 400)
  }

  const { error } = await supabase
    .from('patient_members')
    .insert({ patient_id: patientId, user_id: target.id, role })
  if (error) fail(error.message, 400)

  return {
    data: { patientId, userId: target.id, role },
    audit: {
      action: 'member.add',
      targetType: 'member',
      targetId: `${patientId}:${target.id}`,
      detail: {
        patient: patient.name,
        phone,
        user: target.name ?? null,
        role,
      },
    },
  }
}

/** 修改成员角色 */
async function memberSetRole(payload: any): Promise<HandlerResult> {
  const patientId = requireId(payload?.patientId, '病人')
  const userId = requireId(payload?.userId, '成员')
  const role = requireRole(payload?.role)

  const [members, patients, profiles] = await Promise.all([loadMembers(), loadPatients(), loadProfiles()])
  const current = members.find((m) => m.patient_id === patientId && m.user_id === userId)
  if (!current) fail('该成员不存在', 404)
  if (current.role === role) return { data: { patientId, userId, role, unchanged: true } }

  const owners = members.filter((m) => m.patient_id === patientId && m.role === 'owner')
  if (current.role === 'owner' && role !== 'owner' && owners.length === 1) {
    fail('这是该病人唯一的创建者，请先用「转移创建者」，或把另一位成员设为创建者', 400)
  }

  const { error } = await supabase
    .from('patient_members')
    .update({ role })
    .eq('patient_id', patientId)
    .eq('user_id', userId)
  if (error) fail(error.message, 400)

  return {
    data: { patientId, userId, role },
    audit: {
      action: 'member.setRole',
      targetType: 'member',
      targetId: `${patientId}:${userId}`,
      detail: {
        patient: patients.find((p) => p.id === patientId)?.name ?? null,
        user: profiles.find((p) => p.id === userId)?.name ?? null,
        from: current.role,
        to: role,
      },
    },
  }
}

/** 移除成员 */
async function memberRemove(payload: any): Promise<HandlerResult> {
  const patientId = requireId(payload?.patientId, '病人')
  const userId = requireId(payload?.userId, '成员')

  const [members, patients, profiles] = await Promise.all([loadMembers(), loadPatients(), loadProfiles()])
  const current = members.find((m) => m.patient_id === patientId && m.user_id === userId)
  if (!current) fail('该成员不存在', 404)

  const owners = members.filter((m) => m.patient_id === patientId && m.role === 'owner')
  if (current.role === 'owner' && owners.length === 1) {
    fail('这是该病人唯一的创建者，请先转移创建者再移除', 400)
  }

  const { error } = await supabase
    .from('patient_members')
    .delete()
    .eq('patient_id', patientId)
    .eq('user_id', userId)
  if (error) fail(error.message, 400)

  return {
    data: { patientId, userId },
    audit: {
      action: 'member.remove',
      targetType: 'member',
      targetId: `${patientId}:${userId}`,
      detail: {
        patient: patients.find((p) => p.id === patientId)?.name ?? null,
        user: profiles.find((p) => p.id === userId)?.name ?? null,
        role: current.role,
      },
    },
  }
}

/** 修改病人基础配置 */
async function patientUpdate(payload: any): Promise<HandlerResult> {
  const patientId = requireId(payload?.patientId, '病人')
  const patients = await loadPatients()
  const patient = patients.find((p) => p.id === patientId)
  if (!patient) fail('病人不存在', 404)

  const patch: Row = {}
  const changes: Row = {}

  if (payload?.name !== undefined) {
    const name = str(payload.name)
    if (!name) fail('病人姓名不能为空', 400)
    if (name.length > 30) fail('病人姓名过长', 400)
    patch.name = name
    changes.name = { from: patient.name, to: name }
  }
  if (payload?.birthday !== undefined) {
    const birthday = str(payload.birthday)
    if (birthday && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) fail('出生日期格式应为 YYYY-MM-DD', 400)
    patch.birthday = birthday || null
    changes.birthday = { from: patient.birthday ?? null, to: birthday || null }
  }
  for (const [key, column, label] of [
    ['wheelchairWeight', 'wheelchair_weight', '轮椅重量'],
    ['rinseBackVolume', 'rinse_back_volume', '回水量'],
  ] as const) {
    if (payload?.[key] === undefined) continue
    const value = Number(payload[key])
    if (!Number.isFinite(value) || value < 0) fail(`${label}必须是不小于 0 的数字`, 400)
    patch[column] = value
    changes[key] = { from: Number(patient[column] ?? 0), to: value }
  }

  if (!Object.keys(patch).length) fail('没有需要修改的内容', 400)
  patch.updated_at = new Date().toISOString()

  const { error } = await supabase.from('patients').update(patch).eq('id', patientId)
  if (error) fail(error.message, 400)

  return {
    data: { patientId, patch },
    audit: {
      action: 'patient.update',
      targetType: 'patient',
      targetId: patientId,
      detail: { patient: patient.name, changes },
    },
  }
}

/** 转移创建者 */
async function patientTransferOwner(payload: any): Promise<HandlerResult> {
  const patientId = requireId(payload?.patientId, '病人')
  const toUserId = requireId(payload?.toUserId, '目标用户')

  const [patients, members, profiles] = await Promise.all([loadPatients(), loadMembers(), loadProfiles()])
  const patient = patients.find((p) => p.id === patientId)
  if (!patient) fail('病人不存在', 404)
  const target = profiles.find((p) => p.id === toUserId)
  if (!target) fail('目标用户不存在', 404)

  const ms = members.filter((m) => m.patient_id === patientId)
  const owners = ms.filter((m) => m.role === 'owner')
  if (owners.length === 1 && owners[0].user_id === toUserId) fail('该用户已经是创建者', 400)

  const { error: upErr } = await supabase
    .from('patient_members')
    .upsert({ patient_id: patientId, user_id: toUserId, role: 'owner' }, { onConflict: 'patient_id,user_id' })
  if (upErr) fail(upErr.message, 400)

  const demoted: string[] = []
  if (owners.length === 1 && owners[0].user_id !== toUserId) {
    const { error } = await supabase
      .from('patient_members')
      .update({ role: 'caregiver' })
      .eq('patient_id', patientId)
      .eq('user_id', owners[0].user_id)
    if (!error) demoted.push(owners[0].user_id as string)
  }

  return {
    data: { patientId, toUserId, demoted },
    audit: {
      action: 'patient.transferOwner',
      targetType: 'patient',
      targetId: patientId,
      detail: {
        patient: patient.name,
        to: target.name || target.phone,
        demoted,
      },
    },
  }
}

/** 删除病人及其全部数据 */
async function patientDelete(payload: any): Promise<HandlerResult> {
  const patientId = requireId(payload?.patientId, '病人')
  const [patients, members, stats] = await Promise.all([loadPatients(), loadMembers(), patientStats()])
  const patient = patients.find((p) => p.id === patientId)
  if (!patient) fail('病人不存在', 404)
  if (str(payload?.confirmName) !== String(patient.name)) {
    fail('确认姓名不匹配，请输入该病人的完整姓名', 400)
  }

  const { error } = await supabase.from('patients').delete().eq('id', patientId)
  if (error) fail(error.message, 400)

  return {
    data: {
      patientId,
      removedMembers: members.filter((m) => m.patient_id === patientId).length,
      removedSessions: stats.get(patientId)?.count ?? 0,
    },
    audit: {
      action: 'patient.delete',
      targetType: 'patient',
      targetId: patientId,
      detail: {
        patient: patient.name,
        members: members.filter((m) => m.patient_id === patientId).length,
        sessions: stats.get(patientId)?.count ?? 0,
      },
    },
  }
}

// ============================================================
// 路由表与入口
// ============================================================

const HANDLERS: Record<string, Handler> = {
  'stats.overview': statsOverview,
  'user.list': userList,
  'user.get': userGet,
  'patient.list': patientList,
  'patient.get': patientGet,
  'audit.list': auditList,

  'user.rename': userRename,
  'user.setBanned': userSetBanned,
  'user.resetPassword': userResetPassword,
  'user.create': userCreate,
  'user.delete': userDelete,
  'admin.grant': adminGrant,
  'admin.revoke': adminRevoke,
  'member.add': memberAdd,
  'member.setRole': memberSetRole,
  'member.remove': memberRemove,
  'patient.update': patientUpdate,
  'patient.transferOwner': patientTransferOwner,
  'patient.delete': patientDelete,
}

Deno.serve(async (req) => {
  // CORS 头按 Origin 白名单下发（见 _shared/cors.ts）
  const json = (data: unknown, status = 200) => jsonResponse(req, data, status)

  if (req.method === 'OPTIONS') return preflight(req)
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)

  try {
    const body = await req.json().catch(() => ({}))
    const action = str(body?.action)
    const payload = body?.payload ?? {}

    // 识别调用者：service 客户端自身没有 session，必须显式传入请求头里的用户 access token
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!token) return json({ error: '未登录' }, 401)
    const { data: authData } = await supabase.auth.getUser(token)
    const uid = authData?.user?.id
    if (!uid) return json({ error: '登录已过期，请重新登录' }, 401)

    const [profile, adminIds] = await Promise.all([getProfile(uid), loadAdminIds()])
    const isAdmin = adminIds.has(uid)
    const ctx: Ctx = { uid, isAdmin, name: profile?.name ?? null, phone: profile?.phone ?? null }

    // 身份自检：非管理员也能调用，用于前端判断是否有后台权限
    if (action === 'whoami') {
      return json({ ok: true, data: { userId: uid, isAdmin, name: ctx.name, phone: ctx.phone } })
    }

    if (!isAdmin) return json({ error: '无后台权限' }, 403)
    if (!action) return json({ error: '缺少 action' }, 400)
    const handler = HANDLERS[action]
    if (!handler) return json({ error: `未知操作：${action}` }, 400)

    const result = await handler(payload, ctx)

    let warning: string | undefined
    if (result.audit) {
      const { error } = await supabase.from('admin_audit_logs').insert({
        admin_id: uid,
        action: result.audit.action,
        target_type: result.audit.targetType ?? null,
        target_id: result.audit.targetId ?? null,
        detail: result.audit.detail ?? {},
      })
      // 审计写入失败不回滚已执行的操作，但要让调用方知道
      if (error) warning = `操作已执行，但审计日志写入失败：${error.message}`
    }

    return json({ ok: true, data: result.data ?? null, ...(warning ? { warning } : {}) })
  } catch (err) {
    const status = (err as { status?: number })?.status ?? 500
    return json({ error: err instanceof Error ? err.message : '操作失败' }, status)
  }
})

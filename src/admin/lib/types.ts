/** 后台管理端与 admin-api 之间的数据结构约定（与 supabase/functions/admin-api/index.ts 对应） */

export interface Paged<T> {
  total: number
  page: number
  size: number
  rows: T[]
}

export interface Whoami {
  userId: string
  isAdmin: boolean
  name: string | null
  phone: string | null
}

export interface OverviewStats {
  userCount: number
  patientCount: number
  sessionCount: number
  newUsers7d: number
  newSessions7d: number
  adminCount: number
  usersWithoutPatient: number
  patientsWithoutMember: number
  activePatients7d: number
  /** auth 里有账号但没有 public.users 资料行的历史账号数 */
  missingProfile: number
}

export interface RoleRef {
  patientId: string
  patientName: string
  role: string
}

export interface AdminUserRow {
  id: string
  phone: string | null
  name: string | null
  createdAt: string | null
  lastSignInAt: string | null
  banned: boolean
  bannedUntil: string | null
  isAdmin: boolean
  /** true 表示只有 auth 账号、缺 public.users 资料行 */
  profileMissing: boolean
  patientCount: number
  roles: RoleRef[]
}

export interface UserPatientRef {
  patientId: string
  patientName: string
  role: string
  roleLabel: string
  joinedAt: string | null
  patientCreatedAt: string | null
  sessionCount: number
  lastSessionDate: string | null
  ownerCount: number
}

export interface UserDetail {
  user: {
    id: string
    phone: string | null
    name: string | null
    createdAt: string | null
    lastSignInAt: string | null
    banned: boolean
    bannedUntil: string | null
    isAdmin: boolean
    profileMissing: boolean
    authEmail: string | null
  }
  patients: UserPatientRef[]
}

export interface MemberRow {
  userId: string
  name: string | null
  phone: string | null
  profileMissing?: boolean
  role: string
  roleLabel: string
  joinedAt: string | null
}

export interface PatientRow {
  id: string
  name: string
  birthday: string
  wheelchairWeight: number
  rinseBackVolume: number
  createdAt: string | null
  updatedAt: string | null
  memberCount: number
  ownerCount: number
  owners: string[]
  members: MemberRow[]
  sessionCount: number
  firstSessionDate: string | null
  lastSessionDate: string | null
}

export interface PatientDetail {
  patient: {
    id: string
    name: string
    birthday: string
    wheelchairWeight: number
    rinseBackVolume: number
    createdAt: string | null
    updatedAt: string | null
  }
  members: MemberRow[]
  stats: {
    sessionCount: number
    firstSessionDate: string | null
    lastSessionDate: string | null
  }
}

export interface AuditRow {
  id: number
  adminId: string | null
  adminName: string | null
  adminPhone: string | null
  action: string
  targetType: string | null
  targetId: string | null
  detail: Record<string, unknown>
  createdAt: string
}

export interface ListQuery {
  search?: string
  page?: number
  size?: number
  sort?: string
  order?: 'asc' | 'desc'
}

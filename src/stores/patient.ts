import { ref, computed } from 'vue'
import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { DEFAULT_PATIENT_ID } from '../constants'
import { isCloudConfigured } from '../lib/supabase'
import { listMyPatients } from '../lib/cloudAdmin'

// 当前病人的 id：
// - 本地模式：固定为 DEFAULT_PATIENT_ID
// - 云端模式：登录后切换为用户选择/唯一可访问的病人（持久化，刷新或重开 App 不丢）
export const currentPatientId = ref(DEFAULT_PATIENT_ID)

/**
 * 当前登录账号对「当前病人」的角色：owner / caregiver / doctor / viewer。
 * 本地模式、未登录或还没拉到时为 null（= 不限制，维持原行为）。
 */
export const currentRole = ref<string | null>(null)

/**
 * 只读角色（医生 / 只读）——他们看得到病人，但写操作会被数据库 RLS 拒绝。
 * 界面必须据此隐藏编辑入口，否则用户会遇到「点了没反应」或「删了又回来」。
 */
export const isReadOnly = computed(() => currentRole.value === 'doctor' || currentRole.value === 'viewer')

/** 云端模式下重新拉取当前病人对应的角色（本地模式恒为 null） */
export async function refreshCurrentRole(): Promise<void> {
  if (!isCloudConfigured) {
    currentRole.value = null
    return
  }
  try {
    const list = await listMyPatients()
    currentRole.value = list.find((item) => item.patient.id === currentPatientId.value)?.role ?? null
  } catch {
    // 拉不到就不要把用户当只读锁住界面（服务端仍然会拦越权写）
    currentRole.value = null
  }
}

const STORAGE_KEY = 'dialysis.currentPatientId'
const isNative = Capacitor.isNativePlatform()

async function readSaved(): Promise<string | null> {
  if (isNative) return (await Preferences.get({ key: STORAGE_KEY })).value
  return localStorage.getItem(STORAGE_KEY)
}

async function writeSaved(id: string): Promise<void> {
  if (isNative) await Preferences.set({ key: STORAGE_KEY, value: id })
  else localStorage.setItem(STORAGE_KEY, id)
}

/** 切换当前病人并持久化（设置页切换/新建病人后调用） */
export function setCurrentPatientId(id: string): void {
  currentPatientId.value = id
  writeSaved(id).catch(() => {})
}

/** 启动时恢复上次选中的病人；本地模式固定用默认病人，避免读到云端遗留值 */
export async function restorePatientId(): Promise<void> {
  if (!isCloudConfigured) {
    currentPatientId.value = DEFAULT_PATIENT_ID
    return
  }
  const saved = await readSaved().catch(() => null)
  if (saved) currentPatientId.value = saved
}

/**
 * 清除「当前病人」的本机记忆（登出 / 凭证失效时调用）。
 * 不清的话，下一个在这台设备上登录的账号如果拉取病人列表失败（离线、网络抖动），
 * 会拿着上一个账号的 patientId 命中缓存，显示别人的档案与记录。
 */
export async function clearCurrentPatient(): Promise<void> {
  currentPatientId.value = DEFAULT_PATIENT_ID
  try {
    if (isNative) await Preferences.remove({ key: STORAGE_KEY })
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 清不掉也不影响主流程
  }
}

/**
 * 校准当前病人（仅云端模式，登录后调用）：
 * - 上次选中的病人不在「我的病人」里（首次登录 / 换账号 / 被移出成员）→ 自动选第一个；
 * - 一个病人都没有 → 保持现状，由页面引导「新建病人」或「上传本地数据」。
 */
export async function ensureCloudPatient(): Promise<void> {
  if (!isCloudConfigured) return
  const list = await listMyPatients().catch(() => [])
  if (!list.length) {
    currentRole.value = null
    return
  }
  const current = list.find((item) => item.patient.id === currentPatientId.value)
  if (!current) {
    setCurrentPatientId(list[0].patient.id)
    currentRole.value = list[0].role
  } else {
    currentRole.value = current.role
  }
}

/** 当前账号下是否一个病人都没有（用于首页引导） */
export async function hasNoCloudPatient(): Promise<boolean> {
  if (!isCloudConfigured) return false
  try {
    return (await listMyPatients()).length === 0
  } catch {
    // 拉取失败（离线、网络抖动、令牌刚失效）时**不能**断言「没有病人」——
    // 首页会据此提示「还没有病人档案，去设置新建」，等于诱导用户重复建档。
    return false
  }
}

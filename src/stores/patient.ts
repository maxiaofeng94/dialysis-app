import { ref } from 'vue'
import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { DEFAULT_PATIENT_ID } from '../constants'
import { isCloudConfigured } from '../lib/supabase'
import { listMyPatients } from '../lib/cloudAdmin'

// 当前病人的 id：
// - 本地模式：固定为 DEFAULT_PATIENT_ID
// - 云端模式：登录后切换为用户选择/唯一可访问的病人（持久化，刷新或重开 App 不丢）
export const currentPatientId = ref(DEFAULT_PATIENT_ID)

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
  if (!list.length) return
  if (!list.some((item) => item.patient.id === currentPatientId.value)) {
    setCurrentPatientId(list[0].patient.id)
  }
}

/** 当前账号下是否一个病人都没有（用于首页引导） */
export async function hasNoCloudPatient(): Promise<boolean> {
  if (!isCloudConfigured) return false
  const list = await listMyPatients().catch(() => [])
  return list.length === 0
}

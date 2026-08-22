import { ref } from 'vue'
import { DEFAULT_PATIENT_ID } from '../constants'

// 当前病人的 id：
// - 本地模式：固定为 DEFAULT_PATIENT_ID
// - 云端模式：登录后切换为用户选择/唯一可访问的病人
export const currentPatientId = ref(DEFAULT_PATIENT_ID)

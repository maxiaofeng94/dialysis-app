import { createRouter, createWebHashHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'
import SessionView from '../views/SessionView.vue'
import ReportView from '../views/ReportView.vue'
import TrendView from '../views/TrendView.vue'
import SettingsView from '../views/SettingsView.vue'
import LoginView from '../views/LoginView.vue'
import MembersView from '../views/MembersView.vue'
import { useAuth } from '../stores/auth'
import { restorePatientId, ensureCloudPatient } from '../stores/patient'
import { isCloudConfigured } from '../lib/supabase'
import { withTimeout } from '../utils/timeout'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView, meta: { tabbar: true } },
    { path: '/session/:id', name: 'session', component: SessionView },
    { path: '/report/:id', name: 'report', component: ReportView },
    { path: '/trend', name: 'trend', component: TrendView, meta: { tabbar: true } },
    { path: '/settings', name: 'settings', component: SettingsView, meta: { tabbar: true } },
    { path: '/login', name: 'login', component: LoginView },
    { path: '/members', name: 'members', component: MembersView },
  ],
})

/** 读本机保存的病人 id：正常是毫秒级，给 3 秒只是防原生桥接卡死 */
const RESTORE_PATIENT_TIMEOUT_MS = 3000
/**
 * 拉「我的病人」是网络请求。守卫会 await 它，弱网下挂住就是白屏（`router-view` 渲染为空），
 * 所以必须封顶：超时就照常放行，页面自己的空态/错误提示比一直转圈有用。
 */
const SYNC_PATIENT_TIMEOUT_MS = 10000

// 已建立病人上下文的账号 id（换账号后自动重建）
let patientContextUid: string | null | undefined

// 多人版登录守卫：云端模式下未登录跳转登录页；本地模式（未配置 Supabase）不受影响
router.beforeEach(async (to) => {
  const { initialized, isLoggedIn, init, user } = useAuth()
  if (!initialized.value) await init()
  if (!isCloudConfigured) return true
  if (to.path === '/login') {
    return isLoggedIn.value ? '/' : true
  }
  if (!isLoggedIn.value) {
    patientContextUid = undefined
    return '/login'
  }
  // 恢复上次选中的病人，并校准到当前账号可访问的病人（首次登录/换账号/被移出成员）。
  // 两步都加了超时：这里的 await 直接决定首屏能不能出来，不能让网络把导航挂死。
  const uid = user.value?.id ?? null
  if (patientContextUid !== uid) {
    await withTimeout(restorePatientId(), RESTORE_PATIENT_TIMEOUT_MS, undefined)
    await withTimeout(ensureCloudPatient(), SYNC_PATIENT_TIMEOUT_MS, undefined)
    patientContextUid = uid
  }
  return true
})

export default router

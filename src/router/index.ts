import { createRouter, createWebHashHistory } from 'vue-router'
import { watch } from 'vue'
import HomeView from '../views/HomeView.vue'
import SessionView from '../views/SessionView.vue'
import ReportView from '../views/ReportView.vue'
import TrendView from '../views/TrendView.vue'
import SettingsView from '../views/SettingsView.vue'
import LoginView from '../views/LoginView.vue'
import MembersView from '../views/MembersView.vue'
import { useAuth, isLoggedIn } from '../stores/auth'
import { currentPatientId, restorePatientId, ensureCloudPatient } from '../stores/patient'
import { isCloudConfigured } from '../lib/supabase'
import { DEFAULT_PATIENT_ID } from '../constants'
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
/**
 * 上一次校准是否**真的跑完**了。
 *
 * 不能只用 `currentPatientId === DEFAULT_PATIENT_ID` 判断「没校准过」——
 * 账号确实一个病人都没有时，`ensureCloudPatient()` 不会改动它，
 * 于是每次导航都会重新拉一次病人列表（实测：4 次导航打出 2 次 `patient_members`，
 * 受 FRESH_MS 闸门限制才没变成风暴）。
 * 守卫超时（`withTimeout` 兜底）时也不算校准完成，下次导航会重试。
 */
let patientContextSynced = false

/**
 * 是否需要重建「病人上下文」（恢复上次选的病人 + 校准到本账号可访问的病人）。
 *
 * 只看「uid 变了没有」是不够的 —— 这条曾经真实踩到：
 * 从设置页点「退出登录」后跳 `/login`，守卫走的是 `to.path === '/login'` 那条分支并**直接 return**，
 * 够不到下面的重置代码，于是 `patientContextUid` 停在上一个账号的 uid 上。
 * 用户**重新登录同一个账号**时 `patientContextUid === uid` 判定为「上下文已建好」，
 * 直接跳过 `ensureCloudPatient()`；可登出时 `clearCurrentPatient()` 已经把当前病人抹成
 * `patient-default`（不是 uuid），首页拿它去查云端只会短路成空 ——
 * 表现就是「重新登录后一个病人都没有、也看不到任何记录」
 * （Web 端一直登录着走的是冷启动路径，所以看不出来；手机上退出再登录必现）。
 *
 * 所以第二个条件同样重要：当前病人 id 还停在默认值**且这次还没校准成功**时，必须重建。
 */
function needsPatientContext(uid: string | null): boolean {
  if (patientContextUid !== uid) return true
  return !patientContextSynced && currentPatientId.value === DEFAULT_PATIENT_ID
}

/**
 * 登出即作废病人上下文 —— **绑定在登录态变化上，而不是依赖「有没有导航到 /login」**。
 *
 * 守卫里那两处重置只在「确实发生过一次导航」时才执行；万一将来有人加了新的登出入口
 * 却忘了 `router.replace('/login')`，`patientContextUid` 会停在上一个账号上，
 * 「重新登录无数据」就会原样复现（`synced` 还是 true，第二道防线也兜不住）。
 * 绑在 `isLoggedIn` 上则无论走哪条路都会作废。
 */
watch(isLoggedIn, (val, old) => {
  if (old && !val) {
    patientContextUid = undefined
    patientContextSynced = false
  }
})

// 多人版登录守卫：云端模式下未登录跳转登录页；本地模式（未配置 Supabase）不受影响
router.beforeEach(async (to) => {
  const { initialized, isLoggedIn, init, user } = useAuth()
  if (!initialized.value) await init()
  if (!isCloudConfigured) return true
  if (to.path === '/login') {
    // 回到登录页（主动登出 / 被踢下线）＝ 病人上下文作废，下次登录必须重新校准
    if (!isLoggedIn.value) {
      patientContextUid = undefined
      patientContextSynced = false
    }
    return isLoggedIn.value ? '/' : true
  }
  if (!isLoggedIn.value) {
    patientContextUid = undefined
    patientContextSynced = false
    return '/login'
  }
  // 恢复上次选中的病人，并校准到当前账号可访问的病人（首次登录/换账号/重新登录/被移出成员）。
  // 两步都加了超时：这里的 await 直接决定首屏能不能出来，不能让网络把导航挂死。
  const uid = user.value?.id ?? null
  if (needsPatientContext(uid)) {
    await withTimeout(restorePatientId(), RESTORE_PATIENT_TIMEOUT_MS, undefined)
    // 用 then(() => true) 把「成功」与「超时」区分开：两者都返回 undefined 的话，
    // 超时会被误当成校准完成，于是再也不会重试
    const synced = await withTimeout(
      ensureCloudPatient().then(() => true),
      SYNC_PATIENT_TIMEOUT_MS,
      false,
    )
    patientContextUid = uid
    patientContextSynced = synced
  }
  return true
})

export default router

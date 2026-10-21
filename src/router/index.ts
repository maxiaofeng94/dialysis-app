import { createRouter, createWebHashHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'
import SessionView from '../views/SessionView.vue'
import ReportView from '../views/ReportView.vue'
import TrendView from '../views/TrendView.vue'
import SettingsView from '../views/SettingsView.vue'
import LoginView from '../views/LoginView.vue'
import MembersView from '../views/MembersView.vue'
import { useAuth, onLoggedOut } from '../stores/auth'
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
 * 「病人上下文代次」：每次登出都自增。
 *
 * 守卫里的校准是 **await** 的（弱网下 `ensureCloudPatient()` 最长 10 秒）。
 * 这期间用户完全可能登出（或被踢下线）：`onLoggedOut` 刚把上下文清空，
 * 守卫却还按旧结果无条件写回 `patientContextUid = uid; synced = true` ——
 * 于是 `patientContextUid` 停在一个**已经登出**的账号上。
 * 用户重新登录同一账号时会被判成「上下文已建好」而跳过校准，
 * 而 `clearCurrentPatient()` 已把当前病人抹成 `patient-default`（不是 uuid）→
 * 首页查云端短路为空，「重新登录后一条记录都没有」就从这条窄窗口复发。
 *
 * 只比对 `isLoggedIn` / uid 不够：**登出后立刻登录同一账号**时两者都会匹配上，
 * 但那是新一轮，必须重新校准 —— 所以用代次。
 */
let patientContextGeneration = 0

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
 * 所以第二个条件同样重要：**这次没校准成功**（没跑过 / 读失败 / 超时）时必须重建。
 *
 * ⚠️ 这里**不能**再叠加「当前病人 id 是默认值」作为条件。曾经的写法是
 * `!synced && currentPatientId === DEFAULT_PATIENT_ID`，冷启动路径会先 `restorePatientId()`
 * 恢复出**上次的真实 uuid**，随后 `ensureCloudPatient()` 读失败（不再抛错，返回 false）——
 * 此时 pid 是真实值、`synced` 是 false，可那个 pid 条件不成立 → **永远不重试**，
 * 弱网下首屏会一直用旧 pid（档案已被移出成员时就是「一条记录都没有」）。
 * 「真的一个病人都没有」的情况由 `synced === true` 表达，不需要靠 pid 区分。
 */
function needsPatientContext(uid: string | null): boolean {
  if (patientContextUid !== uid) return true
  return !patientContextSynced
}

/**
 * 登出即作废病人上下文 —— **绑定在登录态变化上，而不是依赖「有没有导航到 /login」**。
 *
 * 守卫里那两处重置只在「确实发生过一次导航」时才执行；万一将来有人加了新的登出入口
 * 却忘了 `router.replace('/login')`，`patientContextUid` 会停在上一个账号上，
 * 「重新登录无数据」就会原样复现（`synced` 还是 true，第二道防线也兜不住）。
 *
 * ⚠️ 用 `onLoggedOut()`（实现在 stores/auth 里）而不是在本模块直接 `watch(isLoggedIn)`：
 * 后者在测试的 `vi.resetModules()` 下会拿到另一个 Vue 实例，订阅静默失效。
 */
onLoggedOut(() => {
  patientContextUid = undefined
  patientContextSynced = false
  // 让「正在 await 的那次校准」作废（见 patientContextGeneration 的说明）
  patientContextGeneration++
})

// 多人版登录守卫：云端模式下未登录跳转登录页；本地模式（未配置 Supabase）不受影响
router.beforeEach(async (to) => {
  const { initialized, isLoggedIn, init, user } = useAuth()
  if (!initialized.value) await init()
  if (!isCloudConfigured) return true
  if (to.path === '/login') {
    // 回到登录页（主动登出 / 被踢下线）＝ 病人上下文作废，下次登录必须重新校准。
    // ⚠️ 这里与下面那处都要 `patientContextGeneration++`：它们同样是「作废上下文」的语义，
    // 不参与代次的话，正在 await 的那次校准恢复后仍会把旧上下文写回（评审 A2 指出的语义不一致）。
    if (!isLoggedIn.value) {
      patientContextUid = undefined
      patientContextSynced = false
      patientContextGeneration++
    }
    return isLoggedIn.value ? '/' : true
  }
  if (!isLoggedIn.value) {
    patientContextUid = undefined
    patientContextSynced = false
    patientContextGeneration++
    return '/login'
  }
  // 恢复上次选中的病人，并校准到当前账号可访问的病人（首次登录/换账号/重新登录/被移出成员）。
  // 两步都加了超时：这里的 await 直接决定首屏能不能出来，不能让网络把导航挂死。
  const uid = user.value?.id ?? null
  if (needsPatientContext(uid)) {
    const generation = patientContextGeneration
    await withTimeout(restorePatientId(), RESTORE_PATIENT_TIMEOUT_MS, undefined)
    // `ensureCloudPatient()` 现在自己返回「是否真的校准成功」（读失败 → false），
    // 所以这里不再需要 `.then(() => true)`：false 与「超时兜底」都会让 synced 为假，
    // 下次导航会重试。两者必须能区分于「真的没有病人」（那时它返回 true）。
    const synced = await withTimeout(ensureCloudPatient(), SYNC_PATIENT_TIMEOUT_MS, false)
    // ⚠️ 只有「还是同一代」才写回：这中间可能已经登出（或被踢下线），
    // 那时 onLoggedOut 刚清空上下文，无条件写回等于又填回去 —— 见 patientContextGeneration
    if (generation === patientContextGeneration) {
      patientContextUid = uid
      patientContextSynced = synced
    }
  }
  return true
})

export default router

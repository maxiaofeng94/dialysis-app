<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { showToast, showConfirmDialog, showDialog } from 'vant'
import { useRouter } from 'vue-router'
import { useAuth } from '../stores/auth'
import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { repository } from '../repo'
import { cacheDelete } from '../lib/cloudCache'
import {
  errorCode,
  isConflictError,
  isNotFoundError,
  isPermissionError,
  isMissingColumnError,
  isRlsDeniedError,
  isSchemaMissingError,
  isSessionExpiredError,
} from '../lib/errors'
import { DEFAULT_RINSE_BACK_ML } from '../constants'
import {
  currentPatientId,
  setCurrentPatientId,
  currentRole,
  refreshCurrentRole,
  ensureCloudPatient,
} from '../stores/patient'
import { listMyPatients, createPatient, getMyProfile, updateMyName } from '../lib/cloudAdmin'
import { migrateLocalToCloud } from '../lib/migrate'
import { todayStr, parseNum, fmt, formatDateCN, calcAge, formatDateTimeCN } from '../utils/format'
import { getEffectiveDryWeight } from '../utils/calc'
import { uuid } from '../utils/id'
import type { Patient, DryWeight, PatientChangeLog } from '../types'

const patient = ref<Patient | null>(null)
const dryWeights = ref<DryWeight[]>([])
const router = useRouter()
const { user, isLoggedIn, logout } = useAuth()

/** 各操作的进行中状态：按钮 loading/disabled 用，防止连点造成重复写入（新建/迁移各建一个病人） */
const savingPatient = ref(false)
const savingDw = ref(false)
/** 删除干体重在途（含「确认框开着」那段窗口）。与 `savingDw` 分开，见 `removeDw` 注释 */
const deletingDw = ref(false)
/** 导入备份在途（含「确认框开着」那段窗口）。整库替换必须防连点，见 `onImportFile` */
const importing = ref(false)
const savingName = ref(false)
const creatingPatient = ref(false)
const migrating = ref(false)
const exporting = ref(false)

/**
 * 能不能改「病人配置」（档案 / 干体重）：
 * 数据库里 patients_update 与 dw_insert/update/delete 都是 owner-only，
 * caregiver / doctor / viewer 点下去只会「假成功」（RLS 静默 0 行），
 * 更糟的是假值会被写进本机缓存，随后被「快速创建」快照进新记录（轮椅重量/回水量永久偏差）。
 * 角色未知（本地单机模式、还没拉到）时不限制 —— 与服务端「拦得住」的事实一致。
 */
const canEditConfig = computed(() => currentRole.value === null || currentRole.value === 'owner')

/** 错误对象 → 用户看得懂的文案（保留仓储/服务端抛出的真实原因，不要一律说成「格式不正确」） */
function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : (err as { message?: unknown } | null)?.message
  return typeof msg === 'string' && msg.trim() ? msg.trim() : '请检查网络后重试'
}

// 被踢下线 / 令牌失效：repository 会切回本地仓储，页面变得「查无数据」，必须明确提示并引导回登录页
// （主动点「退出登录」时不算失效，用 loggingOut 跳过这段提示）
let loggingOut = false
watch(isLoggedIn, (val, old) => {
  if (old && !val && !loggingOut) {
    showToast('登录状态已失效，请重新登录')
    void router.replace('/login')
  }
})

async function onLogout() {
  try {
    await showConfirmDialog({
      title: '退出登录',
      message: '退出后将清除本机缓存的云端数据，需要重新登录才能查看记录。确认退出？',
    })
  } catch {
    return // 用户取消
  }
  loggingOut = true
  await logout()
  router.replace('/login')
}

async function saveMyName() {
  if (savingName.value) return // 防连点
  savingName.value = true
  try {
    const res = await updateMyName(myName.value.trim())
    showToast(res.ok ? '已保存' : res.error ?? '保存失败')
  } catch (err) {
    console.error(err)
    showToast(`保存失败：${errorText(err)}`)
  } finally {
    savingName.value = false
  }
}

const form = reactive({
  name: '',
  birthday: '',
  wheelchairWeight: '',
  rinseBackVolume: '',
})

const dwForm = reactive({ value: '', effectiveDate: '', note: '' })
const showDwForm = ref(false)
const fileInput = ref<HTMLInputElement>()

const myPatients = ref<{ patient: Patient; role: string }[]>([])
const myName = ref('')
const myPhone = ref('')
const showNewPatient = ref(false)
const newPatientForm = reactive({ name: '', wheelchairWeight: '', rinseBackVolume: '' })

/** 首次加载（本机还没有缓存）时的骨架占位 */
const loading = ref(true)
/**
 * 「档案正在重新加载」的**计数器**（不控制骨架屏、**也不控制 UI 灰化**）。
 *
 * ⚠️ 不能复用 `loading`：它的语义是「首屏还没好」，只在首次加载时为 true。
 * 若让 `load()` 每次都把它置 true，迁移后刷新、干体重保存后重载都会闪一下整页骨架，
 * 用户正在看的表单被替换成占位块（实测会打挂「迁移：连点只迁移一次」）。
 * 但 `switchPatient` 又确实需要知道「有加载在途」—— 否则甲的档案会落到乙的上下文。
 *
 * ⚠️ 为什么是**计数器**而不是布尔（第五轮测试评审坐实）：这个标记有**两个所有者** ——
 * `switchPatient`（覆盖 setCurrentPatientId + refreshCurrentRole + load 整段）与
 * `load()`（自己被 6 处调用）。用布尔时，`load()` 的 `finally` 会**无条件清掉**
 * `switchPatient` 持有的标记：`removeDw()` / `saveDw()` 都是 `await load()`，
 * 干体重请求在途时切病人 → 干体重那次 load 用**新 pid** 跑完并清标记 →
 * `switchPatient` 的守卫失效 → 点保存写出「乙的 id + 甲的姓名生日」，且
 * `updatedAtIso: null` 绕过乐观锁（探针实测已复现，见 SettingsView.spec.ts 对应用例）。
 * 计数器让每个持有者只管自己那一份，谁都不会清掉别人的。
 *
 * ⚠️ 中级-1（第四轮独立评审）：**只有「切换病人」这一条链才锁 UI**。
 * 干体重保存/删除触发的 `load()` 也会持有本计数器，如果拿它去灰化病人列表、
 * 禁用保存按钮，那么每次正常存一条干体重都会让整块列表变灰点不动
 * （`resilientFetch` 最坏 3×15s + 退避 ≈ 46s 无任何加载指示），用户以为 App 卡死。
 * 而 `load()` 保护用户输入靠的是 `formSnapshot` 比对，本来就不需要锁 UI。
 * 所以 UI 灰化只看 `switchingPatient`，本计数器只给「拒绝保存/切换」的守卫用。
 */
const reloadingCount = ref(0)
const reloading = computed(() => reloadingCount.value > 0)
/** 只有它控制 UI 灰化（见上面 `reloadingCount` 的注释） */
const switchingPatient = ref(false)
/** 取一份「加载在途」持有权；返回释放函数（必须放在 finally 里调用） */
function beginReloading(): () => void {
  reloadingCount.value += 1
  let released = false
  return () => {
    if (released) return // 幂等：重复释放不能让计数变负
    released = true
    reloadingCount.value = Math.max(0, reloadingCount.value - 1)
  }
}
/** 加载失败：骨架必须收起并给出「重试」，否则用户只能杀进程（与首页/详情页保持一致） */
const loadError = ref('')
/** 当前版本：装机后想确认「装的是哪一版」时，不用再翻系统设置 */
const appVersion = ref('')
/**
 * 「我的病人」列表加载失败。
 * 失败时**绝不能**落到「暂无病人，点『＋ 新建』创建」—— 用户云端明明有病人，
 * 会照着提示建出重复档案（App 内删不掉，只能上后台/跑 SQL）。
 */
const patientsError = ref('')

async function loadAppVersion() {
  if (!Capacitor.isNativePlatform()) {
    // 网页端跟着部署走（SW 换新后会自动重载），没有「装在手机上的哪一版」这个概念
    appVersion.value = '网页版 · 自动更新'
    return
  }
  try {
    const info = await App.getInfo()
    appVersion.value = `版本 ${info.version}（build ${info.build}）`
  } catch {
    // 拿不到就不显示 —— 不值得为了一个版本号打扰用户
    appVersion.value = ''
  }
}

onMounted(async () => {
  void loadAppVersion()
  await load()
  if (!isLoggedIn.value) return
  // 下面几项是锦上添花（我的病人 / 角色 / 我的账号）：拉不到不该挡住页面主体，
  // 也不能让异常逃出去变成 unhandled rejection —— 更不能影响已经渲染出来的档案表单。
  try {
    myPatients.value = await listMyPatients()
    patientsError.value = ''
    // 角色决定「病人配置」能不能改（非 owner 的写入会被数据库静默拒绝）
    await refreshCurrentRole()
    const profile = await getMyProfile()
    myName.value = profile?.name ?? ''
    myPhone.value = profile?.phone ?? ''
  } catch (err) {
    console.error(err)
    // 与「确实没有病人」分开：否则会显示「暂无病人，点新建」诱导用户建重复档案
    patientsError.value = '病人列表加载失败，请检查网络后重试'
  }
})

/** 「我的病人」加载失败后的重试（沿用列表本身，不额外造请求） */
async function retryPatients(): Promise<void> {
  patientsError.value = ''
  try {
    myPatients.value = await listMyPatients()
  } catch (err) {
    console.error(err)
    patientsError.value = '病人列表加载失败，请检查网络后重试'
  }
}

/**
 * 重新拉取「我的病人」列表（M2）：
 * cloudAdmin.listMyPatients 命中本机缓存就直接返回旧列表 —— 新建/迁移出来的病人不会出现、
 * ✓ 也不会高亮。这里先按 uid 删掉缓存 key 再请求（等价于强制刷新），不需要给数据层加 force 参数。
 */
async function reloadMyPatients(): Promise<void> {
  const uid = user.value?.id
  if (uid) await cacheDelete(`myPatients:${uid}`)
  myPatients.value = await listMyPatients()
}

/** 兜底：迁移接口没给新病人 id 时，从刷新后的列表里取「新出现的那个」 */
function pickAddedPatientId(beforeIds: Set<string>): string | null {
  return myPatients.value.find((item) => !beforeIds.has(item.patient.id))?.patient.id ?? null
}

/**
 * 切换当前病人。
 *
 * ⚠️ 严重-1（第三轮独立评审）：必须挡住「保存 / 加载在途」时的切换。
 *
 * 否则可达路径：改甲的重量 → 点保存（弱网挂住）→ 点乙那一行 → 甲的保存返回 →
 * `patient.value`/`knownPatientUpdatedAtIso` 被回写成甲 → 用户点保存 = 乙的 id +
 * 甲的版本号与生日 → 假冲突 → 点「覆盖保存」→ **甲的姓名生日被永久写进乙的服务器档案**。
 * 这是「病人身份」级别的数据污染，任何页面都不会提示。
 *
 * 保存通常只等几百毫秒，等一下比写错病人档案好得多。
 *
 * ⚠️ 第四轮自查（取证用例坐实）：`setCurrentPatientId(id)` 原来在 `await refreshCurrentRole()`
 * **之前**执行，而 `reloading` 要到 `load(true)` 才置 true。这段窗口（弱网下 1~15 秒）里：
 * 当前病人 id 已是乙、表单还是甲的、保存按钮可点 → 点保存就写出
 * `{ id: 'patient-b', name: '甲', birthday: …, updatedAtIso: null }`，
 * **甲的姓名生日被直接覆盖进乙的档案**（`updatedAtIso: null` 还绕过了乐观锁）。
 * 所以整个切换流程都要持有 `reloading`，并且 `savePatient` 也要拒绝在途加载时保存。
 */
async function switchPatient(id: string) {
  // ⚠️ 轻微-1（第四轮独立评审）：同 id 早退必须排在守卫**之前**。
  // 否则用户在保存/加载在途时点了**自己那一行**，会被告知「正在保存档案，请稍候再切换病人」——
  // 但用户根本没在切换（点的是当前病人），文案误导。
  if (id === currentPatientId.value) return // 重复点同一行：没必要重新加载
  if (savingPatient.value) {
    showToast('正在保存档案，请稍候再切换病人')
    return
  }
  if (reloading.value) {
    showToast('正在加载病人档案，请稍候再切换')
    return
  }
  // ⚠️ 必须在 `setCurrentPatientId` **之前**取持有权，覆盖 `refreshCurrentRole()` 这段网络等待。
  // 用 `beginReloading()` 而不是直接置 true：`load()` 也会持有同一个计数器，
  // 布尔方案下 `load()` 的 finally 会把这里的持有权提前清掉（第五轮评审坐实）。
  const release = beginReloading()
  // 只有「切换病人」这条链锁 UI（中级-1：干体重重载不该让列表变灰）
  switchingPatient.value = true
  try {
    setCurrentPatientId(id)
    try {
      await refreshCurrentRole()
    } catch (err) {
      // 角色刷新失败不该阻断切换（病人已经切了），但也**不能把异常抛给模板 @click** ——
      // 那会变成未捕获的 Vue 错误、用户什么提示都看不到。按「权限未知」继续：
      // ⚠️ 注意 `canEditConfig` 对 `currentRole === null` 是**放行**的（见其定义处注释：
      // 纯本地单机模式没有角色概念，必须能编辑），所以这里只是提示，不阻断操作。
      // （第六轮独立评审轻微-2：原注释写反成「保守的不可编辑」，会误导后人把单机模式锁死。）
      console.error(err)
      showToast('已切换病人，但权限刷新失败，部分操作可能暂时不可用')
    }
    showToast('已切换病人')
    await load(true) // 换病人：无条件用新档案回填表单
  } finally {
    // `refreshCurrentRole()` 抛错时这里是**唯一**出口 —— 漏了就让 reloading 永久 > 0，
    // 用户再也切不了病人（第五轮评审坐实的新死锁）。
    release()
    switchingPatient.value = false
  }
}

function openNewPatient() {
  newPatientForm.name = ''
  newPatientForm.wheelchairWeight = ''
  newPatientForm.rinseBackVolume = ''
  showNewPatient.value = true
}

async function onCreatePatient() {
  if (creatingPatient.value) return // 连点保护：每次点击都会真的建一个病人
  if (!newPatientForm.name.trim()) {
    showToast('请填写姓名')
    return
  }
  const wheelchairWeight = parseNum(newPatientForm.wheelchairWeight) ?? 0
  const rinseBackVolume = parseNum(newPatientForm.rinseBackVolume) ?? DEFAULT_RINSE_BACK_ML
  const bad =
    rangeError('轮椅及衣物重量', wheelchairWeight, 0, WHEELCHAIR_MAX) ??
    rangeError('回水量', rinseBackVolume, 0, RINSE_BACK_MAX)
  if (bad) {
    showToast(bad)
    return
  }
  creatingPatient.value = true
  try {
    const res = await createPatient(newPatientForm.name.trim(), wheelchairWeight, rinseBackVolume)
    if (!res.ok || !res.data?.patient) {
      showToast(res.data?.error ?? '创建失败')
      return
    }
    // 到这里病人已经在云端建出来了：后面任何一步失败都不能提示「创建失败」，
    // 否则用户会再点一次，造出 App 内删不掉的重复病人。
    setCurrentPatientId(res.data.patient.id)
    showNewPatient.value = false
    // ⚠️ 第五轮测试评审坐实：这里原来**不持有** reloading —— 而 `setCurrentPatientId`
    // 已把当前病人换成新建的丙，表单却还是甲的内容。列表刷新 + 角色刷新 + load 在弱网下
    // 要 1~15 秒，这期间点保存就写出「丙的 id + 甲的姓名生日」，`updatedAtIso: null`
    // 绕过乐观锁。新建病人是低频但必然发生的操作，且用户刚填完姓名，点保存很自然。
    const release = beginReloading()
    try {
      await reloadMyPatients() // 强制重拉：否则命中旧缓存，新病人不在列表里（M2）
      await refreshCurrentRole()
      await load(true)
      showToast('已创建')
    } catch (err) {
      console.error(err)
      showToast('病人已创建，但列表刷新失败，请检查网络后重试')
    } finally {
      release()
    }
  } catch (err) {
    console.error(err)
    showToast(`创建失败：${errorText(err)}`)
  } finally {
    creatingPatient.value = false
  }
}

async function onMigrate() {
  if (migrating.value) return // 连点/重复提交保护：migrate 每次都会在云端新建一个病人
  migrating.value = true
  try {
    try {
      await showConfirmDialog({
        title: '迁移数据',
        message:
          '将把本机全部数据上传到云端，并在云端新建一个病人。此操作不可撤销，重复执行会生成重复病人，确认继续？',
      })
    } catch {
      return // 用户取消
    }
    const beforeIds = new Set(myPatients.value.map((item) => item.patient.id))
    const res = await migrateLocalToCloud()
    if (!res.ok) {
      showToast(res.message || '迁移失败')
      return
    }
    // 迁移已经成功（云端已新建病人）：后续刷新失败也不能说「迁移失败」，
    // 否则用户会再跑一次，云端就多一个重复病人。
    const name = patient.value?.name ?? '新病人'
    // migrateLocalToCloud 的 message 形如「已迁移 N 条透析记录到云端」
    showToast(`已在云端新建病人「${name}」，${res.message}`)
    try {
      // ⚠️ 与 onCreatePatient 同理（第五轮测试评审坐实）：这段里 `setCurrentPatientId(newId)`
      // 会把当前病人换掉，而表单还是迁移前那位的内容，弱网下有几秒窗口。
      const release = beginReloading()
      try {
        await reloadMyPatients()
        // 优先用迁移接口返回的新病人 id；老版本/异常情况下退回「列表里新出现的那个」
        const newId = res.patientId ?? pickAddedPatientId(beforeIds)
        if (newId) setCurrentPatientId(newId)
        else await ensureCloudPatient() // 列表没变化时退回按列表校准
        await refreshCurrentRole()
        await load(true)
      } finally {
        release()
      }
    } catch (err) {
      console.error(err)
      showToast('迁移已完成，但列表刷新失败，请检查网络后重试')
    }
  } catch (err) {
    console.error(err)
    showToast(`迁移失败：${errorText(err)}`)
  } finally {
    migrating.value = false
  }
}

function goMembers() {
  router.push('/members')
}

/**
 * 表单「干净」快照（M3）：保存干体重、删除干体重等操作都会触发 load()，
 * 若无条件回填，用户正在填的档案会被后台数据覆盖掉。记录一份初始快照做比对，
 * 只在「表单没被改过」时才回填；force = 用户主动换病人/整份导入后无条件回填。
 */
let formSnapshot: string | null = null
/**
 * **乐观锁版本号**：本页面读到的病人档案版本（云端原始 `updated_at`）。
 * 两人同时改档案（轮椅重量 / 回水量）时，后保存的人不该静默抹掉对方的改动。
 */
let knownPatientUpdatedAtIso: string | null = null

function snapshotForm(): string {
  return JSON.stringify([form.name, form.birthday, form.wheelchairWeight, form.rinseBackVolume])
}

function fillForm(p: Patient | null) {
  form.name = p?.name ?? ''
  form.birthday = p?.birthday ?? ''
  form.wheelchairWeight = p ? String(p.wheelchairWeight) : ''
  form.rinseBackVolume = p ? String(p.rinseBackVolume) : ''
  formSnapshot = snapshotForm()
}

async function load(force = false, opts: { fresh?: boolean } = {}) {
  loadError.value = ''
  // ⚠️ 第四轮自查：`loading` 只在 `finally` 里置 false、**从不重新置 true** ——
  // 于是 `switchPatient` 的 `if (loading.value)` 守卫在首屏之后永远不成立（死代码）。
  // 这里用独立的计数器（不动骨架屏，见其定义处的注释）。
  const release = beginReloading()
  try {
    const pid = currentPatientId.value
    const [p, dw] = await Promise.all([repository.getPatient(pid, opts), repository.listDryWeights(pid)])
    // ⚠️ 严重-1（第三轮独立评审）：`await` 之后必须复查「当前病人还是不是发起时那位」。
    // 不复查就会把甲的档案写进 `patient.value`，而表单里是乙的内容 → 用户点保存 =
    // 用乙的 id + 甲的版本号/生日/体重，触发假冲突、再点「覆盖保存」就把甲的
    // 姓名生日永久写进乙的服务器档案。
    if (currentPatientId.value !== pid) return
    patient.value = p ?? null
    knownPatientUpdatedAtIso = p?.updatedAtIso ?? null
    if (force || formSnapshot === null || snapshotForm() === formSnapshot) {
      fillForm(p ?? null)
    }
    dryWeights.value = dw
  } catch (err) {
    console.error(err)
    // 原来这里没有 catch，`loading` 只在成功路径置 false —— 本机还没有缓存时
    // 一旦首次加载失败（弱网、令牌失效），设置页就永久停在骨架屏上，没有任何出口。
    loadError.value = '加载失败，请检查网络后重试'
  } finally {
    // 无论成败都要收起骨架（首页/详情页/趋势页/报告页都是这么做的）
    loading.value = false
    // ⚠️ 只释放**自己**这一份持有权，不能把 `switchPatient` 那份一起清掉
    // （第五轮评审坐实：`removeDw`/`saveDw` 的 `await load()` 会提前清掉守卫）。
    release()
  }
}

const currentDry = computed(() => getEffectiveDryWeight(dryWeights.value, todayStr()))

function calcAgeStr(birthday: string): string {
  const a = calcAge(birthday)
  return a == null ? '—' : `${a} 岁`
}

function roleLabel(role: string): string {
  const map: Record<string, string> = { owner: '创建者', caregiver: '家属/护工', doctor: '医生', viewer: '只读' }
  return map[role] ?? role
}

/**
 * 量程阈值：与 HomeView / SessionView 的 checkRange 同一口径。
 * 只判「是不是数字」是不够的 —— 轮椅重量填 -5 会原样入库，首页算出的「实际体重」跟着偏大；
 * 回水量填 99999 会让机器脱水量离谱。
 * （三处常量目前各存一份，后续可抽到 src/utils/validate.ts 共用。）
 */
const WEIGHT_MIN = 20
const WEIGHT_MAX = 200
const WHEELCHAIR_MAX = 100
const RINSE_BACK_MAX = 2000

function rangeError(label: string, value: number, min: number, max: number): string | null {
  if (!Number.isFinite(value)) return `${label}不是有效数字`
  if (value < min || value > max) return `${label}应在 ${min}~${max} 之间`
  return null
}

/**
 * 保存病人档案。
 *
 * `override` = true：用户已经明确选了「覆盖保存」，这次**不带版本条件**写入。
 * ⚠️ 别改成「先取回最新版本号再带条件重试」—— `getPatient` 是缓存优先的，
 * 拿回来的往往还是旧版本，于是又冲突一次、再弹一次窗，用户点了覆盖却什么也没写进去。
 */
async function savePatient(opts: { override?: boolean; expectPatientId?: string } = {}) {
  // 非 owner 的保存会被数据库 RLS 静默拦成 0 行，绝不能提示「已保存」（假值还会污染本机缓存）
  if (!canEditConfig.value) {
    showToast('仅创建者可修改病人配置')
    return
  }
  if (savingPatient.value) return
  // ⚠️ 切换病人途中（`setCurrentPatientId(乙)` 已生效、乙的档案还没加载回来）时，
  // 表单还是甲的，此时点保存会写出「乙的 id + 甲的姓名生日」，且 `updatedAtIso: null`
  // 绕过乐观锁直接覆盖 —— 病人身份级污染。宁可让用户等一下再点。
  if (reloading.value) {
    showToast('正在加载病人档案，请稍候再保存')
    return
  }
  // ⚠️ 严重-4（第四轮独立评审）：冲突对话框里的「覆盖保存」重试必须确认
  // 「当前病人还是发起冲突那位」。切换本身是允许的（那时没有保存/加载在途），
  // 不确认就会对**另一个病人**做无条件整行 upsert。
  // 这里再兜一层（调用方 `resolvePatientConflict` 已复核过）：`p.id` 取自
  // `currentPatientId.value`，一旦 pid 变了，写进去的就是别人的档案。
  if (opts.expectPatientId && currentPatientId.value !== opts.expectPatientId) {
    showToast('你已切换到其他病人，这次修改已放弃')
    return
  }

  const wheelchairWeight = parseNum(form.wheelchairWeight) ?? 0
  const rinseBackVolume = parseNum(form.rinseBackVolume) ?? DEFAULT_RINSE_BACK_ML
  const bad =
    rangeError('轮椅及衣物重量', wheelchairWeight, 0, WHEELCHAIR_MAX) ??
    rangeError('回水量', rinseBackVolume, 0, RINSE_BACK_MAX)
  if (bad) {
    showToast(`${bad}（未保存）`)
    return
  }

  // 变更记录要用「保存前的档案值」做 oldValue，必须在覆盖 patient.value 之前取
  const prevWheelchair = patient.value?.wheelchairWeight ?? 0
  const wheelchairChanged = Math.abs(prevWheelchair - wheelchairWeight) > 1e-9

  const now = Date.now()
  const p: Patient = {
    id: currentPatientId.value,
    name: form.name.trim() || '未命名',
    birthday: form.birthday,
    wheelchairWeight,
    rinseBackVolume,
    createdAt: patient.value?.createdAt ?? now,
    updatedAt: now,
    updatedAtIso: knownPatientUpdatedAtIso,
  }
  savingPatient.value = true
  try {
    const iso = await repository.savePatient(p, opts.override ? null : knownPatientUpdatedAtIso)
    // ⚠️ 严重-1（第三轮独立评审）：`knownPatientUpdatedAtIso` / `patient.value` / `formSnapshot`
    // 都是**当前页面的状态**，只有在「当前病人仍是发起保存那位」时才能回写。
    // 保存期间切病人是真实可达的（`switchPatient` 原来不挡在途保存），
    // 不回写判断的后果：甲的值 + 乙的 id 组成下一次保存的 payload → 假冲突 →
    // 用户点「覆盖保存」→ 甲的姓名/生日/体重被永久写进乙的服务器档案。
    //
    // ⚠️ `iso` 可能为空（本地模式 / 仓储没返回新版本号）：那时**仍要**回写
    // `patient.value` 与 `formSnapshot`，否则下一次保存会把这次改动当成「又改了」
    // 重复写一条变更记录。
    if (currentPatientId.value === p.id) {
      if (iso) {
        p.updatedAtIso = iso
        knownPatientUpdatedAtIso = iso
      }
      patient.value = p
      formSnapshot = snapshotForm() // 保存后表单就是「服务端值」，后续 load 可正常回填
    } else {
      // 已切到别的病人：这次保存结果只对原病人生效，不要污染当前页面的状态
      showToast('已保存（保存期间切换了病人，当前页面未更新）')
    }
    // 需求②：轮椅及衣物重量的变更留痕。
    // - 必须在档案保存**成功之后**写，否则会出现「日志说改了、实际没改」；
    // - 写失败**不影响**档案保存的结果（档案已经进库了），但必须明确告诉用户日志没记上 ——
    //   静默失败会让这份「变更记录」失去可信度，而它存在的意义就是让用户信得过。
    // - 评审 M2：写失败要把这次变更**暂存**下来，下次保存时自动补写。
    //   否则 `patient.value` 已被覆盖成新值，用户再点保存时 `wheelchairChanged` 为 false，
    //   这条变更就永久缺失了（而提示只说「请检查网络」，用户不知道该做什么）。
    if (wheelchairChanged) {
      // 先补上次没记上的（顺序才不会乱：老变更在前、新变更在后）
      //
      // ⚠️ 返回值**必须接住**（第四轮自查）：原来这里丢弃了 flush 的结果，
      // 于是「旧待补项没补上、本次这条写成功」时会 toast「已保存」——
      // 用户以为历史齐了，实际还缺一条。本次成功不等于历史完整。
      const flushedOk = await flushPendingWheelchairLog()
      // ⚠️ 用**发起保存时**捕获的 pid（`p.id`），不要在这里读 `currentPatientId.value`：
      // 上面 `await savePatient(...)` 期间用户可能已经切病人了（S-1）。
      const logged = await appendWheelchairLog(prevWheelchair, wheelchairWeight, p.id)
      if (!logged) {
        // 进队列（不是单槽覆盖）：连续两次失败时两条都要留着，且带上归属
        const queued = pushPendingWheelchairLog({
          patientId: p.id,
          oldValue: prevWheelchair,
          newValue: wheelchairWeight,
          // 变更发生时刻 = 这次保存的时间，不是将来补写的时刻（中级-6）
          changedAt: now,
        })
        // ⚠️ 队列也存不下时**绝不能**再说「下次保存时会自动补记」——
        // 那是空头承诺（独立评审 D2：隐私模式下队列静默丢失，第二次保存还报「已保存」，
        // 用户以为记录齐了，实际永久缺失）。必须如实告诉他这次变更记不上了。
        showToast(
          queued
            ? '已保存，但变更记录未能写入（下次保存时会自动补记）'
            : '已保存，但变更记录未能写入，且本机无法暂存待补项，这条变更记录将缺失',
        )
      } else if (!flushedOk) {
        // 本次这条写成功了，但**之前**的待补项仍未补上 → 历史仍不完整，不能说「已保存」
        showToast('已保存，但此前的变更记录仍未能写入（下次保存时会自动补记）')
      } else {
        showToast('已保存')
      }
    } else {
      // 本次没改重量，但可能有上次没记上的变更 → 顺手补写
      const flushed = await flushPendingWheelchairLog()
      showToast(flushed ? '已保存' : '已保存，但变更记录仍未能写入（下次保存时会自动补记）')
    }
  } catch (err) {
    console.error(err)
    if (isConflictError(err)) {
      // ⚠️ 必须先放开 in-flight 守卫再问用户：否则用户选「覆盖保存」时，
      // 那次重试会被 savingPatient 自己挡掉，点了覆盖什么也没发生
      savingPatient.value = false
      // 传发起冲突时的 pid：用户在对话框停留期间可能切走（严重-4）
      await resolvePatientConflict(p.id)
      return
    }
    if (isNotFoundError(err)) {
      showToast('这个病人档案已被删除')
      return
    }
    // 没有写权限（被 RLS 拦）：与「冲突」区分开 —— 弹「覆盖保存」也没用，点了照样被拒
    if (isPermissionError(err)) {
      showToast('你没有修改这个病人档案的权限，请联系创建者')
      return
    }
    showToast(`保存失败：${errorText(err)}`)
  } finally {
    savingPatient.value = false
  }
}

/**
 * 追加一条「轮椅及衣物重量」变更记录。
 *
 * @returns 是否写入成功。失败时**不抛错**（档案已经保存成功了，不能因为日志失败就
 *   把整次保存判成失败、让用户重试 —— 那会让他以为档案没存上，反复点击）。
 *   调用方据返回值给不同的提示。
 */
/**
 * 追加一条「轮椅及衣物重量」变更记录。
 *
 * ⚠️ `patientId` **必须由调用方显式传入**（发起保存时捕获的值），不能在这里读
 * `currentPatientId.value` —— 这个函数在 `await savePatient(...)` 之后才被调用，
 * 等待期间用户切病人是可能的（病人列表行没有 disabled 保护），此时读到的已经是新病人。
 * 后果：档案写对了人、变更记录写到别人名下 —— A 的历史永久缺一条真实改动，
 * B 的历史凭空多一条从未发生的改动，整份历史的可信度归零。
 *
 * @returns 是否写入成功。失败时**不抛错**（档案已经保存成功了，不能因为日志失败就
 *   把整次保存判成失败、让用户重试 —— 那会让他以为档案没存上，反复点击）。
 *   调用方据返回值给不同的提示。
 */
async function appendWheelchairLog(
  oldValue: number,
  newValue: number,
  patientId: string,
  changedAt: number = Date.now(),
): Promise<boolean> {
  const log: PatientChangeLog = {
    id: uuid(),
    patientId,
    field: 'wheelchairWeight',
    oldValue,
    newValue,
    // 变更人显示名：优先用本页已加载的「我的姓名」，没填就退回手机号；
    // 云端记录里 operator_id 由仓储填当前登录用户（RLS 强制 operator_id = auth.uid()）
    operator: myName.value.trim() || myPhone.value || null,
    // ⚠️ 中级-6（第三轮独立评审）：补写时必须传**变更发生时刻**，不能取 `Date.now()`。
    // 历史是按 `changedAt` 倒序排的；补写取「补写那一刻」会让 10:00 的变更排到 10:30 之后，
    // 用户看到的历史倒着长 —— 与 D1 是同一类问题，`break` 修不到（那是同一次 flush 内部）。
    changedAt,
  }
  try {
    await repository.addPatientChangeLog(log)
    // 写完让「变更历史」弹窗读到新数据：它是缓存优先的，不清就是旧列表。
    // key 用**归属病人**的 id（同上，不能读 currentPatientId）
    await cacheDelete(`patientChangeLogs:${patientId}`)
    return true
  } catch (err) {
    console.error(err)
    return false
  }
}

/**
 * 待补写的变更记录（评审 M2 / M-2）。
 *
 * 问题一：`savePatient` 里 `patient.value = p` 在 `appendWheelchairLog` **之前**执行。
 * 日志写失败后，`patient.value` 已经是新值 —— 用户再点一次保存时 `wheelchairChanged`
 * 为 false，**永远不会补写这条日志**。断网时改一次重量，这次变更就在历史里永久缺失。
 *
 * 问题二（独立评审 M-2）：**这个变量不是模块级的**。`<script setup>` 里的 `let`
 * 编译后落在 `setup()` 函数体内，是**组件实例级**变量 —— 而 `/settings` 没有
 * `keep-alive`（`App.vue` 是裸 `<router-view>`），离开页面即卸载、变量随之销毁。
 * 于是「提示说下次保存会补记 → 用户去别的页面看了看再回来 → 提示已保存 → 历史里仍然没有」
 * 这条路径会让用户被明确告知会补记却永远补不上。
 *
 * 问题三：单槽会覆盖。连续两次「改重量 + 日志失败」时，后一条把前一条整个顶掉。
 *
 * 修法：
 * 1. **持久化到 localStorage**，跨页面卸载存活；
 * 2. 用**数组**，多条待补项各自保留、按发生顺序补写；
 * 3. 每条带 `patientId`，只在**属于当前病人**时补写，不串号。
 *
 * 已知边界：待补项只存本机。换手机/清数据会丢 —— 这类「日志没记上」的补偿本来
 * 就是尽力而为，且失败时已经明确告知用户；真要强一致得让服务端在写档案时事务内写日志。
 */
const PENDING_LOG_KEY = 'dialysis-pending-wheelchair-logs'

interface PendingWheelchairLog {
  patientId: string
  oldValue: number
  newValue: number
  /**
   * 变更**发生**时刻（不是补写时刻）。
   *
   * ⚠️ 中级-6（第三轮独立评审）：历史按 `changedAt` 倒序排，补写时若取 `Date.now()`，
   * 10:00 的变更会排到 10:30 之后 —— 历史倒着长。D1 的 `break` 只管同一次 flush 内部，
   * 管不住「补写条目 vs 之后实时写入的条目」，所以必须把时刻一起存下来。
   *
   * 旧数据可能没有这个字段（升级前存下的队列）→ 读出时补成当前时间，行为与旧版一致。
   */
  changedAt: number
}

function readPendingWheelchairLogs(): PendingWheelchairLog[] {
  try {
    const raw = localStorage.getItem(PENDING_LOG_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // 逐条校验：宁可丢一条坏数据，也不能让整个补写流程抛错
    return parsed
      .filter(
        (x): x is PendingWheelchairLog =>
          !!x &&
          typeof x === 'object' &&
          typeof (x as PendingWheelchairLog).patientId === 'string' &&
          Number.isFinite((x as PendingWheelchairLog).oldValue) &&
          Number.isFinite((x as PendingWheelchairLog).newValue),
      )
      .map((x) => ({
        ...x,
        // 兼容升级前没有 changedAt 的旧队列：补成现在，至少不会变成 NaN 打乱排序
        changedAt: Number.isFinite(x.changedAt) ? x.changedAt : Date.now(),
      }))
  } catch {
    return []
  }
}

/**
 * 写待补队列。返回 **false 表示本机存不下**（隐私模式 / 配额满）。
 *
 * ⚠️ 返回值必须被调用方检查：`localStorage` 写不进去时队列会静默丢失，
 * 而 toast 里承诺了「下次保存时会自动补记」—— 不检查就等于**文案在撒谎**
 * （独立评审 D2 实测：隐私模式下第二次保存 toast 变成「已保存」，
 * 而承诺的补记一条都没发生，用户以为记录齐了，实际永久丢失）。
 */
function writePendingWheelchairLogs(items: PendingWheelchairLog[]): boolean {
  try {
    if (items.length === 0) localStorage.removeItem(PENDING_LOG_KEY)
    else localStorage.setItem(PENDING_LOG_KEY, JSON.stringify(items))
    return true
  } catch {
    // 隐私模式/配额满：存不下就只能当次会话内有效，不阻断保存流程
    return false
  }
}

/** 记一条待补项（失败时调用）。返回 false 表示本机存不下（隐私模式/配额满） */
function pushPendingWheelchairLog(item: PendingWheelchairLog): boolean {
  const items = readPendingWheelchairLogs()
  items.push(item)
  return writePendingWheelchairLogs(items)
}

/**
 * 补写所有**属于当前病人**的待补项（按发生顺序）。返回 true 表示没有待补项或全部补写成功。
 *
 * 别的病人的待补项原样保留（等用户切回去再补），不报错、不提示 —— 用户没做错什么。
 *
 * ⚠️ 遇到第一条失败就 **break**，不能 `continue` 去试后面的（独立评审 D1）：
 * 队列里第 1 条失败、第 2 条恰好成功时，第 2 条会先落库，变更历史变成
 * 「13.5→13.6，13.4→13.5」——**倒着长**。而历史顺序正是「这份记录可信」的核心，
 * 倒置比缺失更误导。所以：失败即停，把这一条和**它后面所有还没试的**按原顺序放回队列。
 */
async function flushPendingWheelchairLog(): Promise<boolean> {
  const all = readPendingWheelchairLogs()
  if (all.length === 0) return true
  const mine = all.filter((x) => x.patientId === currentPatientId.value)
  if (mine.length === 0) return true

  // 别的病人的原样保留；本病人的先全部摘掉，成功的就不再放回
  const remaining: PendingWheelchairLog[] = all.filter((x) => x.patientId !== currentPatientId.value)
  let allOk = true
  let stoppedAt = -1
  for (let i = 0; i < mine.length; i++) {
    // 传**变更发生时刻**（不是补写时刻），否则历史会按补写顺序倒排（中级-6）
    const ok = await appendWheelchairLog(
      mine[i].oldValue,
      mine[i].newValue,
      mine[i].patientId,
      mine[i].changedAt,
    )
    if (!ok) {
      // 这一条没补上：网络多半还没恢复，后面的也别试了（否则历史会倒序）
      allOk = false
      stoppedAt = i
      break
    }
  }
  // 失败的那条 + 它之后没来得及试的，按原顺序放回队列
  if (stoppedAt >= 0) remaining.push(...mine.slice(stoppedAt))
  // ⚠️ 中级-5（第三轮独立评审）：写回结果**必须检查**。
  // `setItem` 失败时队列没清掉（成功补写的那几条还在磁盘上），下次 flush 会**再写一遍** ——
  // 变更历史里出现两条一模一样的记录，而 toast 说「已保存」，用户无法判断哪条是真的。
  // 这正是 D2 想消灭的「文案撒谎」，只是换了个分支。
  if (!writePendingWheelchairLogs(remaining)) return false
  return allOk
}

// ---------- 轮椅及衣物重量变更历史（需求②） ----------

const showChangeLog = ref(false)
const changeLogs = ref<PatientChangeLog[]>([])
const changeLogLoading = ref(false)
const changeLogError = ref('')

/** 打开变更历史：每次打开都强制读最新（`fresh`），否则刚改完看不到这一条 */
async function openChangeLog() {
  showChangeLog.value = true
  changeLogLoading.value = true
  changeLogError.value = ''
  // ⚠️ 中级-2（第四轮独立评审）：`await` 之后必须复查「当前病人还是不是发起时那位」。
  // 不复查的后果：点「变更历史」（甲的）→ 弱网请求在途 → 切到乙 → 请求返回 →
  // 弹窗里显示的是**甲的体重变更历史**，用户会据此判断「乙的轮椅重量被改过」。
  // 与 `load()` 的 pid 复查是同一个模式。
  const pid = currentPatientId.value
  try {
    const list = await repository.listPatientChangeLogs(pid, { fresh: true })
    if (currentPatientId.value !== pid) {
      // 已切走：这份记录不属于当前病人，丢弃。
      // ⚠️ 必须**同时关掉弹窗**：只 `return` 的话，弹窗还开着、里面是甲的记录，
      // 用户会以为那是乙的（正是中级-2 要防的串数据，只是从「请求返回前」挪到了「返回后」）。
      showChangeLog.value = false
      return
    }
    changeLogs.value = list
  } catch (err) {
    console.error(err)
    if (currentPatientId.value !== pid) {
      showChangeLog.value = false // 同上：别把错误提示落到别人页面上
      return
    }
    // 读失败绝不能显示成「暂无变更记录」：那会让用户以为从没改过，反而更不信这份数据。
    //
    // ⚠️ 第十一轮（用户截图反馈「没有记录却提示加载失败」）：
    // 根因是**生产库没执行 schema.sql**（patient_change_logs 表不存在，实测 404 PGRST205），
    // 而这里把所有异常都归一成「请检查网络后重试」—— 用户换网络、点重试一万次也不会好，
    // 排查的人也只会往网络方向查。所以按错误码分开说，仍然不显示成「暂无记录」。
    // 轻微-2（第十二轮独立评审）：缺表（PGRST205/42P01）与缺列（42703）文案要分开 ——
    // 缺列时说「缺少数据库表」会把排查方向引偏（这次事故里两者都出现过）。
    // 轻微-3：PGRST301 是登录态失效，不能提示「找创建者要权限」（实际重登即可）。
    changeLogError.value = isMissingColumnError(err)
      ? '变更记录功能尚未在服务器启用，请联系管理员（缺少数据库列）'
      : isSchemaMissingError(err)
        ? '变更记录功能尚未在服务器启用，请联系管理员（缺少数据库表）'
        : isSessionExpiredError(err)
          ? '登录状态已失效，请重新登录后再试'
          : isRlsDeniedError(err)
            ? '没有权限查看变更记录，请联系创建者'
            : '变更记录加载失败，请检查网络后重试'
    if (import.meta.env.DEV) {
      // 开发/测试环境把错误码打出来，避免下次又靠猜
      console.warn('[changeLog] 加载失败，错误码 =', errorCode(err))
    }
    changeLogs.value = []
  } finally {
    // ⚠️ 中级-1（第五轮独立评审坐实）：这里原来写成 `if (currentPatientId.value === pid)`，
    // 于是「请求在途时切了病人」这条路径上 loading **永远停在 true** ——
    // 弹窗一直转圈、没有重试、也没有失败提示，用户以为记录读不出来（实测 DOM 里
    // 「加载中」常驻、「暂无变更记录」永不出现）。复位必须无条件。
    changeLogLoading.value = false
  }
}

function changeLogText(log: PatientChangeLog): string {
  const fmtVal = (v: number | null) => (v == null ? '—' : `${fmt(v)}kg`)
  return `${fmtVal(log.oldValue)} → ${fmtVal(log.newValue)}`
}

/** 档案版本冲突：编辑期间别人也保存过 —— 让用户选「重新加载」还是「覆盖保存」 */
async function resolvePatientConflict(conflictPatientId: string): Promise<void> {
  try {
    await showConfirmDialog({
      title: '病人档案已被其他人修改',
      message:
        '你编辑期间，另一位家属也改了这份档案。\n\n「重新加载」：放弃你刚才的修改，看对方保存的内容。\n「覆盖保存」：用你屏幕上的内容盖掉对方的。',
      confirmButtonText: '重新加载',
      cancelButtonText: '覆盖保存',
      messageAlign: 'left',
    })
    // ⚠️ 严重-4（第四轮独立评审）：用户在对话框停留期间可能切了病人。
    // 切换本身是允许的（此时没有保存/加载在途，守卫放行），于是「覆盖保存」会变成
    // 对**另一个病人**的无条件整行 upsert：甲刚改的轮椅重量静默丢失、乙的档案被平白覆盖一次，
    // 而用户以为自己在覆盖甲的。所以两边都要复核 pid，不一致就不动手。
    if (currentPatientId.value !== conflictPatientId) {
      showToast('你已切换到其他病人，这次修改已放弃')
      return
    }
    // 必须绕过缓存：缓存里是冲突前那份档案，照常读会让用户以为对方没改过
    await load(true, { fresh: true })
  } catch {
    // 同上：`showConfirmDialog` 被 reject 只代表用户点了「覆盖保存」，不代表 pid 没变
    if (currentPatientId.value !== conflictPatientId) {
      showToast('你已切换到其他病人，这次修改已放弃')
      return
    }
    await savePatient({ override: true, expectPatientId: conflictPatientId })
  }
}

function openDw() {
  // ⚠️ 中级-2（第五轮独立评审坐实）：切换病人途中不能开「新增干体重」。
  // 否则用户点完「＋ 新增」、填好、提交时 `saveDw` 会用自己的 `currentPatientId.value`
  // 拼记录 —— 那时已经切到乙了，于是**干体重挂到乙名下**，而页面显示的还是甲的列表。
  // 干体重直接决定脱水量，写错病人等于改错治疗方案。
  if (reloading.value) {
    showToast('正在加载病人档案，请稍候再操作')
    return
  }
  dwForm.value = ''
  dwForm.effectiveDate = todayStr()
  dwForm.note = ''
  showDwForm.value = true
}

async function saveDw() {
  if (!canEditConfig.value) {
    showToast('仅创建者可修改病人配置')
    return
  }
  const v = parseNum(dwForm.value)
  if (v == null) {
    showToast('请填写干体重')
    return
  }
  const bad = rangeError('干体重', v, WEIGHT_MIN, WEIGHT_MAX)
  if (bad) {
    showToast(`${bad}（未添加）`)
    return
  }
  if (savingDw.value) return
  // ⚠️ 中级-2（第五轮独立评审）：这里原来只守 `savingDw`，不守 `reloading`。
  // 切换病人途中（`switchPatient` 的 `load()` 挂在弱网）点保存 →
  // `patientId` 取的是**已经切换后**的新 pid，记录挂到新病人名下。
  if (reloading.value) {
    showToast('正在加载病人档案，请稍候再保存')
    return
  }
  const d: DryWeight = {
    id: uuid(),
    patientId: currentPatientId.value,
    value: v,
    effectiveDate: dwForm.effectiveDate || todayStr(),
    note: dwForm.note.trim() || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  savingDw.value = true
  // 持有 reloading 覆盖「保存 + 随后的 load()」整段，防止这段期间又切病人
  const release = beginReloading()
  try {
    await repository.saveDryWeight(d)
    showDwForm.value = false
    await load()
    showToast('已添加')
  } catch (err) {
    console.error(err)
    showToast(`保存失败：${errorText(err)}`)
  } finally {
    savingDw.value = false
    release()
  }
}

async function removeDw(d: DryWeight) {
  if (!canEditConfig.value) {
    showToast('仅创建者可修改病人配置')
    return
  }
  // ⚠️ 中级-3（第四轮独立评审）：原来没有 in-flight 守卫，弱网下连点删除会发出
  // 两个 `deleteDryWeight` + 两个并发 `load()`：第二次走 NotFound，且两个 load
  // 各持一份 reloading、各自用不同 pid 跑完，切/存行为变得不可预测。
  //
  // ⚠️ 第六轮测试评审坐实：**必须用独立标记 `deletingDw`，并且从「弹确认框之前」就置位**。
  // 原来复用 `savingDw` 且只在对话框关闭后才置 true，于是「用户正在读确认框」的那几秒
  // 里守卫是空的 —— 连点两次会弹出**两个**删除确认框（实测 `showConfirmDialog` 被调 2 次），
  // 用户点完第一个确定、第二个框还挂着。
  if (savingDw.value || deletingDw.value) return
  // ⚠️ 中级-2（第五轮独立评审）：切换病人途中不许删 —— 删除后 `load()` 用的是新 pid，
  // 用户以为在删甲的干体重，实际清的是乙的列表。
  if (reloading.value) {
    showToast('正在加载病人档案，请稍候再操作')
    return
  }
  deletingDw.value = true
  try {
    try {
      await showConfirmDialog({
        title: '删除',
        message: `删除干体重 ${fmt(d.value)}kg（${d.effectiveDate}）？删除后该日期之后的记录会按更早的干体重重新计算，请确认。`,
      })
    } catch {
      return // 用户取消
    }
    // 确认框开着期间可能被别的写操作占了（例如用户在别的入口存了干体重），
    // 也可能用户在这段时间切了病人
    if (savingDw.value) return
    if (reloading.value) {
      showToast('正在加载病人档案，请稍候再操作')
      return
    }
    savingDw.value = true
    // 持有 reloading 覆盖「删除 + 随后的 load()」整段
    const release = beginReloading()
    try {
      await repository.deleteDryWeight(d.id)
      await load()
    } catch (err) {
      console.error(err)
      showToast(`删除失败：${errorText(err)}`)
    } finally {
      savingDw.value = false
      release()
    }
  } finally {
    // 无论取消、失败、成功都要放开 —— 漏了会让删除功能永久失效
    deletingDw.value = false
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** 从备份 JSON 里数出记录条数（解析不出来就按 0 算，由调用方决定怎么提示） */
function backupCounts(data: unknown): { patients: number; sessions: number } {
  const obj = (data ?? {}) as { patients?: unknown; sessions?: unknown }
  return {
    patients: Array.isArray(obj.patients) ? obj.patients.length : 0,
    sessions: Array.isArray(obj.sessions) ? obj.sessions.length : 0,
  }
}

async function exportData() {
  if (exporting.value) return
  exporting.value = true
  try {
    const json = await repository.exportAll()
    let count = 0
    try {
      count = backupCounts(JSON.parse(json)).sessions
    } catch {
      count = 0
    }
    if (Capacitor.isNativePlatform()) {
      // APK：写入缓存并调起系统分享面板（可保存到文件 / 发送微信等）
      const name = `透析记录备份-${todayStr()}.json`
      const res = await Filesystem.writeFile({
        path: name,
        data: json,
        directory: Directory.Cache,
        recursive: true,
        encoding: Encoding.UTF8,
      })
      await Share.share({ title: '透析记录备份', url: res.uri, files: [res.uri] })
      showToast(`已生成备份（${count} 条透析记录），请选择保存或发送`)
    } else {
      // 浏览器：直接下载到下载目录
      const blob = new Blob([json], { type: 'application/json' })
      downloadBlob(blob, `透析记录备份-${todayStr()}.json`)
      // 带上条数：否则「导出成功」可能掩盖一份空备份（用户以为备份好了）
      showToast(count > 0 ? `已导出，共 ${count} 条透析记录` : '已导出，备份中没有透析记录')
    }
  } catch (err) {
    console.error(err)
    showToast(`导出失败：${errorText(err)}，请检查网络后重试`)
  } finally {
    exporting.value = false
  }
}

function importData() {
  // 云端模式数据在服务器上，本地仓库的 importAll 会无条件抛错 —— 入口就该是灰的
  if (isLoggedIn.value) {
    showToast('云端模式下数据在服务器，恢复备份请先退出登录')
    return
  }
  fileInput.value?.click()
}

async function onImportFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    if (isLoggedIn.value) {
      showToast('云端模式下数据在服务器，恢复备份请先退出登录')
      return
    }
    // ⚠️ 中级-2（第五轮独立评审坐实）：导入会整份替换本机数据，必须有 in-flight 守卫。
    // 原来连防连点都没有：用户连选两次文件 = 两次 `importAll` + 两个并发 `load(true)`。
    if (importing.value) return
    // 切换病人途中也不许导入：末尾的 `load(true)` 用的是**当时**的 pid，
    // 整库被替换后如果已经切到乙，回填的就是乙的档案（与 saveDw/removeDw 同一条理由）。
    if (reloading.value) {
      showToast('正在加载病人档案，请稍候再操作')
      return
    }
    const text = await file.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      showToast('导入失败：不是有效的备份文件')
      return
    }
    const counts = backupCounts(parsed)
    try {
      await showConfirmDialog({
        title: '导入数据恢复',
        message:
          `导入会覆盖本机现有全部数据，且无法撤销。\n` +
          `备份中含 ${counts.patients} 个病人、${counts.sessions} 条透析记录，确认恢复？`,
      })
    } catch {
      return // 用户取消：一个字节都不动
    }
    if (reloading.value) {
      // ⚠️ 轻微-2（第八轮测试有效性评审）：这里**只留 `reloading` 一道**，原来还有一道
      // `if (importing.value) return`，但那道是**不可达的防御代码** ——
      // `importing` 唯一的置位点就在下面（确认框之后），所以「确认框开着期间 importing 被
      // 另一次导入置 true」这件事在当前结构下不可能发生（实测：删掉那道，用例依然全绿，
      // 因为根本走不到）。留着它会让人误以为它在守护某个真实窗口，反而掩盖了「真正
      // 需要复查的是 pid 是否已变」这一点。若将来把 `importing = true` 提前到确认框之前，
      // 必须把这道检查一起加回来。
      showToast('正在加载病人档案，请稍候再操作')
      return
    }
    importing.value = true
    // 持有 reloading 覆盖「导入 + load(true)」整段：整库被替换后如果又切病人，
    // 回填的会是另一个人的档案
    const release = beginReloading()
    try {
      await repository.importAll(text)
      showToast('导入成功')
      await load(true) // 整份数据被替换：无条件回填表单
    } catch (err) {
      console.error(err)
      // 展示仓储抛出的真实原因（如「备份文件格式不正确：patients 第 1 条缺少 id」）
      showToast(`导入失败：${errorText(err)}`)
    } finally {
      importing.value = false
      release()
    }
  } finally {
    input.value = '' // 任何分支都清空，保证同一个文件能再次选中
  }
}

function showHelp() {
  showDialog({
    title: '使用说明',
    message:
      '1. 先在「设置」建立病人档案（姓名、生日、轮椅及衣物重量、回水量），并添加当前干体重。\n' +
      '2. 在「记录」页用「快速创建」填入上机前体重（含轮椅及衣物）快速建记录。\n' +
      '3. 进入记录详情填写下机后体重、血压（含心率）、血糖、不良反应。\n' +
      '4. 完成后点「标记完成」；若因血管条件差等原因没做完，点「中止透析」记录中止时间与原因。\n' +
      '5. 在报告页导出图片发给医生（报告会显示本次状态、中止原因与心率）。\n' +
      '6. 进行中的记录按「当前档案」的轮椅及衣物重量 / 回水量实时计算：天气变冷加了衣服，' +
      '改完档案立即生效，不用删记录重录；标记完成或中止时会固化成本次记录的值，历史数字不再变动。\n' +
      '7. 轮椅及衣物重量的每次改动都会自动留痕，可点档案里的「变更历史」查看。',
  })
}
</script>

<template>
  <div class="page">
    <van-nav-bar title="设置" :border="false" />

    <!-- 首次加载（本机还没有缓存）时显示骨架，避免白屏干等 -->
    <div v-if="loading" class="card" style="margin-top: 12px">
      <van-skeleton title :row="6" />
    </div>

    <!-- 加载失败：骨架与错误态互斥，且必须给出可点的「重试」 -->
    <div v-else-if="loadError" class="card load-error">
      <div class="load-error-text">{{ loadError }}</div>
      <van-button type="primary" round size="small" @click="load()">重试</van-button>
    </div>

    <template v-else>
    <div class="card">
      <div class="card-title">病人档案</div>
      <van-field v-model="form.name" label="姓名" placeholder="请输入姓名" />
      <van-field v-model="form.birthday" label="生日" placeholder="用于计算年龄" type="date" />
      <!--
        需求②：变更历史入口。
        ⚠️ 第十一轮（用户截图反馈）：原来是单独一行 .row（提示文字 + 按钮），
        flex 的 space-between 把按钮挤到只剩约 3 个字宽，「变更历史」被折成两行。
        改用 van-field 的 #button 插槽 —— 按钮就在输入框右侧，不占额外一行，
        提示文字移进弹窗（弹窗标题下方一行灰字）。
      -->
      <van-field
        v-model="form.wheelchairWeight"
        label="轮椅及衣物重量"
        label-width="8em"
        placeholder="kg"
        type="number"
      >
        <template #button>
          <van-button size="small" type="primary" plain @click="openChangeLog">变更历史</van-button>
        </template>
      </van-field>
      <van-field v-model="form.rinseBackVolume" label="回水量" placeholder="ml" type="number" />
      <div v-if="patient?.birthday" class="muted" style="margin: 4px 16px">
        当前年龄约 {{ calcAgeStr(patient.birthday) }}
      </div>
      <div v-if="!canEditConfig" class="muted" style="margin: 4px 16px">
        仅创建者可修改病人配置（你当前是「{{ roleLabel(currentRole ?? '') }}」，修改不会被保存）
      </div>
      <van-button
        type="primary"
        block
        style="margin-top: 10px"
        :loading="savingPatient"
        :disabled="!canEditConfig || savingPatient"
        @click="savePatient"
      >
        保存档案
      </van-button>
    </div>

    <div class="card">
      <div class="row">
        <div class="card-title" style="margin: 0">干体重历史</div>
        <van-button
          size="small"
          type="primary"
          plain
          :disabled="!canEditConfig || switchingPatient"
          @click="openDw"
          >＋ 新增</van-button
        >
      </div>
      <div v-if="!canEditConfig" class="muted" style="margin: 6px 0 4px">仅创建者可修改病人配置</div>
      <div class="muted" style="margin: 6px 0 4px">
        当前有效干体重 <span class="num">{{ fmt(currentDry) }}</span> kg
      </div>
      <div v-if="!dryWeights.length" class="muted" style="padding: 12px 0">暂无干体重记录，请先添加</div>
      <div v-for="d in dryWeights" :key="d.id" class="row" style="padding: 8px 0; border-top: 1px solid #f2f3f5">
        <div>
          <div class="num">{{ formatDateCN(d.effectiveDate) }}</div>
          <div class="muted">{{ d.note || '' }}</div>
        </div>
        <div class="row" style="gap: 12px">
          <span class="num">{{ fmt(d.value) }} kg</span>
          <van-icon
            v-if="canEditConfig"
            name="delete-o"
            :color="deletingDw || switchingPatient ? '#c8c9cc' : '#ee0a24'"
            :style="{ cursor: deletingDw || switchingPatient ? 'not-allowed' : 'pointer' }"
            @click="removeDw(d)"
          />
          <van-icon v-else name="delete-o" color="#c8c9cc" />
        </div>
      </div>
    </div>


    <div v-if="isLoggedIn" class="card">
      <div class="row">
        <div class="card-title" style="margin: 0">我的病人</div>
        <van-button
          size="small"
          type="primary"
          plain
          :loading="creatingPatient"
          :disabled="creatingPatient || Boolean(patientsError)"
          @click="openNewPatient"
        >
          ＋ 新建
        </van-button>
      </div>
      <!-- 失败态必须排在空态前面：否则「拉不到」会被显示成「一个病人都没有」，
           用户照着提示建重复档案（App 内删不掉） -->
      <div v-if="patientsError" class="muted" style="padding: 10px 0">
        {{ patientsError }}
        <van-button size="mini" plain style="margin-left: 8px" @click="retryPatients">重试</van-button>
      </div>
      <div v-else-if="!myPatients.length" class="muted" style="padding: 10px 0">暂无病人，点「＋ 新建」创建</div>
      <div
        v-for="item in myPatients"
        :key="item.patient.id"
        class="row"
        :style="{
          padding: '10px 0',
          borderTop: '1px solid #f2f3f5',
          // 保存/加载在途时病人行点不动：切过去会污染档案（见 switchPatient 注释），
          // 用样式和 cursor 让用户看得出来，而不是点了没反应
          // ⚠️ 中级-1（第四轮独立评审）：这里只能用 `switchingPatient`，不能用 `reloading` ——
          // 后者被 `saveDw`/`removeDw` 触发的 `load()` 持有，用它灰化会让「存一条干体重」
          // 就锁死整块病人列表最长 46 秒（`resilientFetch` 3×15s + 退避），且没有加载指示。
          cursor: savingPatient || switchingPatient ? 'not-allowed' : 'pointer',
          opacity: savingPatient || switchingPatient ? 0.5 : 1,
        }"
        @click="switchPatient(item.patient.id)"
      >
        <div>
          <div class="num">{{ item.patient.name }}</div>
          <div class="muted">{{ roleLabel(item.role) }}</div>
        </div>
        <van-icon v-if="currentPatientId === item.patient.id" name="success" color="#07c160" />
      </div>
      <van-button block plain style="margin-top: 10px" @click="goMembers">成员管理</van-button>
    </div>

    <div class="card">
      <div class="card-title">数据管理</div>
      <van-button block plain type="primary" :loading="exporting" :disabled="exporting" @click="exportData">
        导出全部数据（JSON 备份）
      </van-button>
      <van-button
        block
        plain
        style="margin-top: 10px"
        :disabled="isLoggedIn"
        @click="importData"
      >
        导入数据恢复
      </van-button>
      <div v-if="isLoggedIn" class="muted" style="margin: 6px 2px 0">
        云端模式下数据在服务器，恢复备份请先退出登录
      </div>
      <van-button block plain style="margin-top: 10px" @click="showHelp">使用说明</van-button>
      <van-button
        v-if="isLoggedIn"
        block
        plain
        style="margin-top: 10px"
        :loading="migrating"
        :disabled="migrating"
        @click="onMigrate"
      >
        上传本地数据到云端
      </van-button>
      <input ref="fileInput" type="file" accept=".json,application/json" style="display: none" @change="onImportFile" />
    </div>

    <div v-if="isLoggedIn" class="card">
      <div class="card-title">账号</div>
      <van-field v-model="myName" label="我的姓名" placeholder="记录人显示用（默认手机号）" />
      <div v-if="myPhone" class="muted" style="margin: 4px 16px">手机号 {{ myPhone }}</div>
      <van-button block plain type="primary" style="margin-top: 10px" :loading="savingName" :disabled="savingName" @click="saveMyName">
        保存姓名
      </van-button>
      <van-button block plain type="danger" style="margin-top: 10px" @click="onLogout">退出登录</van-button>
    </div>

    <van-popup v-model:show="showChangeLog" round position="bottom" style="max-height: 75%">
      <div style="padding: 20px">
        <div class="card-title">轮椅及衣物重量变更记录</div>
        <!-- 问题 4（用户拍板）：原表格行左侧的提示文字移到这里，弹窗标题下方一行灰字 -->
        <div class="muted" style="font-size: 12px; margin: -4px 0 8px">
          轮椅及衣物重量会随季节衣物变化，改动会自动留痕
        </div>
        <div v-if="changeLogLoading" style="padding: 16px 0">
          <van-loading size="20" vertical>加载中…</van-loading>
        </div>
        <div v-else-if="changeLogError" class="muted" style="padding: 16px 0; text-align: center">
          {{ changeLogError }}
          <div style="margin-top: 10px">
            <van-button size="small" type="primary" plain @click="openChangeLog">重试</van-button>
          </div>
        </div>
        <div v-else-if="!changeLogs.length" class="muted" style="padding: 16px 0; text-align: center">
          暂无变更记录
        </div>
        <div v-else style="max-height: 50vh; overflow-y: auto">
          <div
            v-for="log in changeLogs"
            :key="log.id"
            style="padding: 10px 0; border-top: 1px solid #f2f3f5"
          >
            <div class="row">
              <span class="num">{{ changeLogText(log) }}</span>
              <span class="muted">{{ formatDateTimeCN(log.changedAt) }}</span>
            </div>
            <div class="muted" style="font-size: 12px; margin-top: 2px">
              变更人：{{ log.operator || '未记录' }}
            </div>
          </div>
        </div>
        <van-button block style="margin-top: 16px" @click="showChangeLog = false">关闭</van-button>
      </div>
    </van-popup>

    <van-popup v-model:show="showDwForm" round position="bottom">
      <div style="padding: 20px">
        <div class="card-title">新增干体重</div>
        <van-field v-model="dwForm.value" label="干体重" placeholder="kg" type="number" />
        <van-field v-model="dwForm.effectiveDate" label="生效日期" type="date" />
        <van-field v-model="dwForm.note" label="备注" placeholder="如：医生调整（可选）" />
        <div style="display: flex; gap: 12px; margin-top: 16px">
          <van-button block @click="showDwForm = false">取消</van-button>
          <van-button block type="primary" :loading="savingDw" :disabled="savingDw" @click="saveDw">保存</van-button>
        </div>
      </div>
    </van-popup>

    <van-popup v-model:show="showNewPatient" round position="bottom">
      <div style="padding: 20px">
        <div class="card-title">新建病人</div>
        <van-field v-model="newPatientForm.name" label="姓名" placeholder="请输入姓名" />
        <van-field
          v-model="newPatientForm.wheelchairWeight"
          label="轮椅及衣物重量"
          label-width="7em"
          placeholder="kg"
          type="number"
        />
        <van-field v-model="newPatientForm.rinseBackVolume" label="回水量" placeholder="ml" type="number" />
        <div style="display: flex; gap: 12px; margin-top: 16px">
          <van-button block @click="showNewPatient = false">取消</van-button>
          <van-button block type="primary" :loading="creatingPatient" :disabled="creatingPatient" @click="onCreatePatient">
            创建
          </van-button>
        </div>
      </div>
    </van-popup>

    <!-- 版本号放页面最底部：装机后想确认「装的是哪一版」，不用再去翻系统设置 -->
    <div v-if="appVersion" class="muted" style="text-align: center; padding: 18px 0 6px">
      {{ appVersion }}
    </div>
    </template>
  </div>
</template>

<style scoped>
/* 加载失败态：与首页/详情页保持一致的观感 */
.load-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 24px 14px;
  text-align: center;
}
.load-error-text {
  color: #969799;
  font-size: 14px;
}
</style>

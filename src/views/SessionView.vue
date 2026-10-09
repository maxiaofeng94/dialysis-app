<script setup lang="ts">
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import { repository } from '../repo'
import { REACTION_TYPES, ABORT_REASONS, SESSION_STATUS_LABEL, abortText } from '../constants'
import { currentPatientId, isReadOnly, refreshCurrentRole } from '../stores/patient'
import { isLoggedIn } from '../stores/auth'
import { cacheVersion } from '../lib/cloudCache'
import { todayStr, parseNum, fmt, formatTime, combineDateTime, dateStr, formatDateTimeCN, formatDateCN } from '../utils/format'
import { getEffectiveDryWeight, calcWeights } from '../utils/calc'
import { assessBp, assessGlucose } from '../utils/assess'
import { uuid } from '../utils/id'
import type { DialysisSession, Patient, DryWeight, BloodPressure, BloodGlucose, BloodFlow, AdverseReaction } from '../types'

/**
 * 数字量程（M6）。Vant 的 number 输入允许粘贴前导负号，家属也可能把 5.5 打成 55，
 * 这些数一旦入库，趋势图、报告会一起错，而且用户完全看不出来。
 * 阈值取「明显不可能」的边界（成人透析常规范围），不做更严的业务校验。
 * 注意：HomeView 里有一份同样的体重阈值，改这里要同步改那边。
 */
const WEIGHT_MIN = 20 // kg，上机前 / 下机后体重（含轮椅）
const WEIGHT_MAX = 200
const BP_SYSTOLIC_MIN = 40 // mmHg
const BP_SYSTOLIC_MAX = 300
const BP_DIASTOLIC_MIN = 20 // mmHg
const BP_DIASTOLIC_MAX = 200
const GLUCOSE_MIN = 0.5 // mmol/L
const GLUCOSE_MAX = 50
const FLOW_MIN = 0 // ml/min
const FLOW_MAX = 600

/** 量程校验（M6）：不在 min~max 之间返回 false，由调用方负责提示且不写库 */
function checkRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max
}

const route = useRoute()
const router = useRouter()
const sessionId = route.params.id as string

const session = ref<DialysisSession | null>(null)
const patient = ref<Patient | null>(null)
const dryWeights = ref<DryWeight[]>([])
const bps = ref<BloodPressure[]>([])
const glucoses = ref<BloodGlucose[]>([])
const flows = ref<BloodFlow[]>([])
const reactions = ref<AdverseReaction[]>([])

const form = reactive({
  date: '',
  operator: '',
  notes: '',
  preWeight: '',
  postWeight: '',
  doctorUf: '',
})

const showBp = ref(false)
const bpForm = reactive({ time: '', systolic: '', diastolic: '' })
const editingBpId = ref<string | null>(null)
const showGlu = ref(false)
const gluForm = reactive({ time: '', value: '' })
const editingGluId = ref<string | null>(null)
const showFlow = ref(false)
const flowForm = reactive({ time: '', value: '' })
const editingFlowId = ref<string | null>(null)
const selectedReactions = ref<string[]>([])
const otherDetail = ref('')

/** 子记录弹窗保存中（M1）：连点两次会写出两条重复的血压/血糖/血流量 */
const saving = ref(false)
/** 状态切换进行中（M2）：连点会把状态又翻回去，也用来防「确认中止」被点两次 */
const statusBusy = ref(false)

// 中止透析
const showAbort = ref(false)
const abortForm = reactive({ date: '', time: '', tags: [] as string[], reason: '' })

let loaded = false
let timer: ReturnType<typeof setTimeout> | null = null
/** 上一次已提示过的量程越界文案：同一个提示不重复弹，避免每次防抖保存都骚扰用户 */
let lastRangeTip: string | null = null

/** 首次加载（本机还没有缓存）时的骨架占位 */
const loading = ref(true)
/** 加载失败（不处理的话会永远停在骨架上，用户干等） */
const loadFailed = ref(false)

onMounted(async () => {
  // 只读角色（医生 / 只读成员）的写操作会被 RLS 静默拒绝，界面必须提前隐藏写入口（H4）。
  // 本地模式或未登录时 refreshCurrentRole 自己会 return，不会多发请求。
  void refreshCurrentRole()
  await load()
})

async function load() {
  try {
    const pid = currentPatientId.value
    // 并行拉取，避免 7 次网络往返串行叠加
    const [s, p, dw] = await Promise.all([
      repository.getSession(sessionId),
      repository.getPatient(pid),
      repository.listDryWeights(pid),
    ])
    session.value = s ?? null
    if (!session.value) {
      router.replace('/')
      return
    }
    patient.value = p ?? null
    dryWeights.value = dw
    await loadSub()
    applySessionToForm(session.value)
    selectedReactions.value = reactions.value.map((r) => r.type)
    otherDetail.value = reactions.value.find((r) => r.type === 'other')?.detail ?? ''
    loaded = true
    markStateKnown()
  } catch (err) {
    console.error(err)
    loadFailed.value = true
  } finally {
    loading.value = false
  }
}

/** 重试加载：回到骨架态再拉一次 */
async function retryLoad() {
  loading.value = true
  loadFailed.value = false
  await load()
}

/** 把一条记录写进表单（首次打开与后台合并远端新值时共用） */
function applySessionToForm(s: DialysisSession) {
  form.date = s.date
  form.operator = s.operator ?? ''
  form.notes = s.notes ?? ''
  form.preWeight = s.preWeightMeasured != null ? String(s.preWeightMeasured) : ''
  form.postWeight = s.postWeightMeasured != null ? String(s.postWeightMeasured) : ''
  form.doctorUf = s.doctorUf != null ? String(s.doctorUf) : ''
}

/**
 * 「页面已知状态」快照（H2）
 *
 * 打开页面时记一份，之后只要用户没改动过表单与状态，就绝不回写：
 * 缓存可能是旧的（另一端 5 分钟前刚改了「下机后体重」并标记完成，本机渲染的仍是旧值），
 * 400ms 防抖一到就把 session 整行 upsert 回云端 → 把对方刚存的数据抹掉；
 * 记录若已被对方删除，这里还会顺手把它「复活」。
 */
function stateSnapshot(): string {
  const s = session.value
  return JSON.stringify([
    form,
    s ? { status: s.status, abortedAt: s.abortedAt, abortTags: s.abortTags, abortReason: s.abortReason } : null,
  ])
}
let knownSnapshot = ''
/** 已知状态的 updatedAt：只有真正更新的远端数据才允许合并进来，防止旧的后台刷新把刚保存的值顶回去 */
let knownUpdatedAt = 0

function markStateKnown() {
  knownSnapshot = stateSnapshot()
  knownUpdatedAt = session.value?.updatedAt ?? 0
}

async function loadSub() {
  // 四个子表并行拉取
  const [bp, bg, bf, ar] = await Promise.all([
    repository.listBloodPressures(sessionId),
    repository.listBloodGlucoses(sessionId),
    repository.listBloodFlows(sessionId),
    repository.listAdverseReactions(sessionId),
  ])
  bps.value = bp
  glucoses.value = bg
  flows.value = bf
  reactions.value = ar
}

const effectiveDry = computed(() => getEffectiveDryWeight(dryWeights.value, form.date || todayStr()))

const comp = computed(() => {
  if (!session.value) return null
  return calcWeights(
    parseNum(form.preWeight),
    parseNum(form.postWeight),
    session.value.wheelchairWeightUsed,
    session.value.rinseBackVolumeUsed,
    effectiveDry.value,
  )
})

function sanitizeDecimal(raw: string): string {
  // 半角与全角（中文输入法）逗号都当小数点：只认半角时「70，5」会被剔成 705（10 倍误差）
  let v = raw.replace(/[,，]/g, '.').replace(/[^\d.]/g, '')
  const dot = v.indexOf('.')
  if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '')
  if (v.length > 8) v = v.slice(0, 8)
  return v
}
function onPreWeightInput(e: Event) {
  const el = e.target as HTMLInputElement
  const v = sanitizeDecimal(el.value)
  form.preWeight = v
  el.value = v
}
function onPostWeightInput(e: Event) {
  const el = e.target as HTMLInputElement
  const v = sanitizeDecimal(el.value)
  form.postWeight = v
  el.value = v
}
function onDoctorUfInput(e: Event) {
  const el = e.target as HTMLInputElement
  const v = sanitizeDecimal(el.value)
  form.doctorUf = v
  el.value = v
}

/**
 * 所有写操作的统一出口（H1）
 * 断网 / 401 / RLS 拦截时不能再静默丢数据 —— 用户以为存上了，其实什么都没写进去。
 * 返回 false 表示失败（已经 toast 过），调用方据此决定「弹窗不关」「不跳转」。
 */
async function tryWrite(fn: () => Promise<unknown>, tip = '保存失败，请检查网络后重试'): Promise<boolean> {
  try {
    await fn()
    return true
  } catch (err) {
    console.error(err)
    showToast(tip)
    return false
  }
}

/** 表单里数字的量程检查（M6）：返回第一条越界文案，全部合法返回 null */
function formRangeTip(): string | null {
  const pre = parseNum(form.preWeight)
  if (pre != null && !checkRange(pre, WEIGHT_MIN, WEIGHT_MAX)) return `上机前体重需在 ${WEIGHT_MIN}~${WEIGHT_MAX}kg 之间`
  const post = parseNum(form.postWeight)
  if (post != null && !checkRange(post, WEIGHT_MIN, WEIGHT_MAX)) return `下机后体重需在 ${WEIGHT_MIN}~${WEIGHT_MAX}kg 之间`
  return null
}

watch(form, () => {
  if (!loaded) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(persistSession, 400) // 裸调用：persistSession 内部自带 try/catch
})

// 后台缓存刷新写回新数据后会自增 cacheVersion，未改动过页面时把远端新值合并进来（H2 的加强部分）
watch(cacheVersion, () => {
  void mergeRemoteIfUntouched()
})

/**
 * 后台刷新后合并远端新值（H2）
 *
 * 只在「用户完全没改动过」时合并；一旦用户动过表单或状态就整体跳过，
 * 绝不覆盖正在输入的内容（AGENTS.md 约定）。
 * 代价：用户正在输入时不会自动看到另一端的修改 —— 这是刻意的取舍。
 */
async function mergeRemoteIfUntouched() {
  if (!loaded || !session.value) return
  if (stateSnapshot() !== knownSnapshot) return
  try {
    const s = await repository.getSession(sessionId) // 命中后台刚写回的新缓存，不用再等一次网络
    if (!s) return // 另一端删掉了这条：这里不复活它，也不打断用户
    if (s.updatedAt <= knownUpdatedAt) return // 旧的后台刷新结果，不允许把刚保存的值顶回去
    session.value = s
    applySessionToForm(s)
    markStateKnown()
  } catch (err) {
    // 后台合并失败不打扰用户：页面上显示的是他自己刚确认过的数据
    console.error(err)
  }
}

/**
 * 保存表单到当前记录
 * - 被 setTimeout 裸调用，内部必须自己兜住异常（H1），否则失败 = unhandled rejection + 静默丢数据；
 * - 用户没改动过就直接返回（H2），不做无谓的整行回写。
 */
async function persistSession(): Promise<void> {
  if (!session.value || !loaded) return
  if (stateSnapshot() === knownSnapshot) return
  const rangeTip = formRangeTip()
  if (rangeTip) {
    // 越界不写库；同一句提示只弹一次，别让每次防抖保存都骚扰用户
    if (rangeTip !== lastRangeTip) {
      lastRangeTip = rangeTip
      showToast(`${rangeTip}（未保存）`)
    }
    return
  }
  lastRangeTip = null
  const s = session.value
  try {
    s.date = form.date || todayStr()
    s.operator = form.operator.trim() || null
    s.notes = form.notes.trim() || null
    s.preWeightMeasured = parseNum(form.preWeight)
    s.postWeightMeasured = parseNum(form.postWeight)
    s.doctorUf = parseNum(form.doctorUf)
    s.updatedAt = Date.now()
    await repository.saveSession(s)
    markStateKnown()
  } catch (err) {
    console.error(err)
    showToast('保存失败，请检查网络后重试')
  }
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

// 离开详情页前先等待保存完成，避免列表读到旧状态
onBeforeRouteLeave(async () => {
  try {
    await persistSession()
  } catch (err) {
    // persistSession 自己已经兜了一层，这里是保险：漏出来的异常也必须让用户看见，
    // 否则「填了下机后体重 → 点返回」会静默丢数据
    console.error(err)
    showToast('保存失败，请检查网络后重试')
  }
})

const abortSummary = computed(() => abortText(session.value?.abortTags, session.value?.abortReason))

/** 状态字段快照：写失败时回滚，页面不能显示云端并不存在的状态 */
function statusSnapshot(s: DialysisSession) {
  return {
    status: s.status,
    updatedAt: s.updatedAt,
    abortedAt: s.abortedAt,
    abortTags: s.abortTags,
    abortReason: s.abortReason,
  }
}

async function persistStatus(status: DialysisSession['status'], tip: string) {
  if (!session.value) return
  if (statusBusy.value) return // M2：连点两次会把状态又翻回去
  const s = session.value
  const prev = statusSnapshot(s)
  statusBusy.value = true
  // M5：切回「进行中」时一并清空中止信息。否则脏数据留在库里，
  // 下次真中止时 openAbort 会无条件回填上一次的中止时间。
  if (status === 'ongoing') {
    s.abortedAt = null
    s.abortTags = []
    s.abortReason = null
  }
  s.status = status
  s.updatedAt = Date.now()
  const ok = await tryWrite(() => repository.saveSession(s), '状态保存失败，请检查网络后重试')
  if (ok) {
    markStateKnown()
    showToast(tip)
  } else {
    Object.assign(s, prev) // 写失败就回滚，避免页面显示一个云端并没有的状态
  }
  statusBusy.value = false
}

async function toggleStatus() {
  if (!session.value) return
  if (session.value.status === 'completed') {
    await persistStatus('ongoing', '已改为进行中')
    return
  }
  const post = parseNum(form.postWeight)
  if (post == null) {
    await showConfirmDialog({
      title: '提示',
      message: '请先填写下机后体重，才能标记完成；若本次未完成，请用「中止透析」',
      showCancelButton: false,
      confirmButtonText: '知道了',
      confirmButtonColor: '#07c160',
      messageAlign: 'center',
    })
    return
  }
  // 量程越界的体重不会被保存，这时标记完成会让界面上的数与库里的数对不上
  if (!checkRange(post, WEIGHT_MIN, WEIGHT_MAX)) {
    showToast(`下机后体重需在 ${WEIGHT_MIN}~${WEIGHT_MAX}kg 之间，请先修正`)
    return
  }
  await persistStatus('completed', '已标记完成')
}

async function resumeSession() {
  await persistStatus('ongoing', '已改为进行中')
}

/** 打开中止弹窗：已有中止记录时回填；历史记录默认取该次透析日期的当前时刻，便于补录 */
function openAbort() {
  if (!session.value) return
  const now = Date.now()
  const fallback =
    session.value.date && session.value.date !== todayStr() ? combineDateTime(session.value.date, formatTime(now)) : now
  const ts = session.value.abortedAt ?? fallback
  abortForm.date = dateStr(ts)
  abortForm.time = formatTime(ts)
  abortForm.tags = [...(session.value.abortTags ?? [])]
  abortForm.reason = session.value.abortReason ?? ''
  showAbort.value = true
}

function toggleAbortTag(key: string) {
  const i = abortForm.tags.indexOf(key)
  if (i >= 0) abortForm.tags.splice(i, 1)
  else abortForm.tags.push(key)
}

async function confirmAbort() {
  if (!session.value || statusBusy.value) return
  const s = session.value
  const prev = statusSnapshot(s)
  s.abortedAt = combineDateTime(abortForm.date, abortForm.time)
  s.abortTags = [...abortForm.tags]
  s.abortReason = abortForm.reason.trim() || null
  s.status = 'aborted'
  s.updatedAt = Date.now()
  statusBusy.value = true
  const ok = await tryWrite(() => repository.saveSession(s), '保存失败，请检查网络后重试')
  statusBusy.value = false
  if (!ok) {
    Object.assign(s, prev) // 弹窗不关：用户填的内容还在，可以直接重试
    return
  }
  markStateKnown()
  showAbort.value = false
  showToast('已标记中止')
}

function openBp() {
  editingBpId.value = null
  bpForm.time = formatTime(Date.now())
  bpForm.systolic = ''
  bpForm.diastolic = ''
  showBp.value = true
}
function editBp(bp: BloodPressure) {
  editingBpId.value = bp.id
  bpForm.time = formatTime(bp.measuredAt)
  bpForm.systolic = String(bp.systolic)
  bpForm.diastolic = String(bp.diastolic)
  showBp.value = true
}
async function saveBp() {
  if (saving.value) return // M1：连点两次会写出两条重复记录
  const s = parseNum(bpForm.systolic)
  const d = parseNum(bpForm.diastolic)
  if (s == null || d == null) {
    showToast('请填写高压和低压')
    return
  }
  const sys = Math.round(s)
  const dia = Math.round(d)
  // M6：量程越界不写库
  if (!checkRange(sys, BP_SYSTOLIC_MIN, BP_SYSTOLIC_MAX) || !checkRange(dia, BP_DIASTOLIC_MIN, BP_DIASTOLIC_MAX)) {
    showToast(
      `血压应在 ${BP_SYSTOLIC_MIN}~${BP_SYSTOLIC_MAX}/${BP_DIASTOLIC_MIN}~${BP_DIASTOLIC_MAX} mmHg 之间，请检查输入`,
    )
    return
  }
  // id 在 await 之前定下来：即使守卫失效也不会生成第二个 id
  const id = editingBpId.value ?? uuid()
  saving.value = true
  try {
    const ok = await tryWrite(() =>
      repository.saveBloodPressure({
        id,
        sessionId,
        measuredAt: combineDateTime(form.date, bpForm.time),
        systolic: sys,
        diastolic: dia,
        note: null,
      }),
    )
    if (!ok) return // 失败时弹窗不关，用户可以直接重试
    showBp.value = false
    editingBpId.value = null
    await loadSub()
    showToast(`已保存：血压 ${sys}/${dia} ${assessBp(sys, dia).text}`)
  } finally {
    saving.value = false
  }
}
async function removeBp(bp: BloodPressure) {
  try {
    await showConfirmDialog({
      title: '删除',
      // M8：说清删的是哪一条，避免同一次透析里的几条记录看起来一模一样
      message: `删除 ${formatTime(bp.measuredAt)} 的血压（${bp.systolic}/${bp.diastolic}）？`,
    })
  } catch {
    return
  }
  if (!(await tryWrite(() => repository.deleteBloodPressure(bp.id), '删除失败，请检查网络后重试'))) return
  await loadSub()
  showToast('已删除')
}

function openGlu() {
  editingGluId.value = null
  gluForm.time = formatTime(Date.now())
  gluForm.value = ''
  showGlu.value = true
}
function editGlu(g: BloodGlucose) {
  editingGluId.value = g.id
  gluForm.time = formatTime(g.measuredAt)
  gluForm.value = String(g.value)
  showGlu.value = true
}
async function saveGlu() {
  if (saving.value) return // M1
  const v = parseNum(gluForm.value)
  if (v == null) {
    showToast('请填写血糖值')
    return
  }
  if (!checkRange(v, GLUCOSE_MIN, GLUCOSE_MAX)) {
    showToast(`血糖应在 ${GLUCOSE_MIN}~${GLUCOSE_MAX} mmol/L 之间，请检查输入`)
    return
  }
  const id = editingGluId.value ?? uuid()
  saving.value = true
  try {
    const ok = await tryWrite(() =>
      repository.saveBloodGlucose({
        id,
        sessionId,
        measuredAt: combineDateTime(form.date, gluForm.time),
        value: v,
        note: null,
      }),
    )
    if (!ok) return
    showGlu.value = false
    editingGluId.value = null
    await loadSub()
    showToast(`已保存：血糖 ${fmt(v)} mmol/L ${assessGlucose(v).text}`)
  } finally {
    saving.value = false
  }
}
async function removeGlu(g: BloodGlucose) {
  try {
    await showConfirmDialog({
      title: '删除',
      message: `删除 ${formatTime(g.measuredAt)} 的血糖（${fmt(g.value)} mmol/L）？`,
    })
  } catch {
    return
  }
  if (!(await tryWrite(() => repository.deleteBloodGlucose(g.id), '删除失败，请检查网络后重试'))) return
  await loadSub()
  showToast('已删除')
}

function openFlow() {
  editingFlowId.value = null
  flowForm.time = formatTime(Date.now())
  flowForm.value = ''
  showFlow.value = true
}
function editFlow(f: BloodFlow) {
  editingFlowId.value = f.id
  flowForm.time = formatTime(f.measuredAt)
  flowForm.value = String(f.value)
  showFlow.value = true
}
async function saveFlow() {
  if (saving.value) return // M1
  const v = parseNum(flowForm.value)
  if (v == null) {
    showToast('请填写血流量')
    return
  }
  const val = Math.round(v)
  if (!checkRange(val, FLOW_MIN, FLOW_MAX)) {
    showToast(`血流量应在 ${FLOW_MIN}~${FLOW_MAX} ml/min 之间，请检查输入`)
    return
  }
  const id = editingFlowId.value ?? uuid()
  saving.value = true
  try {
    const ok = await tryWrite(() =>
      repository.saveBloodFlow({
        id,
        sessionId,
        measuredAt: combineDateTime(form.date, flowForm.time),
        value: val,
        note: null,
      }),
    )
    if (!ok) return
    showFlow.value = false
    editingFlowId.value = null
    await loadSub()
    showToast(`已保存：血流量 ${val} ml/min`)
  } finally {
    saving.value = false
  }
}
async function removeFlow(f: BloodFlow) {
  try {
    await showConfirmDialog({
      title: '删除',
      message: `删除 ${formatTime(f.measuredAt)} 的血流量（${f.value} ml/min）？`,
    })
  } catch {
    return
  }
  if (!(await tryWrite(() => repository.deleteBloodFlow(f.id), '删除失败，请检查网络后重试'))) return
  await loadSub()
  showToast('已删除')
}
async function toggleReaction(key: string) {
  if (isReadOnly.value) return // H4：只读成员看得到已有不良反应，但不能改
  const i = selectedReactions.value.indexOf(key)
  if (i >= 0) selectedReactions.value.splice(i, 1)
  else selectedReactions.value.push(key)
  await persistReactions()
}

/** 不良反应整表替换（H1）：必须 await + catch，原来连 await 都没有，失败完全无处可见 */
async function persistReactions() {
  if (!session.value) return
  const list: AdverseReaction[] = selectedReactions.value
    .filter((k) => k !== 'other' || otherDetail.value.trim() !== '')
    .map((k) => ({
      id: uuid(),
      sessionId,
      type: k,
      detail: k === 'other' ? otherDetail.value.trim() : null,
      severity: null,
      recordedAt: Date.now(),
    }))
  await tryWrite(() => repository.replaceAdverseReactions(sessionId, list), '不良反应保存失败，请检查网络后重试')
}

async function onOtherBlur() {
  if (isReadOnly.value) return
  await persistReactions()
}

async function removeSession() {
  try {
    await showConfirmDialog({
      title: '删除',
      // M8：写清是「哪一天」的整条记录，并补齐原先漏掉的「血流量」
      message: `删除 ${formatDateCN(session.value?.date ?? '') || '这条'} 的整条透析记录（含血压/血糖/血流量/不良反应）？`,
    })
  } catch {
    return
  }
  if (!(await tryWrite(() => repository.deleteSession(sessionId), '删除失败，请检查网络后重试'))) return
  session.value = null
  router.replace('/')
}
</script>

<template>
  <div class="page">
    <van-nav-bar class="sticky-nav" title="透析记录" left-text="返回" left-arrow @click-left="router.back()">
      <template #right>
        <!-- 删除入口已移到页面底部危险区（L3）：与「报告」图标挨着只有 16px，单手操作时太容易误触 -->
        <van-icon name="description" size="20" color="#07c160" style="cursor: pointer" @click="router.push(`/report/${sessionId}`)" />
      </template>
    </van-nav-bar>

    <!-- 只读角色提示（H4）：写操作会被服务端静默拒绝（删 0 行也返回成功），必须提前说清楚 -->
    <div v-if="isReadOnly" class="readonly-banner">你是只读成员，仅可查看</div>

    <!-- 首次加载（本机还没有缓存）时显示骨架，避免白屏干等 -->
    <div v-if="loading" class="card" style="margin-top: 12px">
      <van-skeleton title :row="6" />
    </div>

    <!-- 加载失败：给出错误态与「重试」，不要永远停在骨架或空白页 -->
    <div v-else-if="loadFailed" class="card load-error">
      <div class="load-error-text">加载失败，请检查网络后重试</div>
      <van-button type="primary" round size="small" @click="retryLoad">重试</van-button>
    </div>

    <template v-if="session">
      <!-- 基本信息 -->
      <div class="card">
        <div class="status-row">
          <div class="status-badge" :class="session.status">
            <span class="dot"></span>
            {{ SESSION_STATUS_LABEL[session.status] }}
          </div>
          <div v-if="!isReadOnly" class="status-actions">
            <template v-if="session.status === 'ongoing'">
              <van-button size="small" round type="success" icon="checked" :loading="statusBusy" @click="toggleStatus">
                标记完成
              </van-button>
              <van-button size="small" round type="danger" plain icon="close" :disabled="statusBusy" @click="openAbort">
                中止透析
              </van-button>
            </template>
            <template v-else-if="session.status === 'completed'">
              <van-button size="small" round type="default" icon="replay" :loading="statusBusy" @click="resumeSession">
                改为进行中
              </van-button>
              <van-button size="small" round type="danger" plain icon="close" :disabled="statusBusy" @click="openAbort">
                标记中止
              </van-button>
            </template>
            <van-button v-else size="small" round type="default" icon="replay" :loading="statusBusy" @click="resumeSession">
              改为进行中
            </van-button>
          </div>
        </div>

        <div v-if="session.status === 'aborted'" class="abort-box">
          <div class="row">
            <div class="abort-title">本次透析已中止</div>
            <van-button v-if="!isReadOnly" size="mini" round type="primary" plain @click="openAbort">
              {{ abortSummary ? '修改中止信息' : '补充中止原因' }}
            </van-button>
          </div>
          <div class="abort-line">
            <span class="abort-k">中止时间</span>
            <span class="num">{{ session.abortedAt ? formatDateTimeCN(session.abortedAt) : '未记录' }}</span>
          </div>
          <div class="abort-line">
            <span class="abort-k">中止原因</span>
            <span class="abort-v">{{ abortSummary || '未填写' }}</span>
          </div>
        </div>
        <van-field v-model="form.date" label="透析日期" type="date" :readonly="isReadOnly" />
        <van-field v-if="!isLoggedIn" v-model="form.operator" label="记录人" placeholder="谁记录的（可选）" />
      </div>

      <!-- 体重与脱水 -->
      <div class="card">
        <div class="card-title">体重与脱水</div>

        <div class="weight-fields">
          <div class="weight-field">
            <div class="weight-label">上机前称重（含轮椅）</div>
            <div class="weight-input-wrap">
              <input
                :value="form.preWeight"
                type="text"
                inputmode="decimal"
                placeholder="0.0"
                class="weight-input"
                :readonly="isReadOnly"
                @input="onPreWeightInput"
              />
              <span class="weight-unit">kg</span>
            </div>
          </div>
          <div class="weight-field">
            <div class="weight-label">下机后称重（含轮椅）</div>
            <div class="weight-input-wrap">
              <input
                :value="form.postWeight"
                type="text"
                inputmode="decimal"
                placeholder="0.0"
                class="weight-input"
                :readonly="isReadOnly"
                @input="onPostWeightInput"
              />
              <span class="weight-unit">kg</span>
            </div>
          </div>
          <div class="weight-field">
            <div class="weight-label">医生设定脱水量</div>
            <div class="weight-input-wrap">
              <input
                :value="form.doctorUf"
                type="text"
                inputmode="decimal"
                placeholder="0"
                class="weight-input"
                :readonly="isReadOnly"
                @input="onDoctorUfInput"
              />
              <span class="weight-unit">ml</span>
            </div>
          </div>
        </div>

        <div class="flow">
          <div class="flow-node">
            <div class="flow-label">上机前实际</div>
            <div class="flow-val">{{ fmt(comp?.preWeightActual) }}<small>kg</small></div>
          </div>
          <div class="flow-mid">
            <div class="flow-arrow">↓</div>
            <div v-if="comp?.actualUf != null" class="flow-diff">脱 {{ fmt(comp.actualUf) }}L</div>
          </div>
          <div class="flow-node">
            <div class="flow-label">下机后实际</div>
            <div class="flow-val">{{ fmt(comp?.postWeightActual) }}<small>kg</small></div>
          </div>
        </div>

        <div class="uf-grid">
          <div class="uf-item">
            <div class="uf-label">计划脱水量</div>
            <div class="uf-val">{{ fmt(comp?.planUf) }}<small>L</small></div>
          </div>
          <div class="uf-item">
            <div class="uf-label">实际脱水量</div>
            <div class="uf-val">{{ fmt(comp?.actualUf) }}<small>L</small></div>
          </div>
        </div>

        <div class="uf-meta">当日干体重 {{ fmt(comp?.effectiveDryWeight) }}kg · 回水 {{ comp?.rinseBackMl ?? '—' }}ml · 机器超滤 {{ fmt(comp?.machineUf) }}L</div>
        <div v-if="session.status === 'aborted' && comp?.postWeightActual == null" class="abort-hint">
          本次透析中止且未记录下机后体重，补录称重后会自动算出实际脱水量
        </div>
      </div>

      <!-- 血压 -->
      <div class="card">
        <div class="row">
          <div class="card-title" style="margin: 0">血压 ({{ bps.length }})</div>
          <van-button v-if="!isReadOnly" size="small" type="primary" plain @click="openBp">＋ 记录</van-button>
        </div>
        <div v-if="!bps.length" class="muted" style="padding: 10px 0">暂无血压记录</div>
        <div v-for="bp in bps" :key="bp.id" class="row" style="padding: 8px 0; border-top: 1px solid #f2f3f5">
          <div class="row" style="gap: 10px">
            <span class="muted">{{ formatTime(bp.measuredAt) }}</span>
            <span class="num">{{ bp.systolic }} / {{ bp.diastolic }} <span class="muted">mmHg</span></span>
            <van-tag :type="assessBp(bp.systolic, bp.diastolic).color">{{ assessBp(bp.systolic, bp.diastolic).text }}</van-tag>
          </div>
          <div v-if="!isReadOnly" class="row" style="gap: 10px">
            <van-icon name="edit" color="#1989fa" style="cursor: pointer" @click="editBp(bp)" />
            <van-icon name="delete-o" color="#ee0a24" style="cursor: pointer" @click="removeBp(bp)" />
          </div>
        </div>
      </div>

      <!-- 血糖 -->
      <div class="card">
        <div class="row">
          <div class="card-title" style="margin: 0">血糖 ({{ glucoses.length }})</div>
          <van-button v-if="!isReadOnly" size="small" type="primary" plain @click="openGlu">＋ 记录</van-button>
        </div>
        <div v-if="!glucoses.length" class="muted" style="padding: 10px 0">暂无血糖记录（每次透析 1 次）</div>
        <div v-for="g in glucoses" :key="g.id" class="row" style="padding: 8px 0; border-top: 1px solid #f2f3f5">
          <div class="row" style="gap: 10px">
            <span class="muted">{{ formatTime(g.measuredAt) }}</span>
            <span class="num">{{ fmt(g.value) }} <span class="muted">mmol/L</span></span>
            <van-tag :type="assessGlucose(g.value).color">{{ assessGlucose(g.value).text }}</van-tag>
          </div>
          <div v-if="!isReadOnly" class="row" style="gap: 10px">
            <van-icon name="edit" color="#1989fa" style="cursor: pointer" @click="editGlu(g)" />
            <van-icon name="delete-o" color="#ee0a24" style="cursor: pointer" @click="removeGlu(g)" />
          </div>
        </div>
      </div>

      <!-- 血流量 -->
      <div class="card">
        <div class="row">
          <div class="card-title" style="margin: 0">血流量 ({{ flows.length }})</div>
          <van-button v-if="!isReadOnly" size="small" type="primary" plain @click="openFlow">＋ 记录</van-button>
        </div>
        <div v-if="!flows.length" class="muted" style="padding: 10px 0">暂无血流量记录</div>
        <div v-for="f in flows" :key="f.id" class="row" style="padding: 8px 0; border-top: 1px solid #f2f3f5">
          <div class="row" style="gap: 10px">
            <span class="muted">{{ formatTime(f.measuredAt) }}</span>
            <span class="num">{{ f.value }} <span class="muted">ml/min</span></span>
          </div>
          <div v-if="!isReadOnly" class="row" style="gap: 10px">
            <van-icon name="edit" color="#1989fa" style="cursor: pointer" @click="editFlow(f)" />
            <van-icon name="delete-o" color="#ee0a24" style="cursor: pointer" @click="removeFlow(f)" />
          </div>
        </div>
      </div>

      <!-- 不良反应 -->
      <div class="card">
        <div class="card-title">不良反应</div>
        <div>
          <!-- 只读成员看得到已有不良反应，但标签不可勾选（H4）；真正的写库守卫在 toggleReaction 里 -->
          <span
            v-for="r in REACTION_TYPES"
            :key="r.key"
            class="chip"
            :class="{ active: selectedReactions.includes(r.key), 'chip-readonly': isReadOnly }"
            @click="toggleReaction(r.key)"
          >
            {{ r.label }}
          </span>
        </div>
        <div v-if="isReadOnly && otherDetail" class="readonly-other">其他：{{ otherDetail }}</div>
        <van-field
          v-else-if="!isReadOnly && selectedReactions.includes('other')"
          v-model="otherDetail"
          label="其他"
          placeholder="请描述具体不良反应"
          @blur="onOtherBlur"
        />
        <van-field
          v-model="form.notes"
          label="备注"
          placeholder="其他补充说明（可选）"
          :readonly="isReadOnly"
        />
      </div>

      <!-- 删除入口（L3）：放在页面底部危险区，与右上角「报告」图标拉开距离，避免单手误触 -->
      <div v-if="!isReadOnly" class="danger-zone">
        <van-button block plain type="danger" icon="delete-o" @click="removeSession">删除本条记录</van-button>
      </div>

    </template>

    <!-- 血压弹窗 -->
    <van-popup v-model:show="showBp" round position="bottom">
      <div style="padding: 20px">
        <div class="card-title">{{ editingBpId ? '编辑血压' : '记录血压' }}</div>
        <van-field v-model="bpForm.time" label="测量时间" type="time" />
        <van-field v-model="bpForm.systolic" label="高压" placeholder="mmHg" type="number" />
        <van-field v-model="bpForm.diastolic" label="低压" placeholder="mmHg" type="number" />
        <div style="display: flex; gap: 12px; margin-top: 16px">
          <van-button block :disabled="saving" @click="showBp = false">取消</van-button>
          <van-button block type="primary" :loading="saving" @click="saveBp">保存</van-button>
        </div>
      </div>
    </van-popup>

    <!-- 血糖弹窗 -->
    <van-popup v-model:show="showGlu" round position="bottom">
      <div style="padding: 20px">
        <div class="card-title">{{ editingGluId ? '编辑血糖' : '记录血糖' }}</div>
        <van-field v-model="gluForm.time" label="测量时间" type="time" />
        <van-field v-model="gluForm.value" label="血糖值" placeholder="mmol/L" type="number" />
        <div style="display: flex; gap: 12px; margin-top: 16px">
          <van-button block :disabled="saving" @click="showGlu = false">取消</van-button>
          <van-button block type="primary" :loading="saving" @click="saveGlu">保存</van-button>
        </div>
      </div>
    </van-popup>

    <!-- 血流量弹窗 -->
    <van-popup v-model:show="showFlow" round position="bottom">
      <div style="padding: 20px">
        <div class="card-title">{{ editingFlowId ? '编辑血流量' : '记录血流量' }}</div>
        <van-field v-model="flowForm.time" label="测量时间" type="time" />
        <van-field v-model="flowForm.value" label="血流量" placeholder="ml/min" type="number" />
        <div style="display: flex; gap: 12px; margin-top: 16px">
          <van-button block :disabled="saving" @click="showFlow = false">取消</van-button>
          <van-button block type="primary" :loading="saving" @click="saveFlow">保存</van-button>
        </div>
      </div>
    </van-popup>

    <!-- 中止弹窗 -->
    <van-popup v-model:show="showAbort" round position="bottom">
      <div style="padding: 20px">
        <div class="card-title">{{ session?.status === 'aborted' ? '修改中止信息' : '中止本次透析' }}</div>
        <div class="muted" style="margin: 0 0 10px">
          记录中止时间与原因，便于回顾本次未完成的原因（可留空；历史记录也可在此补录）
        </div>
        <van-field v-model="abortForm.date" label="中止日期" type="date" />
        <van-field v-model="abortForm.time" label="中止时间" type="time" />
        <div class="abort-field-label">常用原因（可多选）</div>
        <div>
          <span
            v-for="r in ABORT_REASONS"
            :key="r.key"
            class="chip"
            :class="{ active: abortForm.tags.includes(r.key) }"
            @click="toggleAbortTag(r.key)"
          >
            {{ r.label }}
          </span>
        </div>
        <van-field
          v-model="abortForm.reason"
          label="补充描述"
          type="textarea"
          rows="2"
          autosize
          placeholder="具体情况（可选）"
        />
        <div style="display: flex; gap: 12px; margin-top: 16px">
          <van-button block :disabled="statusBusy" @click="showAbort = false">取消</van-button>
          <van-button block type="danger" :loading="statusBusy" @click="confirmAbort">确认中止</van-button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
/* 只读角色提示条（H4） */
.readonly-banner {
  margin: 0 0 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #fffbe8;
  color: #ed6a0c;
  font-size: 13px;
  text-align: center;
}
/* 加载失败态：与骨架互斥，并给出可点的「重试」 */
.load-error {
  text-align: center;
  padding: 20px 14px;
}
.load-error-text {
  font-size: 14px;
  color: #646566;
  margin-bottom: 12px;
}
/* 只读成员的不良反应标签：保留展示，去掉「可点」的视觉暗示 */
.chip-readonly {
  cursor: default;
}
.readonly-other {
  font-size: 14px;
  color: #323233;
  padding: 6px 0;
}
/* 危险区（L3）：删除入口远离右上角的「报告」与「返回」，降低误触 */
.danger-zone {
  margin: 18px 0 4px;
}
.status-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  padding: 10px 12px;
  background: #f7f8fa;
  border-radius: 10px;
}
.status-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  padding: 4px 12px;
  border-radius: 999px;
}
.status-badge .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}
.status-badge.ongoing {
  color: #ed6a0c;
  background: #fff4e8;
}
.status-badge.completed {
  color: #07c160;
  background: #e8f7ef;
}
.status-badge.aborted {
  color: #ee0a24;
  background: #ffecec;
}
.status-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.abort-box {
  background: #fff5f5;
  border: 1px solid #ffd9d9;
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 8px;
}
.abort-title {
  font-size: 14px;
  font-weight: 700;
  color: #ee0a24;
}
.abort-line {
  display: flex;
  gap: 8px;
  font-size: 13px;
  color: #323233;
  margin-top: 6px;
}
.abort-k {
  color: #969799;
  flex-shrink: 0;
}
.abort-v {
  flex: 1;
  word-break: break-all;
}
.abort-field-label {
  font-size: 13px;
  color: #646566;
  margin: 10px 0 2px;
}
.sticky-nav {
  position: sticky;
  top: 0;
  z-index: 100;
  background: #fff;
}
.weight-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 16px;
}
.weight-field {
  width: 100%;
}
.weight-label {
  font-size: 13px;
  color: #646566;
  margin-bottom: 6px;
}
.weight-input-wrap {
  display: flex;
  align-items: baseline;
  gap: 10px;
  background: #f7f8fa;
  border: 1px solid #ebedf0;
  border-radius: 12px;
  padding: 12px 16px;
}
.weight-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  font-size: 34px;
  font-weight: 700;
  color: #323233;
  text-align: center;
  outline: none;
  line-height: 1.2;
}
.weight-input::placeholder {
  color: #c8c9cc;
}
.weight-unit {
  font-size: 16px;
  font-weight: 600;
  color: #646566;
}
.flow {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #f7f8fa;
  border-radius: 12px;
  padding: 12px;
  margin-bottom: 12px;
}
.flow-node {
  flex: 1;
  text-align: center;
}
.flow-label {
  font-size: 12px;
  color: #969799;
}
.flow-val {
  font-size: 22px;
  font-weight: 700;
  color: #323233;
}
.flow-val small {
  font-size: 12px;
  font-weight: 500;
  color: #969799;
  margin-left: 2px;
}
.flow-mid {
  text-align: center;
  min-width: 56px;
}
.flow-arrow {
  font-size: 20px;
  color: #07c160;
  line-height: 1;
}
.flow-diff {
  font-size: 12px;
  color: #07c160;
  font-weight: 600;
  margin-top: 2px;
}
.uf-grid {
  display: flex;
  gap: 10px;
  margin-bottom: 10px;
}
.uf-item {
  flex: 1;
  background: #e8f7ef;
  border-radius: 12px;
  padding: 12px 6px;
  text-align: center;
}
.uf-label {
  font-size: 12px;
  color: #07c160;
}
.uf-val {
  font-size: 24px;
  font-weight: 700;
  color: #07c160;
}
.uf-val small {
  font-size: 13px;
  font-weight: 500;
  margin-left: 2px;
}
.uf-meta {
  font-size: 12px;
  color: #969799;
  text-align: center;
}
.abort-hint {
  font-size: 12px;
  color: #ee0a24;
  text-align: center;
  margin-top: 8px;
}
</style>

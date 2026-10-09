<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { repository } from '../repo'
import { SESSION_STATUS_LABEL, SESSION_STATUS_TAG, abortText } from '../constants'
import { currentPatientId, hasNoCloudPatient, isReadOnly, refreshCurrentRole } from '../stores/patient'
import { isLoggedIn } from '../stores/auth'
import { cacheVersion } from '../lib/cloudCache'
import { todayStr, formatDateCN, fmt, calcAge } from '../utils/format'
import { computeSession, getEffectiveDryWeight } from '../utils/calc'
import { uuid } from '../utils/id'
import type { Patient, DryWeight, DialysisSession } from '../types'

const router = useRouter()
const patient = ref<Patient | null>(null)
const dryWeights = ref<DryWeight[]>([])
const sessions = ref<DialysisSession[]>([])
const quickWeight = ref('')
const loading = ref(true)
const showNewDialog = ref(false)
const noCloudPatient = ref(false)
/** 加载失败提示（H5）：非空时用错误态 +「重试」取代空状态，否则会误导用户去重新建档 */
const error = ref('')
/** 创建中（H3）：连点「立即创建」会写出两条一模一样的记录 */
const creating = ref(false)

/**
 * 体重量程（M6，kg，含轮椅）。
 * 填 0 / 5 也能建记录，列表随即显示「-72L」级别的荒谬脱水量，家属根本看不出哪条是真的。
 * 超范围一律不写库、只提示。注意：SessionView 里有一份同样的阈值，改这里要同步改那边。
 */
const WEIGHT_MIN = 20
const WEIGHT_MAX = 200

/** 量程校验（M6）：不在 min~max 之间返回 false，由调用方负责提示且不写库 */
function checkRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max
}

onMounted(async () => {
  // 只读角色（医生 / 只读成员）的写操作会被 RLS 静默拒绝，界面必须提前隐藏写入口（H4）。
  // 本地模式或未登录时 refreshCurrentRole 自己会 return，不会多发请求。
  void refreshCurrentRole()
  await refresh()
})

// 后台静默刷新的数据写回缓存后会自增 cacheVersion，这里自动重读一次（命中新缓存，无需等网络）
watch(cacheVersion, () => {
  void refresh()
})

/**
 * 加载失败不再让页面永远停在骨架（H5）：
 * - 失败必须留下错误态与「重试」入口，只 toast 一下等于没下文；
 * - `loading` 放 finally，任何分支都会收起骨架。
 */
async function refresh() {
  const pid = currentPatientId.value
  try {
    // 三个请求并行发出：总耗时约等于最慢的那个，而不是三次网络往返相加
    const [p, dw, ss] = await Promise.all([
      repository.getPatient(pid),
      repository.listDryWeights(pid),
      repository.listSessions(pid),
    ])
    patient.value = p ?? null
    dryWeights.value = dw
    sessions.value = ss
    // 云端账号下还没有任何病人 → 首页给出更明确的引导
    noCloudPatient.value = !patient.value && isLoggedIn.value ? await hasNoCloudPatient() : false
    error.value = ''
  } catch (err) {
    console.error(err)
    error.value = '加载失败，请检查网络后重试'
  } finally {
    loading.value = false
  }
}

/** 「重试」：回到骨架态再拉一次 */
async function retry() {
  loading.value = true
  error.value = ''
  await refresh()
}

/**
 * 只有「首屏加载失败且本机没有任何可展示数据」才用错误态盖住页面；
 * 已经有内容时（例如后台静默刷新失败）继续显示旧数据，不打扰用户。
 */
const loadFailed = computed(() => error.value !== '' && !patient.value && sessions.value.length === 0)

const currentDry = computed(() => getEffectiveDryWeight(dryWeights.value, todayStr()))

function ageText(): string {
  const a = patient.value?.birthday ? calcAge(patient.value.birthday) : null
  return a == null ? '' : `${a} 岁`
}

const quickPreview = computed(() => {
  const p = patient.value
  if (!p || quickWeight.value.trim() === '') return null
  const w = Number(quickWeight.value)
  if (!Number.isFinite(w)) return null
  const pre = Math.round((w - p.wheelchairWeight) * 10) / 10
  const dry = getEffectiveDryWeight(dryWeights.value, todayStr())
  const plan = dry != null ? Math.round((pre - dry) * 10) / 10 : null
  return { pre, plan }
})

/** 缺日期的脏数据统一落到这个分组，不要让它把整页渲染搞崩 */
const UNKNOWN_MONTH = '日期未知'

const grouped = computed(() => {
  const map = new Map<string, DialysisSession[]>()
  for (const s of sessions.value) {
    // `s.date` 可能缺失/为空（旧数据、导入的数据）：原先直接 .slice 会抛错，整页白屏（L1）
    const date = String(s.date ?? '')
    const month = date ? date.slice(0, 7) : UNKNOWN_MONTH
    const arr = map.get(month)
    if (arr) arr.push(s)
    else map.set(month, [s])
  }
  const entries = Array.from(map.entries())
  // 「日期未知」始终排在最后，别插在正常月份中间
  const unknownAt = entries.findIndex(([m]) => m === UNKNOWN_MONTH)
  if (unknownAt >= 0 && unknownAt !== entries.length - 1) {
    entries.push(entries.splice(unknownAt, 1)[0])
  }
  return entries
})

function summary(s: DialysisSession) {
  const dry = getEffectiveDryWeight(dryWeights.value, s.date)
  return computeSession(s, dry)
}

// 只允许数字和一个小数点，并把半角/全角（中文输入法）逗号都转成小数点。
// 只认半角逗号时，「70，5」会被 [^\d.] 剔成 705 —— 10 倍体重误差。
function onWeightInput(e: Event) {
  const el = e.target as HTMLInputElement
  let v = el.value.replace(/[,，]/g, '.').replace(/[^\d.]/g, '')
  const dot = v.indexOf('.')
  if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '')
  if (v.length > 8) v = v.slice(0, 8)
  quickWeight.value = v
  el.value = v
}

async function createSession(preWeight: number | null) {
  if (!patient.value) {
    router.push('/settings')
    return
  }
  const s: DialysisSession = {
    id: uuid(),
    patientId: currentPatientId.value,
    date: todayStr(),
    preWeightMeasured: preWeight,
    postWeightMeasured: null,
    wheelchairWeightUsed: patient.value.wheelchairWeight,
    rinseBackVolumeUsed: patient.value.rinseBackVolume,
    operator: null,
    doctorUf: null,
    status: 'ongoing',
    abortedAt: null,
    abortTags: [],
    abortReason: null,
    notes: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await repository.saveSession(s)
  router.push(`/session/${s.id}`)
}

async function onQuickCreate() {
  // H3：双击 / 连点会写出两条重复记录，创建期间直接忽略后续点击
  if (creating.value) return
  if (!patient.value) {
    router.push('/settings')
    return
  }
  if (quickWeight.value.trim() === '') {
    await showConfirmDialog({
      title: '提示',
      message: '请先填写上机前体重（含轮椅），才能立即创建记录',
      showCancelButton: false,
      confirmButtonText: '知道了',
      confirmButtonColor: '#07c160',
      messageAlign: 'center',
    })
    return
  }
  const w = Number(quickWeight.value)
  if (!Number.isFinite(w)) {
    showToast('请输入有效的体重数值')
    return
  }
  // M6：越界不写库（否则会算出 -72L 这种谁都看不懂的脱水量）
  if (!checkRange(w, WEIGHT_MIN, WEIGHT_MAX)) {
    showToast(`体重需在 ${WEIGHT_MIN}~${WEIGHT_MAX}kg 之间，请检查输入`)
    return
  }
  await guardedCreate(() => createSession(w))
}

function onNewBlank() {
  showNewDialog.value = true
}

async function doNewBlank() {
  showNewDialog.value = false
  await guardedCreate(() => createSession(null))
}

/**
 * 创建记录的唯一入口：防连点（H3），并在失败时明确提示
 * （原来的裸 await 一旦保存失败就是「点了没反应」，用户会一直点）。
 */
async function guardedCreate(run: () => Promise<void>): Promise<void> {
  if (creating.value) return
  creating.value = true
  try {
    await run()
  } catch (err) {
    console.error(err)
    showToast('创建失败，请检查网络后重试')
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="page">
    <van-nav-bar title="透析记录" :border="false">
      <template #right>
        <van-button v-if="!isReadOnly" size="small" type="primary" plain @click="onNewBlank">＋ 新建</van-button>
      </template>
    </van-nav-bar>

    <!-- 只读角色提示（H4）：写操作会被服务端静默拒绝，必须提前说清楚，不能等用户点了没反应 -->
    <div v-if="isReadOnly" class="readonly-banner">你是只读成员，仅可查看</div>

    <!-- 首次在本机打开（还没有缓存）时先显示骨架，避免白屏干等 -->
    <div v-if="loading" class="card" style="margin-top: 12px">
      <van-skeleton title :row="4" />
    </div>

    <!-- 加载失败（H5）：骨架与错误态互斥，且必须给出可点的「重试」 -->
    <div v-else-if="loadFailed" class="card load-error">
      <div class="load-error-text">{{ error }}</div>
      <van-button type="primary" round size="small" @click="retry">重试</van-button>
    </div>

    <div v-if="patient && !loadFailed" class="card patient-card">
      <div class="patient-head">
        <div class="avatar">{{ patient.name.charAt(0) }}</div>
        <div class="patient-name">{{ patient.name }}</div>
        <span v-if="ageText()" class="age-badge">{{ ageText() }}</span>
      </div>
      <div class="patient-divider"></div>
      <div class="patient-stats">
        <div class="pstat">
          <div class="pstat-v">{{ fmt(currentDry) }}<small>kg</small></div>
          <div class="pstat-l">干体重</div>
        </div>
        <div class="pstat">
          <div class="pstat-v">{{ fmt(patient.wheelchairWeight) }}<small>kg</small></div>
          <div class="pstat-l">轮椅重量</div>
        </div>
        <div class="pstat">
          <div class="pstat-v">{{ patient.rinseBackVolume }}<small>ml</small></div>
          <div class="pstat-l">回水量</div>
        </div>
      </div>
    </div>

    <!-- 快速创建（只读成员没有创建入口，整块隐藏，避免填了半天发现点不了） -->
    <div v-if="!loading && !loadFailed && !isReadOnly" class="quick-card">
      <div class="quick-title">快速创建</div>
      <div class="quick-label">上机前体重（含轮椅）</div>
      <div class="quick-input-wrap">
        <input
          :value="quickWeight"
          type="text"
          inputmode="decimal"
          placeholder="0.0"
          class="quick-input"
          @input="onWeightInput"
        />
        <span class="quick-unit">kg</span>
      </div>
      <div v-if="patient" class="quick-stats">
        <div class="stat">
          <div class="stat-label">实际体重</div>
          <div class="stat-value">{{ fmt(quickPreview?.pre) }}<small> kg</small></div>
        </div>
        <div class="stat">
          <div class="stat-label">计划脱水量</div>
          <div class="stat-value">{{ fmt(quickPreview?.plan) }}<small> L</small></div>
        </div>
      </div>
      <div v-else class="quick-hint">请先到「设置」建立病人档案，才能自动计算</div>
      <button class="quick-btn" :disabled="creating" @click="onQuickCreate">
        {{ creating ? '创建中…' : '立即创建' }}
      </button>
    </div>

    <!-- 无病人档案 -->
    <van-empty
      v-if="!loading && !loadFailed && !patient"
      :description="noCloudPatient ? '还没有病人档案，去「设置」新建或上传本地数据' : '请先建立病人档案'"
    >
      <van-button type="primary" @click="router.push('/settings')">去设置</van-button>
    </van-empty>

    <!-- 记录列表 -->
    <template v-else-if="!loading && !loadFailed">
      <van-empty
        v-if="!sessions.length"
        :description="isReadOnly ? '暂无透析记录' : '暂无透析记录，点击上方快速创建'"
      />
      <div v-for="[month, list] in grouped" :key="month" class="card" style="padding: 8px 14px">
        <div class="card-title" style="margin: 6px 0">{{ month }}</div>
        <div
          v-for="s in list"
          :key="s.id"
          style="padding: 10px 0; border-top: 1px solid #f2f3f5; cursor: pointer"
          @click="router.push(`/session/${s.id}`)"
        >
          <div class="row">
            <span class="num">{{ formatDateCN(s.date) }}</span>
            <van-tag :type="SESSION_STATUS_TAG[s.status]">{{ SESSION_STATUS_LABEL[s.status] }}</van-tag>
          </div>
          <div class="muted" style="margin-top: 4px">
            上机前实际 <span class="num">{{ fmt(summary(s).preWeightActual) }}</span> kg
            <template v-if="summary(s).planUf != null">
              · 计划脱水 <span class="num">{{ fmt(summary(s).planUf) }}</span> L
            </template>
            <template v-if="s.operator"> · {{ s.operator }}</template>
          </div>
          <div v-if="s.status === 'aborted'" class="muted abort-line">
            中止：{{ abortText(s.abortTags, s.abortReason) || '未填写原因' }}
          </div>
        </div>
      </div>
    </template>

    <!-- 新建确认弹窗 -->
    <van-dialog
      v-model:show="showNewDialog"
      title="新建记录"
      show-cancel-button
      confirm-button-text="创建"
      cancel-button-text="取消"
      confirm-button-color="#07c160"
      @confirm="doNewBlank"
    >
      <div class="new-dialog-body">
        <div class="new-dialog-title">将创建一条空白透析记录</div>
        <div class="new-dialog-sub">稍后可在详情页补充体重、血压、血糖等信息</div>
      </div>
    </van-dialog>
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
/* 加载失败态（H5） */
.load-error {
  text-align: center;
  padding: 20px 14px;
}
.load-error-text {
  font-size: 14px;
  color: #646566;
  margin-bottom: 12px;
}
.quick-card {
  background: linear-gradient(135deg, #07c160, #05a84f);
  border-radius: 16px;
  padding: 18px 18px 16px;
  margin-bottom: 14px;
  color: #fff;
  box-shadow: 0 8px 20px rgba(7, 193, 96, 0.28);
}
.quick-title {
  font-size: 15px;
  font-weight: 700;
}
.quick-label {
  font-size: 13px;
  opacity: 0.88;
  margin-top: 12px;
}
.quick-input-wrap {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 10px;
  margin: 4px 0 14px;
}
.quick-input {
  width: 170px;
  background: transparent;
  border: none;
  border-bottom: 2px solid rgba(255, 255, 255, 0.7);
  font-size: 44px;
  font-weight: 700;
  color: #fff;
  text-align: center;
  outline: none;
  line-height: 1.2;
}
.quick-input::placeholder {
  color: rgba(255, 255, 255, 0.45);
}
.quick-unit {
  font-size: 18px;
  font-weight: 600;
}
.quick-stats {
  display: flex;
  gap: 10px;
  margin-bottom: 14px;
}
.stat {
  flex: 1;
  background: rgba(255, 255, 255, 0.18);
  border-radius: 12px;
  padding: 12px 6px;
  text-align: center;
}
.stat-label {
  font-size: 12px;
  opacity: 0.92;
}
.stat-value {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.2;
}
.stat-value small {
  font-size: 13px;
  font-weight: 500;
  opacity: 0.85;
}
.quick-hint {
  text-align: center;
  padding: 14px 0;
  font-size: 13px;
  opacity: 0.92;
  margin-bottom: 14px;
}
.quick-btn {
  width: 100%;
  background: #fff;
  color: #07c160;
  border: none;
  border-radius: 12px;
  padding: 12px 0;
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
}
.quick-btn:active {
  opacity: 0.9;
}
/* 创建中（H3）：按钮在提交期间禁用，配合文案「创建中…」给出可见反馈 */
.quick-btn:disabled {
  opacity: 0.65;
  cursor: default;
}
.patient-card {
  padding: 16px;
}
.patient-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.avatar {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: linear-gradient(135deg, #07c160, #05a84f);
  color: #fff;
  font-size: 20px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: 0 3px 8px rgba(7, 193, 96, 0.3);
}
.patient-name {
  font-size: 17px;
  font-weight: 700;
  color: #323233;
}
.age-badge {
  margin-left: auto;
  background: #e8f7ef;
  color: #07c160;
  font-size: 12px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
}
.patient-divider {
  height: 1px;
  background: #f2f3f5;
  margin: 12px 0;
}
.patient-stats {
  display: flex;
}
.pstat {
  flex: 1;
  text-align: center;
}
.pstat + .pstat {
  border-left: 1px solid #f2f3f5;
}
.pstat-v {
  font-size: 20px;
  font-weight: 700;
  color: #323233;
  line-height: 1.2;
}
.pstat-v small {
  font-size: 11px;
  font-weight: 500;
  color: #969799;
  margin-left: 2px;
}
.pstat-l {
  font-size: 12px;
  color: #969799;
  margin-top: 4px;
}
.new-dialog-body {
  text-align: center;
  padding: 8px 4px 4px;
}
.new-dialog-title {
  font-size: 16px;
  font-weight: 600;
  color: #323233;
}
.new-dialog-sub {
  font-size: 13px;
  color: #969799;
  margin-top: 8px;
}
.abort-line {
  margin-top: 2px;
  color: #ee0a24;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

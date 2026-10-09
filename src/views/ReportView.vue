<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast } from 'vant'
import html2canvas from 'html2canvas'
import { Capacitor } from '@capacitor/core'
import { Share } from '@capacitor/share'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { repository } from '../repo'
import { reactionLabel, SESSION_STATUS_LABEL, abortText } from '../constants'
import { currentPatientId } from '../stores/patient'
import { cacheVersion } from '../lib/cloudCache'
import { fmt, formatTime, calcAge, formatDateTimeCN } from '../utils/format'
import { computeSession, getEffectiveDryWeight } from '../utils/calc'
import { assessBp, assessGlucose } from '../utils/assess'
import BaseChart from '../components/BaseChart.vue'
import type { DialysisSession, Patient, DryWeight, BloodPressure, BloodGlucose, BloodFlow, AdverseReaction } from '../types'

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
const reportEl = ref<HTMLDivElement>()

/** 首次加载（本机还没有缓存）时的骨架占位 */
const loading = ref(true)
/** 加载失败（网络/权限/服务端报错）——与「确实没有这条记录」是两码事 */
const loadError = ref(false)
/** 分享进行中：防连点（html2canvas 很重，连点会并发跑多次） */
const sharing = ref(false)

onMounted(load)

// 报告页是纯展示页，缓存后台刷新完成后自动重读，无需用户手动刷新
watch(cacheVersion, () => {
  void load()
})

async function load() {
  const pid = currentPatientId.value
  loadError.value = false
  try {
    // 七个请求并行发出（原来串行，要等七次网络往返）
    const [s, p, dw, bp, bg, bf, ar] = await Promise.all([
      repository.getSession(sessionId),
      repository.getPatient(pid),
      repository.listDryWeights(pid),
      repository.listBloodPressures(sessionId),
      repository.listBloodGlucoses(sessionId),
      repository.listBloodFlows(sessionId),
      repository.listAdverseReactions(sessionId),
    ])
    session.value = s ?? null
    if (!session.value) {
      // 读接口查询失败会抛错（走 catch），能走到这里就是「确实不存在」→ 回首页
      router.replace('/')
      return
    }
    patient.value = p ?? null
    dryWeights.value = dw
    bps.value = bp
    glucoses.value = bg
    flows.value = bf
    reactions.value = ar
  } catch (err) {
    // 加载失败就停在页面上给重试，绝不能当成「记录不存在」静默跳回首页（用户会以为记录丢了）
    console.error(err)
    loadError.value = true
    // 已经有渲染好的报告时（后台刷新失败），保留旧报告只提示一句，别把内容换成一屏错误
    if (session.value) showToast('报告刷新失败，请检查网络后重试')
  } finally {
    loading.value = false // 抛错也一定要收掉骨架，否则页面永久转圈
  }
}

const comp = computed(() => {
  if (!session.value) return null
  const dry = getEffectiveDryWeight(dryWeights.value, session.value.date)
  return computeSession(session.value, dry)
})

/** 致命错误：一条记录都没加载出来（后台刷新失败但已有报告时不算） */
const blockingError = computed(() => loadError.value && !session.value)

// 医生设定脱水量（存储为 ml，报告按 L 展示）
const doctorUfL = computed(() => (session.value?.doctorUf != null ? session.value.doctorUf / 1000 : null))

const reactionText = computed(() => {
  if (!reactions.value.length) return '无'
  return reactions.value
    .map((r) => (r.type === 'other' && r.detail ? `${r.detail}` : reactionLabel(r.type)))
    .join('、')
})

const bpOption = computed(() => ({
  tooltip: { trigger: 'axis' },
  legend: { top: 0, left: 'center', itemGap: 14, itemWidth: 16, itemHeight: 10, textStyle: { fontSize: 12 }, data: ['高压', '低压'] },
  grid: { left: 42, right: 20, top: 48, bottom: 32 },
  xAxis: { type: 'category', data: bps.value.map((b) => formatTime(b.measuredAt)) },
  yAxis: { type: 'value', name: 'mmHg' },
  series: [
    { name: '高压', type: 'line', smooth: true, color: '#ee0a24', data: bps.value.map((b) => b.systolic) },
    { name: '低压', type: 'line', smooth: true, color: '#1989fa', data: bps.value.map((b) => b.diastolic) },
  ],
}))

const abortSummary = computed(() => abortText(session.value?.abortTags, session.value?.abortReason))

const summaryText = computed(() => {
  const c = comp.value
  const name = patient.value?.name ?? ''
  const date = session.value?.date ?? ''
  const status = session.value ? SESSION_STATUS_LABEL[session.value.status] : ''
  const abort =
    session.value?.status === 'aborted'
      ? `\n状态：已中止${session.value.abortedAt ? `（${formatDateTimeCN(session.value.abortedAt)}）` : ''}，中止原因：${
          abortSummary.value || '未填写'
        }`
      : ''
  return (
    `透析报告 ${name} ${date}（${status}）\n` +
    `上机前 ${fmt(c?.preWeightActual)}kg，下机后 ${fmt(c?.postWeightActual)}kg，干体重 ${fmt(c?.effectiveDryWeight)}kg\n` +
    `医生设定脱水 ${fmt(doctorUfL.value)}L，计划脱水 ${fmt(c?.planUf)}L，实际脱水 ${fmt(c?.actualUf)}L，回水 ${c?.rinseBackMl ?? ''}ml\n` +
    `不良反应：${reactionText.value}` +
    abort
  )
})

const isNative = Capacitor.isNativePlatform()

function reportFilename(): string {
  return `透析报告-${session.value?.date ?? ''}.png`
}

async function capture(): Promise<HTMLCanvasElement> {
  if (!reportEl.value) throw new Error('no element')
  return Promise.race([
    html2canvas(reportEl.value, { scale: 2, backgroundColor: '#ffffff', useCORS: true }),
    new Promise<HTMLCanvasElement>((_, reject) => setTimeout(() => reject(new Error('截图超时')), 15000)),
  ])
}

function downloadDataUrl(url: string, name: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
}

/** 分享入口可用状态：骨架期 / 加载失败 / 正在分享 都不可点 */
const shareDisabled = computed(() => loading.value || blockingError.value || sharing.value)

/**
 * 当前浏览器能不能分享「图片文件」。
 * canShare 不存在或不认 files 时都为 false —— 这时不能静默降级成「只发一段文字」。
 */
function canShareImage(file: File): boolean {
  const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean }
  if (typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false
  try {
    return nav.canShare({ files: [file] })
  } catch {
    return false
  }
}

async function writeImageNative(): Promise<string> {
  const canvas = await capture()
  const base64 = canvas.toDataURL('image/png').split(',')[1] ?? ''
  const res = await Filesystem.writeFile({
    path: reportFilename(),
    data: base64,
    directory: Directory.Cache,
    recursive: true,
  })
  return res.uri
}

async function share() {
  if (shareDisabled.value) return // 防连点：重复进来说明界面还没就绪
  sharing.value = true
  try {
    if (isNative) {
      const uri = await writeImageNative()
      await Share.share({ title: '透析报告', text: summaryText.value, files: [uri] })
    } else {
      const canvas = await capture()
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('生成图片失败'))), 'image/png')
      })
      const file = new File([blob], reportFilename(), { type: 'image/png' })
      if (canShareImage(file)) {
        await navigator.share({ files: [file], title: '透析报告', text: summaryText.value })
      } else {
        // 浏览器不支持分享图片：退化为下载图片 + 明确告知，
        // 不能静默降级成「只发一段文字」，用户会以为图片发出去了。
        downloadDataUrl(canvas.toDataURL('image/png'), reportFilename())
        showToast(
          typeof navigator.share === 'function'
            ? '当前浏览器不支持分享图片，已下载报告图片，可从下载目录发送'
            : '报告图片已下载，可从下载目录发送给医生',
        )
      }
    }
  } catch (err) {
    // 用户主动取消（AbortError）与真正的失败要分开说，但都不能静默
    console.error(err)
    if ((err as { name?: string } | null)?.name === 'AbortError') showToast('已取消分享')
    else showToast('分享失败，请检查网络后重试')
  } finally {
    sharing.value = false
  }
}
</script>

<template>
  <div class="page">
    <van-nav-bar class="no-print" title="透析报告" left-text="返回" left-arrow @click-left="router.back()">
      <template #right>
        <!-- 骨架期/加载失败/正在分享时不给点：点了也是白点，还会并发跑多次截图 -->
        <van-icon
          v-if="!shareDisabled"
          name="share-o"
          size="22"
          color="#07c160"
          style="cursor: pointer"
          @click="share"
        />
        <van-icon v-else name="share-o" size="22" color="#c8c9cc" style="cursor: not-allowed" />
      </template>
    </van-nav-bar>

    <!-- 首次加载（本机还没有缓存）时显示骨架，避免白屏干等 -->
    <div v-if="loading" class="card" style="margin-top: 12px">
      <van-skeleton title :row="8" />
    </div>

    <!-- 加载失败：停在页面给重试，不要静默跳回首页（用户会以为记录没了） -->
    <div v-if="!loading && blockingError" class="card" style="margin-top: 12px">
      <van-empty image="error" description="报告加载失败，请检查网络后重试">
        <van-button type="primary" round size="small" @click="load">重试</van-button>
      </van-empty>
    </div>

    <template v-if="!loading && !blockingError">
    <div ref="reportEl" style="background: #fff; border-radius: 10px; padding: 16px">
      <div style="text-align: center; margin-bottom: 14px">
        <div style="font-size: 18px; font-weight: 700">透析报告</div>
        <div class="muted" style="margin-top: 4px">
          {{ patient?.name }} · {{ session?.date }}<template v-if="session?.operator"> · 记录人 {{ session.operator }}</template>
        </div>
        <div v-if="patient?.birthday" class="muted">
          年龄约 {{ calcAge(patient.birthday) ?? '—' }} 岁
        </div>
        <div v-if="session" class="report-status" :class="session.status">
          {{ SESSION_STATUS_LABEL[session.status] }}
        </div>
      </div>

      <div v-if="session?.status === 'aborted'" class="report-abort">
        <div class="report-abort-title">本次透析已中止</div>
        <div v-if="session.abortedAt">中止时间：{{ formatDateTimeCN(session.abortedAt) }}</div>
        <div>中止原因：{{ abortSummary || '未填写' }}</div>
      </div>

      <div class="report-flow">
        <div class="rnode">
          <div class="rlabel">上机前体重</div>
          <div class="rval">{{ fmt(comp?.preWeightActual) }}<small>kg</small></div>
        </div>
        <div class="rmid">
          <div class="rarrow">↓</div>
          <div v-if="comp?.actualUf != null" class="rdiff">脱 {{ fmt(comp.actualUf) }}L</div>
        </div>
        <div class="rnode">
          <div class="rlabel">下机后体重</div>
          <div class="rval">{{ fmt(comp?.postWeightActual) }}<small>kg</small></div>
        </div>
      </div>
      <div class="report-uf">
        <div class="ruf"><span>医生设定脱水量</span><b>{{ fmt(doctorUfL) }} L</b></div>
        <div class="ruf"><span>计划脱水量</span><b>{{ fmt(comp?.planUf) }} L</b></div>
        <div class="ruf"><span>实际脱水量</span><b>{{ fmt(comp?.actualUf) }} L</b></div>
      </div>
      <div class="report-meta">干体重 {{ fmt(comp?.effectiveDryWeight) }}kg · 回水 {{ comp?.rinseBackMl ?? '—' }}ml · 机器超滤 {{ fmt(comp?.machineUf) }}L</div>

      <div style="height: 1px; background: #ebedf0; margin: 14px 0"></div>
      <div class="card-title" style="margin-bottom: 6px">血压曲线</div>
      <BaseChart v-if="bps.length" :option="bpOption" />
      <div v-else class="muted" style="padding: 10px 0">暂无血压记录</div>
      <div v-if="bps.length" style="margin-top: 6px">
        <div v-for="bp in bps" :key="bp.id" class="kv">
          <span class="k">{{ formatTime(bp.measuredAt) }}</span>
          <span class="v">{{ bp.systolic }} / {{ bp.diastolic }} mmHg
            <van-tag :type="assessBp(bp.systolic, bp.diastolic).color" style="margin-left: 6px">{{ assessBp(bp.systolic, bp.diastolic).text }}</van-tag>
          </span>
        </div>
      </div>

      <div style="height: 1px; background: #ebedf0; margin: 14px 0"></div>
      <div class="kv">
        <span class="k">血糖</span>
        <span class="v">{{ glucoses.length ? `${fmt(glucoses[0].value)} mmol/L` : '—' }}
          <van-tag v-if="glucoses.length" :type="assessGlucose(glucoses[0].value).color" style="margin-left: 6px">{{ assessGlucose(glucoses[0].value).text }}</van-tag>
        </span>
      </div>
      <div v-if="flows.length" style="margin: 8px 0 0">
        <div class="muted" style="margin-bottom: 4px">血流量</div>
        <div v-for="f in flows" :key="f.id" class="kv">
          <span class="k">{{ formatTime(f.measuredAt) }}</span>
          <span class="v">{{ f.value }} ml/min</span>
        </div>
      </div>
      <div class="kv">
        <span class="k">不良反应</span>
        <span class="v">{{ reactionText }}</span>
      </div>
      <div v-if="session?.notes" class="muted" style="margin-top: 8px">备注：{{ session.notes }}</div>
    </div>
    </template>
  </div>
</template>

<style scoped>
.report-flow {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #f7f8fa;
  border-radius: 12px;
  padding: 12px;
  margin-bottom: 12px;
}
.rnode {
  flex: 1;
  text-align: center;
}
.rlabel {
  font-size: 12px;
  color: #969799;
}
.rval {
  font-size: 22px;
  font-weight: 700;
  color: #323233;
}
.rval small {
  font-size: 12px;
  font-weight: 500;
  color: #969799;
  margin-left: 2px;
}
.rmid {
  text-align: center;
  min-width: 56px;
}
.rarrow {
  font-size: 20px;
  color: #07c160;
  line-height: 1;
}
.rdiff {
  font-size: 12px;
  color: #07c160;
  font-weight: 600;
  margin-top: 2px;
}
.report-uf {
  display: flex;
  gap: 10px;
  margin-bottom: 10px;
}
.ruf {
  flex: 1;
  background: #e8f7ef;
  border-radius: 12px;
  padding: 12px 6px;
  text-align: center;
}
.ruf span {
  display: block;
  font-size: 12px;
  color: #07c160;
}
.ruf b {
  font-size: 22px;
  font-weight: 700;
  color: #07c160;
}
.report-meta {
  font-size: 12px;
  color: #969799;
  text-align: center;
}
.report-status {
  display: inline-block;
  margin-top: 6px;
  padding: 2px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}
.report-status.ongoing {
  color: #ed6a0c;
  background: #fff4e8;
}
.report-status.completed {
  color: #07c160;
  background: #e8f7ef;
}
.report-status.aborted {
  color: #ee0a24;
  background: #ffecec;
}
.report-abort {
  background: #fff5f5;
  border: 1px solid #ffd9d9;
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 12px;
  font-size: 13px;
  color: #323233;
  line-height: 1.6;
}
.report-abort-title {
  font-weight: 700;
  color: #ee0a24;
}
</style>

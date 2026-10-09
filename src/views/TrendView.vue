<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { repository } from '../repo'
import { currentPatientId } from '../stores/patient'
import { cacheVersion } from '../lib/cloudCache'
import { formatTime } from '../utils/format'
import { computeSession, getEffectiveDryWeight } from '../utils/calc'
import BaseChart from '../components/BaseChart.vue'
import type { DryWeight, DialysisSession } from '../types'

const active = ref(0)
const dryWeights = ref<DryWeight[]>([])
const sessions = ref<DialysisSession[]>([])
const bpTrend = ref<{ time: number; date: string; systolic: number; diastolic: number }[]>([])
const gluTrend = ref<{ time: number; date: string; value: number }[]>([])

/** 首次加载（本机还没有缓存）时的骨架占位 */
const loading = ref(true)
/** 主数据（干体重 / 记录）加载失败 —— 与「确实没有数据」是两码事，必须分开显示 */
const loadError = ref(false)
/** 血压 / 血糖趋势加载失败（只影响对应页签） */
const bpError = ref(false)
const gluError = ref(false)
const retrying = ref(false)

onMounted(load)

// 纯展示页：缓存后台刷新完成后自动重读
watch(cacheVersion, () => {
  void load()
})

async function load() {
  const pid = currentPatientId.value
  try {
    const [dw, ss] = await Promise.all([repository.listDryWeights(pid), repository.listSessions(pid)])
    dryWeights.value = dw
    sessions.value = ss
    loadError.value = false
  } catch (err) {
    // 读接口查询失败会抛错（不再静默返回空）：失败要能重试，不能显示成「暂无数据」
    console.error(err)
    loadError.value = true
    return
  } finally {
    loading.value = false // 抛错也要收掉骨架，否则页面永久白等
  }
  await Promise.all([loadBpTrend(), loadGlucoseTrend()])
}

/** 失败后手动重试（按钮上带 loading，避免连点并发再打一轮请求） */
async function retry() {
  if (retrying.value) return
  retrying.value = true
  try {
    await load()
  } finally {
    retrying.value = false
  }
}

async function loadBpTrend() {
  const recent = sessions.value.slice(0, 30)
  try {
    // 原来是每条记录串行拉一次血压（30 条 = 30 次往返），改成全部并行
    const lists = await Promise.all(recent.map((s) => repository.listBloodPressures(s.id)))
    const all: { time: number; date: string; systolic: number; diastolic: number }[] = []
    recent.forEach((s, i) => {
      for (const bp of lists[i]) {
        all.push({ time: bp.measuredAt, date: s.date, systolic: bp.systolic, diastolic: bp.diastolic })
      }
    })
    all.sort((a, b) => a.time - b.time)
    bpTrend.value = all
    bpError.value = false
  } catch (err) {
    console.error(err)
    bpError.value = true
  }
}

async function loadGlucoseTrend() {
  const recent = sessions.value.slice(0, 30)
  try {
    const lists = await Promise.all(recent.map((s) => repository.listBloodGlucoses(s.id)))
    const all: { time: number; date: string; value: number }[] = []
    recent.forEach((s, i) => {
      for (const g of lists[i]) {
        all.push({ time: g.measuredAt, date: s.date, value: g.value })
      }
    })
    all.sort((a, b) => a.time - b.time)
    gluTrend.value = all
    gluError.value = false
  } catch (err) {
    console.error(err)
    gluError.value = true
  }
}

/**
 * 数值轴自适应：默认让 Y 轴贴合实际数据范围（不强制包含 0）。
 * 否则体重 40~55kg、血糖 5~12mmol/L 这类窄区间，在一根从 0 起的轴里几乎看不出变化。
 * 数据本身几乎不波动时（如只有干体重线、单次血压）改用固定视窗，
 * 避免把 0.1kg / 1mmHg 的正常误差放大成「剧烈起伏」的假象。
 * 注意：windowSpan 必须是 interval 的整数倍，配合 mid 取整，刻度才落在整齐数值上。
 */
function autoValueAxis(
  values: (number | null)[],
  opt: { name: string; flatSpan: number; windowSpan: number; interval: number },
) {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const axis: Record<string, unknown> = { type: 'value', name: opt.name, scale: true }
  if (nums.length) {
    const lo = Math.min(...nums)
    const hi = Math.max(...nums)
    if (hi - lo < opt.flatSpan) {
      const mid = Math.round((lo + hi) / 2)
      axis.min = mid - opt.windowSpan / 2
      axis.max = mid + opt.windowSpan / 2
      axis.interval = opt.interval
    }
  }
  return axis
}

/** tooltip 里的数值统一带上单位 */
function withUnit(unit: string) {
  return (v: unknown) => (typeof v === 'number' ? `${v} ${unit}` : '—')
}

const weightOption = computed(() => {
  const recent = [...sessions.value].sort((a, b) => a.date.localeCompare(b.date)).slice(-30)
  const dates = recent.map((s) => s.date.slice(5))
  const pre = recent.map((s) => computeSession(s, getEffectiveDryWeight(dryWeights.value, s.date)).preWeightActual)
  const post = recent.map((s) => computeSession(s, getEffectiveDryWeight(dryWeights.value, s.date)).postWeightActual)
  const dry = recent.map((s) => getEffectiveDryWeight(dryWeights.value, s.date))
  return {
    tooltip: { trigger: 'axis', valueFormatter: withUnit('kg') },
    legend: { top: 0, left: 'center', itemGap: 14, itemWidth: 16, itemHeight: 10, textStyle: { fontSize: 12 }, data: ['上机前', '下机后', '干体重'] },
    grid: { left: 42, right: 20, top: 48, bottom: 32 },
    xAxis: { type: 'category', data: dates },
    yAxis: autoValueAxis([...pre, ...post, ...dry], { name: 'kg', flatSpan: 3, windowSpan: 4, interval: 1 }),
    series: [
      { name: '上机前', type: 'line', smooth: true, color: '#ee0a24', data: pre },
      { name: '下机后', type: 'line', smooth: true, color: '#1989fa', data: post },
      { name: '干体重', type: 'line', smooth: true, color: '#07c160', data: dry, lineStyle: { type: 'dashed' } },
    ],
  }
})

const bpOption = computed(() => ({
  tooltip: { trigger: 'axis', valueFormatter: withUnit('mmHg') },
  legend: { top: 0, left: 'center', itemGap: 14, itemWidth: 16, itemHeight: 10, textStyle: { fontSize: 12 }, data: ['高压', '低压'] },
  grid: { left: 42, right: 20, top: 48, bottom: 66 },
  xAxis: { type: 'category', data: bpTrend.value.map((b) => `${b.date.slice(5)} ${formatTime(b.time)}`), axisLabel: { rotate: 30 } },
  yAxis: autoValueAxis(bpTrend.value.flatMap((b) => [b.systolic, b.diastolic]), { name: 'mmHg', flatSpan: 20, windowSpan: 40, interval: 10 }),
  series: [
    { name: '高压', type: 'line', smooth: true, color: '#ee0a24', data: bpTrend.value.map((b) => b.systolic) },
    { name: '低压', type: 'line', smooth: true, color: '#1989fa', data: bpTrend.value.map((b) => b.diastolic) },
  ],
}))

const gluOption = computed(() => ({
  tooltip: { trigger: 'axis', valueFormatter: withUnit('mmol/L') },
  legend: { top: 0, left: 'center', itemGap: 14, itemWidth: 16, itemHeight: 10, textStyle: { fontSize: 12 }, data: ['血糖'] },
  grid: { left: 42, right: 20, top: 48, bottom: 66 },
  xAxis: { type: 'category', data: gluTrend.value.map((g) => `${g.date.slice(5)} ${formatTime(g.time)}`), axisLabel: { rotate: 30 } },
  yAxis: autoValueAxis(gluTrend.value.map((g) => g.value), { name: 'mmol/L', flatSpan: 2, windowSpan: 4, interval: 1 }),
  series: [
    { name: '血糖', type: 'line', smooth: true, color: '#ee0a24', symbol: 'circle', symbolSize: 8, data: gluTrend.value.map((g) => g.value) },
  ],
}))
</script>

<template>
  <div class="page">
    <van-nav-bar title="趋势分析" :border="false" />

    <!-- 首次加载（本机还没有缓存）时显示骨架，避免白屏干等 -->
    <div v-if="loading" class="card" style="margin-top: 12px">
      <van-skeleton title :row="8" />
    </div>

    <!-- 加载失败：和「暂无数据」分开显示，并给重试入口（失败不等于没数据） -->
    <div v-if="!loading && loadError" class="card" style="margin-top: 12px">
      <van-empty image="error" description="趋势数据加载失败，请检查网络后重试">
        <van-button type="primary" round size="small" :loading="retrying" :disabled="retrying" @click="retry">
          重试
        </van-button>
      </van-empty>
    </div>

    <template v-if="!loading && !loadError">
    <van-tabs v-model:active="active">
      <van-tab title="体重">
        <div class="card" style="margin-top: 12px">
          <div class="card-title">体重趋势（近 30 次）</div>
          <BaseChart v-if="sessions.length" :option="weightOption" />
          <van-empty v-else description="暂无数据" />
        </div>
      </van-tab>
      <van-tab title="血压">
        <div class="card" style="margin-top: 12px">
          <div class="card-title">血压趋势（近 30 次）</div>
          <template v-if="bpError">
            <van-empty image="error" description="血压数据加载失败">
              <van-button size="small" type="primary" plain :loading="retrying" :disabled="retrying" @click="retry">
                重试
              </van-button>
            </van-empty>
          </template>
          <BaseChart v-else-if="bpTrend.length" :option="bpOption" />
          <van-empty v-else description="暂无血压数据" />
        </div>
      </van-tab>
      <van-tab title="血糖">
        <div class="card" style="margin-top: 12px">
          <div class="card-title">血糖趋势（近 30 次）</div>
          <template v-if="gluError">
            <van-empty image="error" description="血糖数据加载失败">
              <van-button size="small" type="primary" plain :loading="retrying" :disabled="retrying" @click="retry">
                重试
              </van-button>
            </van-empty>
          </template>
          <BaseChart v-else-if="gluTrend.length" :option="gluOption" />
          <van-empty v-else description="暂无血糖数据" />
        </div>
      </van-tab>
    </van-tabs>
    </template>
  </div>
</template>

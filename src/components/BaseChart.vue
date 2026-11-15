<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import * as echarts from 'echarts'

const props = defineProps<{ option: any }>()
const el = ref<HTMLDivElement>()
let chart: ReturnType<typeof echarts.init> | null = null
let ro: ResizeObserver | null = null

/**
 * 上一次渲染的「图表结构指纹」：series 的名字列表 + y 轴数量。
 *
 * ⚠️ 为什么需要它：`chart.setOption(option)` 默认是**合并**语义 —— 新 option 里
 * 只给 2 条 series 时，ECharts 不会删掉第 3 条，它会**留着**。
 * 真实后果（评审实测）：报告页有 3 条血压、只有第 2 条填了心率 → 删掉第 2 条 →
 * `hasBpPulse` 变 false、option 变成单轴 2 条 series → 但图上仍残留那条心率曲线
 * 和一根空的 bpm 副轴：x 轴只有 2 个点，心率却有 3 个点，医生看到的图与明细对不上。
 *
 * 修法：结构变了就 `notMerge` 重建（否则残留）；结构没变就走合并（保留平滑动画）。
 */
function structureKey(option: any): string {
  const series = Array.isArray(option?.series) ? option.series : option?.series ? [option.series] : []
  const names = series.map((s: any) => String(s?.name ?? s?.type ?? '')).join('|')
  const axisCount = Array.isArray(option?.yAxis) ? option.yAxis.length : option?.yAxis ? 1 : 0
  return `${series.length}#${axisCount}#${names}`
}

let lastKey: string | null = null

function render() {
  if (!chart && el.value) {
    chart = echarts.init(el.value)
  }
  if (!chart) return
  const key = structureKey(props.option)
  // 首次渲染或结构变化 → 整体替换；结构不变 → 合并更新（保留动画、避免闪一下）
  const notMerge = lastKey === null || lastKey !== key
  chart.setOption(props.option, { notMerge })
  lastKey = key
}

function resize() {
  chart?.resize()
}

onMounted(() => {
  render()
  window.addEventListener('resize', resize)
  if (el.value && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => resize())
    ro.observe(el.value)
  }
})

watch(
  () => props.option,
  () => render(),
  { deep: true },
)

onBeforeUnmount(() => {
  window.removeEventListener('resize', resize)
  ro?.disconnect()
  ro = null
  chart?.dispose()
  chart = null
  lastKey = null
})
</script>

<template>
  <div ref="el" style="width: 100%; height: 300px"></div>
</template>

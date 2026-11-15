/**
 * ECharts tooltip 的公共格式化工具。
 *
 * 为什么单独抽出来：血压图的「心率副轴」在**趋势页**和**报告页**各有一份实现，
 * 两处都必须按 series 名分别加单位（mmHg / bpm）。历史教训是两处各写一遍、只改了一处，
 * 或者用错 API —— 见 `dualAxisTooltip` 的注释。
 */

/** tooltip 回调里单个 series 的片段（ECharts 传给 formatter 的 params 项） */
interface TooltipParam {
  seriesName?: string
  value?: unknown
  axisValueLabel?: string
  marker?: string
}

/** 单轴 tooltip 的单位格式化（`valueFormatter` 的签名确实是 `(value) => string`） */
export function withUnit(unit: string) {
  return (v: unknown) => (typeof v === 'number' ? `${v} ${unit}` : '—')
}

/**
 * 双轴（血压 mmHg + 心率 bpm）的 tooltip 格式化。
 *
 * ⚠️ **不能用 `valueFormatter` 来区分 series**。ECharts 的签名是
 * `valueFormatter(value, dataIndex: number)` —— 第二个参数是**数据下标**，不是 params 对象。
 * 曾经写成 `(v, params) => params?.seriesName === '心率' ? 'bpm' : 'mmHg'`，
 * `params` 恒为数字 → `seriesName` 恒 undefined → 心率被标成「76 mmHg」，
 * 护士会把心率当血压读（量纲错误）。而当时的用例只对源码做正则断言，抓不住。
 *
 * `tooltip.formatter` 收到的才是完整 params 数组，每项都带 `seriesName` / `value` / `marker`。
 */
export function dualAxisTooltip(params: unknown): string {
  const list = Array.isArray(params) ? params : [params]
  const lines = list
    .map((p) => {
      const item = p as TooltipParam
      const v = item.value
      if (typeof v !== 'number') return ''
      const unit = item.seriesName === '心率' ? 'bpm' : 'mmHg'
      return `${item.marker ?? ''}${item.seriesName ?? ''} ${v} ${unit}`
    })
    .filter(Boolean)
  const head = (list[0] as TooltipParam | undefined)?.axisValueLabel ?? ''
  return [head, ...lines].filter(Boolean).join('<br/>')
}

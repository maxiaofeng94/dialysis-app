export function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

export function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function nowTs(): number {
  return Date.now()
}

export function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 解析 `YYYY-MM-DD` 为本地零点的 Date；**日期不存在时返回 null**。
 *
 * 为什么要自己校验：`new Date('2024-02-30T00:00:00')` 不会报错，
 * 引擎会把它滚成 3 月 1 日 —— 于是一个手输错的生日会被当成另一天显示出来。
 * 这里对 `YYYY-MM-DD` 形态做「回读一致性」检测（年/月/日必须与输入一致）。
 */
export function parseLocalDate(date: string): Date | null {
  if (!date) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) {
    // 非标准形态（例如带时间的 ISO 串）交给引擎解析，解析不出来就算非法
    const d = new Date(`${date}T00:00:00`)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const d = new Date(year, month - 1, day)
  const rolled =
    d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day
  return rolled ? null : d
}

export function formatDateCN(date: string): string {
  if (!date) return ''
  const d = parseLocalDate(date)
  // 非法或不存在的日期原样回显，让用户一眼看出「填错了」，而不是悄悄显示成另一天
  if (!d) return date
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  return `${d.getMonth() + 1}月${d.getDate()}日 ${week}`
}

/** 周岁；生日缺失/非法/在未来都返回 null（不显示负数年龄） */
export function calcAge(birthday: string): number | null {
  if (!birthday) return null
  const b = parseLocalDate(birthday)
  if (!b) return null
  const now = new Date()
  let age = now.getFullYear() - b.getFullYear()
  const m = now.getMonth() - b.getMonth()
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--
  return age < 0 ? null : age
}

/**
 * 数值展示。`null` / `undefined` / 非有限数（NaN、Infinity）统一显示「—」。
 *
 * 舍入口径与 `utils/calc.ts` 的 `round1` **保持一致**（都是 Math.round 半值向上），
 * 否则同一个数在「计算列」与「展示列」会差 0.1（负数半边尤其明显：-1.25 曾显示成 -1.3 而算出 -1.2）。
 */
export function fmt(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const factor = 10 ** digits
  return (Math.round(n * factor) / factor).toFixed(digits)
}

export function combineDateTime(date: string, time: string): number {
  const d = `${date || todayStr()}T${time || '00:00'}:00`
  const ts = new Date(d).getTime()
  return isNaN(ts) ? Date.now() : ts
}

/** 时间戳 → YYYY-MM-DD */
export function dateStr(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 时间戳 → YYYY-MM-DD HH:mm */
export function formatDateTimeCN(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function parseNum(s: string): number | null {
  if (s == null || s.trim() === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

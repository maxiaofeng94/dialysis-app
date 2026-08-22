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

export function formatDateCN(date: string): string {
  if (!date) return ''
  const d = new Date(`${date}T00:00:00`)
  if (isNaN(d.getTime())) return date
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  return `${d.getMonth() + 1}月${d.getDate()}日 ${week}`
}

export function calcAge(birthday: string): number | null {
  if (!birthday) return null
  const b = new Date(`${birthday}T00:00:00`)
  if (isNaN(b.getTime())) return null
  const now = new Date()
  let age = now.getFullYear() - b.getFullYear()
  const m = now.getMonth() - b.getMonth()
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--
  return age
}

export function fmt(n: number | null | undefined, digits = 1): string {
  if (n == null) return '—'
  return n.toFixed(digits)
}

export function combineDateTime(date: string, time: string): number {
  const d = `${date || todayStr()}T${time || '00:00'}:00`
  const ts = new Date(d).getTime()
  return isNaN(ts) ? Date.now() : ts
}

export function parseNum(s: string): number | null {
  if (s == null || s.trim() === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

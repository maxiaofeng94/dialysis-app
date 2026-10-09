/**
 * 无 crypto.randomUUID 环境（老 WebView / 非安全上下文）下的回退序号。
 * `Math.random()` 极端为 0 时 `toString(36).slice(2,10)` 会是空串，
 * 同毫秒内连续两次调用就会生成同一个 id（新建记录时可能互相覆盖）。
 */
let fallbackSeq = 0

export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const stamp = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 10)
  if (rand) return `${stamp}-${rand}`
  // 兜底：随机后缀为空时用递增序号，保证同毫秒内也不会重复
  fallbackSeq += 1
  return `${stamp}-${fallbackSeq.toString(36).padStart(2, '0')}`
}

/**
 * 写入冲突与「记录已不存在」的专用错误。
 *
 * 为什么不用普通 Error：调用方需要**分辨**这两种情况才能给出正确的引导 ——
 * - 冲突（`ConflictError`）：编辑期间别人也保存了这条记录 → 让用户选「重新加载 / 覆盖保存」
 * - 记录没了（`NotFoundError`）：另一端把这条删了 → 只能告知并回首页，重试多少次都没用
 * 混在「保存失败，请检查网络后重试」里，用户会一直重试一个永远不会成功的操作。
 *
 * ⚠️ 判定用 `name` 而不是 `instanceof`：同一份代码可能被打进不同的 chunk
 * （App 主包 / 懒加载分包），跨 bundle 的 `instanceof` 会失效。
 */

export class ConflictError extends Error {
  constructor(message = '这条记录已被其他人修改') {
    super(message)
    this.name = 'ConflictError'
  }
}

export class NotFoundError extends Error {
  constructor(message = '这条记录已被删除') {
    super(message)
    this.name = 'NotFoundError'
  }
}

/**
 * 没有写权限 / 写入被 RLS 拦下。
 *
 * 为什么必须与 `ConflictError` 分开：RLS 的 UPDATE 是**静默过滤**（返回 0 行、error 为 null），
 * 而乐观锁的「版本不匹配」也是 0 行 —— 两者在返回值上完全一样。
 * 曾经一律判成「已被其他人修改」，于是：
 * - owner 把成员从 caregiver 降为 viewer（或弱网下拉角色失败、`currentRole` 被置空 = 不限制）；
 * - 该成员界面上仍可写，点保存 → 看到「重新加载 / 覆盖保存」；
 * - 点「覆盖保存」还是被 RLS 拒 → **白填一遍数据，而且归因完全错误**（真相是没有权限）。
 *
 * 区分方式：0 行时**再读一次那行的 `updated_at`** ——
 * 若与请求里带的版本**一致**（说明版本没变），却写不进去，那就只能是权限问题。
 */
export class PermissionError extends Error {
  constructor(message = '你没有修改这条内容的权限') {
    super(message)
    this.name = 'PermissionError'
  }
}

export function isConflictError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ConflictError'
}

export function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && err.name === 'NotFoundError'
}

export function isPermissionError(err: unknown): boolean {
  return err instanceof Error && err.name === 'PermissionError'
}

/**
 * PostgREST / PostgreSQL 的「结构不存在」错误码。
 *
 * 为什么需要它：曾经所有读失败都被归一成「加载失败，请检查网络后重试」，
 * 于是「生产库没执行 schema.sql」这种**服务端缺表**的问题，在用户界面上
 * 和「手机断网」长得一模一样，只能靠猜。
 *
 * 实测（生产库 vbamprkcwrpsazkyknjq，2026-11-15）：
 * - 缺表：`404 {"code":"PGRST205","message":"Could not find the table 'public.patient_change_logs'"}`
 * - 缺列：`400 {"code":"42703","message":"column blood_pressures.pulse does not exist"}`
 *
 * `PGRST205` 是 PostgREST 自己的「schema cache 里找不到这张表」，
 * `42P01` 是 PostgreSQL 的 `undefined_table`（直接跑 SQL 时报这个）。
 */
const SCHEMA_MISSING_CODES = ['PGRST205', '42P01', '42703'] as const

/** 从 supabase-js 抛出的错误对象里取 PostgREST / PG 错误码 */
export function errorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/** 服务端缺少表/列（生产库没执行 schema.sql）—— 重试多少次都不会好 */
export function isSchemaMissingError(err: unknown): boolean {
  const code = errorCode(err)
  return code !== null && (SCHEMA_MISSING_CODES as readonly string[]).includes(code)
}

/** RLS 拒绝（没有权限读/写） */
export function isRlsDeniedError(err: unknown): boolean {
  const code = errorCode(err)
  // 42501 = insufficient_privilege（PG）；PGRST301 = JWT 无效/过期
  return code === '42501' || code === 'PGRST301'
}

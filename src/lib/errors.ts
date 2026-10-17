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

export function isConflictError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ConflictError'
}

export function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && err.name === 'NotFoundError'
}

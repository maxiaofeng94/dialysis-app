/**
 * `src/lib/errors.ts` 的分类函数单测。
 *
 * 为什么必须有（第十二轮独立评审·轻微-2）：
 * 这四个 helper 是第十一轮「变更历史加载失败 / 心率保存报错」修复的**唯一分诊器** ——
 * 错误码判错，用户看到的提示就会退回「请检查网络后重试」（正是要修的病）。
 * 但评审实测：`isSchemaMissingError` / `isRlsDeniedError` / `errorCode` 在测试里**零引用**，
 * 三个错误码只覆盖了 1 个（PGRST205），`42P01` / `42703` / `PGRST301` 全无覆盖 ——
 * 把 `42703` 从数组里删掉、或让 `isRlsDeniedError` 漏掉某个码，不会有任何用例变红。
 */
import { describe, it, expect } from 'vitest'
import {
  errorCode,
  isSchemaMissingError,
  isRlsDeniedError,
  isSessionExpiredError,
  isMissingColumnError,
} from '../../src/lib/errors'

/** 造一个和 supabase-js 的 PostgrestError 同构的错误（Error 子类 + code） */
function pgError(code: string) {
  return Object.assign(new Error('pg error'), { code })
}

describe('errorCode', () => {
  it('取出 code 字符串', () => {
    expect(errorCode(pgError('42703'))).toBe('42703')
  })

  it('没有 code 时返回 null', () => {
    expect(errorCode(new Error('offline'))).toBe(null)
    expect(errorCode({ code: undefined })).toBe(null)
    expect(errorCode({ code: 123 })).toBe(null)
  })

  it('null / undefined / 原始值返回 null', () => {
    expect(errorCode(null)).toBe(null)
    expect(errorCode(undefined)).toBe(null)
    expect(errorCode('string error')).toBe(null)
    expect(errorCode(42)).toBe(null)
  })
})

describe('isSchemaMissingError（服务端缺表/缺列）', () => {
  it('PGRST205（PostgREST 找不到表）→ true', () => {
    expect(isSchemaMissingError(pgError('PGRST205'))).toBe(true)
  })

  it('42P01（PostgreSQL undefined_table）→ true', () => {
    expect(isSchemaMissingError(pgError('42P01'))).toBe(true)
  })

  it('42703（PostgreSQL undefined_column，心率那次就是这个）→ true', () => {
    expect(isSchemaMissingError(pgError('42703'))).toBe(true)
  })

  it('其它错误码 → false（不能把所有错误都说成缺表）', () => {
    expect(isSchemaMissingError(pgError('42501'))).toBe(false)
    expect(isSchemaMissingError(pgError('PGRST301'))).toBe(false)
    expect(isSchemaMissingError(pgError('23505'))).toBe(false)
  })

  it('普通网络错误 → false', () => {
    expect(isSchemaMissingError(new Error('fetch failed'))).toBe(false)
    expect(isSchemaMissingError(null)).toBe(false)
  })
})

describe('isMissingColumnError（缺列，与缺表区分文案）', () => {
  it('42703 → true', () => {
    expect(isMissingColumnError(pgError('42703'))).toBe(true)
  })

  it('缺表的码 → false', () => {
    expect(isMissingColumnError(pgError('PGRST205'))).toBe(false)
    expect(isMissingColumnError(pgError('42P01'))).toBe(false)
  })
})

describe('isRlsDeniedError（RLS 策略拒绝）', () => {
  it('42501（insufficient_privilege）→ true', () => {
    expect(isRlsDeniedError(pgError('42501'))).toBe(true)
  })

  /**
   * ⚠️ 第十二轮独立评审·轻微-3：`PGRST301` 是 JWT 无效/过期（**登录态失效**），
   * 不是「没有权限」。若归到 RLS，用户会被告知「请联系创建者要权限」，
   * 而实际只要重新登录 —— 把人引向完全错误的方向。
   */
  it('PGRST301（JWT 失效）不算 RLS 拒绝，归会话过期', () => {
    expect(isRlsDeniedError(pgError('PGRST301'))).toBe(false)
    expect(isSessionExpiredError(pgError('PGRST301'))).toBe(true)
  })

  it('缺表/缺列的码 → false', () => {
    expect(isRlsDeniedError(pgError('PGRST205'))).toBe(false)
    expect(isRlsDeniedError(pgError('42703'))).toBe(false)
  })

  it('普通网络错误 → false', () => {
    expect(isRlsDeniedError(new Error('offline'))).toBe(false)
  })
})

describe('isSessionExpiredError（登录态失效）', () => {
  it('PGRST301 → true', () => {
    expect(isSessionExpiredError(pgError('PGRST301'))).toBe(true)
  })

  it('其它码 → false', () => {
    expect(isSessionExpiredError(pgError('42501'))).toBe(false)
    expect(isSessionExpiredError(pgError('PGRST205'))).toBe(false)
    expect(isSessionExpiredError(new Error('offline'))).toBe(false)
  })
})

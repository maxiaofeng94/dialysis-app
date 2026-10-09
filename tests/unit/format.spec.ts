/**
 * src/utils/format.ts 单元测试
 *
 * 时间相关的函数全部依赖「本地时区 + 当前时间」，为了让断言在任何时区、任何日期都稳定，
 * 本文件统一用 fake timers 把「今天」钉死在 2024-06-15 10:30（本地时间），
 * 断言里的期望值也用 `new Date(y, m, d, h, min)` 以本地时间构造，而不是写死时间戳。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  pad,
  todayStr,
  nowTs,
  formatTime,
  formatDateCN,
  calcAge,
  fmt,
  combineDateTime,
  dateStr,
  formatDateTimeCN,
  parseNum,
  parseLocalDate,
} from '../../src/utils/format'
import { round1 } from '../../src/utils/calc'

/** 固定的「现在」：2024-06-15（周六）10:30 本地时间 */
const FIXED_NOW = new Date(2024, 5, 15, 10, 30, 0)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('pad', () => {
  it('个位数补零，10 及以上原样返回', () => {
    expect(pad(0)).toBe('00')
    expect(pad(9)).toBe('09')
    expect(pad(10)).toBe('10')
    expect(pad(23)).toBe('23')
    expect(pad(60)).toBe('60')
  })
})

describe('todayStr / nowTs', () => {
  it('todayStr 按本地日期输出，月/日补零', () => {
    expect(todayStr()).toBe('2024-06-15')

    vi.setSystemTime(new Date(2024, 0, 5, 0, 0, 0))
    expect(todayStr()).toBe('2024-01-05')
  })

  it('todayStr 跨天边界：23:59 与次日 00:00 分属两天', () => {
    vi.setSystemTime(new Date(2024, 11, 31, 23, 59, 59))
    expect(todayStr()).toBe('2024-12-31')

    vi.setSystemTime(new Date(2025, 0, 1, 0, 0, 0))
    expect(todayStr()).toBe('2025-01-01')
  })

  it('nowTs 返回当前时间戳', () => {
    expect(nowTs()).toBe(FIXED_NOW.getTime())
  })
})

describe('formatTime', () => {
  it('时间戳 → HH:mm（时/分补零）', () => {
    expect(formatTime(new Date(2024, 0, 2, 8, 5).getTime())).toBe('08:05')
    expect(formatTime(new Date(2024, 0, 2, 0, 0).getTime())).toBe('00:00')
    expect(formatTime(new Date(2024, 0, 2, 23, 59).getTime())).toBe('23:59')
    expect(formatTime(new Date(2024, 0, 2, 12, 30).getTime())).toBe('12:30')
  })
})

describe('formatDateCN', () => {
  it('空串返回空串', () => {
    expect(formatDateCN('')).toBe('')
  })

  it('正常日期输出「M月D日 周X」', () => {
    expect(formatDateCN('2024-01-02')).toBe('1月2日 周二')
    expect(formatDateCN('2024-06-15')).toBe('6月15日 周六')
    expect(formatDateCN('2024-01-01')).toBe('1月1日 周一')
  })

  it('非法日期字符串原样返回（不抛错、不显示 NaN）', () => {
    expect(formatDateCN('abc')).toBe('abc')
    expect(formatDateCN('2024-13-01')).toBe('2024-13-01')
    expect(formatDateCN('not-a-date')).toBe('not-a-date')
  })

  it('不存在的日期（2024-02-30）原样回显，不再被引擎溢出成 3 月 1 日', () => {
    // 回归：Date 对 ISO 字符串只校验格式、不校验月内天数，02-30 曾被滚成 03-01 ——
    // 于是「手输错的生日」会被悄悄显示成另一天，用户完全看不出来。
    expect(formatDateCN('2024-02-30')).toBe('2024-02-30')
    expect(formatDateCN('2023-02-29')).toBe('2023-02-29') // 平年没有 2/29
    expect(formatDateCN('2024-04-31')).toBe('2024-04-31')
    expect(formatDateCN('2024-00-10')).toBe('2024-00-10')
    // 真存在的最边界一天仍要正常显示
    expect(formatDateCN('2024-02-29')).toBe('2月29日 周四')
  })

  it('跨月/跨年末尾的日期也能正确取星期', () => {
    expect(formatDateCN('2023-12-31')).toBe('12月31日 周日')
    expect(formatDateCN('2025-01-01')).toBe('1月1日 周三')
    expect(formatDateCN('2024-02-29')).toBe('2月29日 周四')
  })
})

describe('calcAge', () => {
  it('生日为空或非法 → null', () => {
    expect(calcAge('')).toBeNull()
    expect(calcAge('abc')).toBeNull()
    expect(calcAge('2024-13-01')).toBeNull()
  })

  it('生日当天算满岁', () => {
    expect(calcAge('1980-06-15')).toBe(44) // 今天 = 2024-06-15
  })

  it('生日差一天不算满岁', () => {
    expect(calcAge('1980-06-16')).toBe(43)
  })

  it('生日已过 / 未到本年度生日', () => {
    expect(calcAge('1980-06-14')).toBe(44)
    expect(calcAge('1980-07-01')).toBe(43) // 本年度生日还没到
    expect(calcAge('1980-12-31')).toBe(43)
  })

  it('闰日生日：非闰年 2/28 还没满岁，3/1 才算', () => {
    vi.setSystemTime(new Date(2024, 1, 29, 12, 0, 0))
    expect(calcAge('2000-02-29')).toBe(24) // 闰年当天算满岁

    vi.setSystemTime(new Date(2025, 1, 28, 12, 0, 0))
    expect(calcAge('2000-02-29')).toBe(24) // 非闰年 2/28：还没到

    vi.setSystemTime(new Date(2025, 2, 1, 12, 0, 0))
    expect(calcAge('2000-02-29')).toBe(25)
  })

  it('未来生日 → null（不显示负数年龄）', () => {
    // 回归：设置页的日期选择器不会拦未来日期，曾显示成「-6 岁」。
    expect(calcAge('2030-01-01')).toBeNull()
    expect(calcAge('2030-12-01')).toBeNull()
    expect(calcAge('2024-12-31')).toBeNull()
    expect(calcAge('2024-06-16')).toBeNull() // 只差一天也算未来
    // 边界：今天出生算 0 岁，昨天出生也是 0 岁
    expect(calcAge('2024-06-15')).toBe(0)
    expect(calcAge('2024-06-14')).toBe(0)
  })
})

describe('fmt', () => {
  it('null / undefined 显示占位符「—」', () => {
    expect(fmt(null)).toBe('—')
    expect(fmt(undefined)).toBe('—')
  })

  it('默认保留一位小数，且与 calc.round1 口径一致（负数半边不再差 0.1）', () => {
    expect(fmt(1.25, 1)).toBe('1.3')
    expect(fmt(1.24)).toBe('1.2')
    expect(fmt(60)).toBe('60.0')
    expect(fmt(0)).toBe('0.0')
    // 回归：fmt 曾用裸 toFixed（-1.25 → '-1.3'），而计算路径用 round1（-1.25 → -1.2）——
    // 脱水量为负（体重上涨）时，同一个数在「计算列」和「展示列」会差 0.1。
    expect(fmt(-1.25)).toBe('-1.2')
    expect(fmt(-1.25)).toBe(round1(-1.25).toFixed(1))
    expect(fmt(-0.05)).toBe(round1(-0.05).toFixed(1))
  })

  it('digits 可指定：0 位小数不显示小数点', () => {
    expect(fmt(1, 0)).toBe('1')
    expect(fmt(1.4, 0)).toBe('1')
    expect(fmt(1.5, 0)).toBe('2')
    expect(fmt(1.234, 2)).toBe('1.23')
  })

  it('非有限数（NaN / Infinity）显示占位符「—」，不把 NaN 丢给用户看', () => {
    // 回归：曾经只有 null/undefined 才显示「—」，NaN 会原样渲染成字符串 "NaN"。
    expect(fmt(NaN)).toBe('—')
    expect(fmt(Infinity)).toBe('—')
    expect(fmt(-Infinity)).toBe('—')
  })
})

describe('parseLocalDate', () => {
  it('合法日期 → 本地零点（不是 UTC 零点）', () => {
    const d = parseLocalDate('2024-02-29')
    expect(d).not.toBeNull()
    expect(d!.getFullYear()).toBe(2024)
    expect(d!.getMonth()).toBe(1)
    expect(d!.getDate()).toBe(29)
    expect(d!.getHours()).toBe(0)
  })

  it('不存在的日期 → null（不静默溢出）', () => {
    expect(parseLocalDate('2024-02-30')).toBeNull()
    expect(parseLocalDate('2023-02-29')).toBeNull()
    expect(parseLocalDate('2024-13-01')).toBeNull()
    expect(parseLocalDate('2024-04-31')).toBeNull()
  })

  it('空串 / 非法字符串 → null', () => {
    expect(parseLocalDate('')).toBeNull()
    expect(parseLocalDate('abc')).toBeNull()
    expect(parseLocalDate('not-a-date')).toBeNull()
  })
})

describe('combineDateTime', () => {
  it('日期 + 时间 → 本地时间戳', () => {
    expect(combineDateTime('2024-01-02', '08:30')).toBe(new Date(2024, 0, 2, 8, 30, 0).getTime())
  })

  it('时间为空按 00:00 处理', () => {
    expect(combineDateTime('2024-01-02', '')).toBe(new Date(2024, 0, 2, 0, 0, 0).getTime())
  })

  it('日期为空用「今天」', () => {
    expect(combineDateTime('', '08:30')).toBe(new Date(2024, 5, 15, 8, 30, 0).getTime())
    expect(combineDateTime('', '')).toBe(new Date(2024, 5, 15, 0, 0, 0).getTime())
  })

  it('跨月末 / 年末的日期正常解析', () => {
    expect(combineDateTime('2024-02-29', '23:59')).toBe(new Date(2024, 1, 29, 23, 59, 0).getTime())
    expect(combineDateTime('2024-12-31', '23:59')).toBe(new Date(2024, 11, 31, 23, 59, 0).getTime())
  })

  it('非法日期或时间回退到 Date.now()', () => {
    expect(combineDateTime('bad', '08:30')).toBe(FIXED_NOW.getTime())
    expect(combineDateTime('2024-01-02', 'bad')).toBe(FIXED_NOW.getTime())
    expect(combineDateTime('2024-13-01', '08:30')).toBe(FIXED_NOW.getTime())
  })
})

describe('dateStr / formatDateTimeCN', () => {
  it('dateStr 按本地时区输出 YYYY-MM-DD', () => {
    expect(dateStr(new Date(2024, 0, 2, 8, 30).getTime())).toBe('2024-01-02')
    // 本地 00:00 必须仍是当天（用 UTC 会变成前一天）
    expect(dateStr(new Date(2024, 0, 1, 0, 0).getTime())).toBe('2024-01-01')
    expect(dateStr(new Date(2024, 0, 1, 0, 0, 1).getTime())).toBe('2024-01-01')
  })

  it('dateStr 跨月末 / 年末', () => {
    expect(dateStr(new Date(2024, 1, 29, 23, 59).getTime())).toBe('2024-02-29')
    expect(dateStr(new Date(2024, 11, 31, 23, 59, 59).getTime())).toBe('2024-12-31')
    expect(dateStr(new Date(2025, 0, 1, 0, 0, 0).getTime())).toBe('2025-01-01')
  })

  it('formatDateTimeCN 输出本地 YYYY-MM-DD HH:mm', () => {
    expect(formatDateTimeCN(new Date(2024, 0, 2, 8, 5).getTime())).toBe('2024-01-02 08:05')
    expect(formatDateTimeCN(new Date(2024, 0, 2, 0, 0).getTime())).toBe('2024-01-02 00:00')
    expect(formatDateTimeCN(new Date(2024, 11, 31, 23, 59).getTime())).toBe('2024-12-31 23:59')
    expect(formatDateTimeCN(new Date(2025, 0, 1, 9, 0).getTime())).toBe('2025-01-01 09:00')
  })
})

describe('parseNum', () => {
  it('空串 / 纯空格 → null', () => {
    expect(parseNum('')).toBeNull()
    expect(parseNum('   ')).toBeNull()
    expect(parseNum('\t')).toBeNull()
  })

  it('非数字 → null', () => {
    expect(parseNum('abc')).toBeNull()
    expect(parseNum('1.5kg')).toBeNull()
  })

  it('有限数字（含前后空格）正常解析', () => {
    expect(parseNum('1.5')).toBe(1.5)
    expect(parseNum('  2 ')).toBe(2)
    expect(parseNum('0')).toBe(0)
    expect(parseNum('-3.2')).toBe(-3.2)
    expect(parseNum('1e3')).toBe(1000)
  })

  it('Infinity / NaN 按 Number.isFinite 语义拒绝', () => {
    expect(parseNum('Infinity')).toBeNull()
    expect(parseNum('-Infinity')).toBeNull()
    expect(parseNum('NaN')).toBeNull()
  })

  it('传入 null / undefined（类型外的运行时值）也返回 null', () => {
    expect(parseNum(null as unknown as string)).toBeNull()
    expect(parseNum(undefined as unknown as string)).toBeNull()
  })
})

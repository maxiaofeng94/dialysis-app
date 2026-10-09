// @vitest-environment node
/**
 * 静态守卫 · 云端读写的错误处理约定
 *
 * 这几条是本轮「操作缺陷排查」里代价最大的教训，编译器检查不到、单测也容易漏，
 * 所以直接用源码文本把它们钉住。每条都对应一个真实事故：
 *
 * 1. 读接口不解构 error → 断网/401 时把「查询失败」显示成「档案和记录全没了」
 * 2. 删除不复查影响行数 → RLS 静默过滤 0 行，前端以为删成功，几秒后记录「复活」
 * 3. 缓存读函数漏 FRESH_MS 闸门 → 与页面 watch(cacheVersion) 组成无限请求循环
 * 4. importAll 先清库再校验 → 备份字段不合法时本机数据已被清空
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

/** 去掉注释，避免注释里的示例代码造成误判 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const cloudRepo = stripComments(read('src/lib/cloudRepository.ts'))

describe('静态守卫 · 云端读接口必须检查 error', () => {
  it('没有任何「只解构 data、不看 error」的查询', () => {
    // 反例形态：`const { data } = await this.client()` —— 出错时 data 为 null，
    // 后面的 `(data ?? []).map(...)` 会把失败静默变成空数据。
    const missed = cloudRepo.match(/const \{ data \} = await this\.client\(\)/g) ?? []

    expect(
      missed,
      `cloudRepository 里有 ${missed.length} 处读方法没有解构 error：\n` +
        '  修法：改成 `const { data, error } = await ...` 并紧跟 `if (error) throw error`；\n' +
        '  否则断网/401 时页面会把「查询失败」显示成「没有数据」（用户以为档案和记录丢了）',
    ).toEqual([])
  })

  it('读方法普遍带 if (error) throw error', () => {
    const guarded = cloudRepo.match(/if \(error\) throw error/g) ?? []
    // 8 个读方法 + 若干写方法，低于这个数说明有人把检查删了
    expect(guarded.length).toBeGreaterThanOrEqual(8)
  })
})

describe('静态守卫 · 删除必须复查影响行数（RLS 静默过滤）', () => {
  it('每个按 id 删除都跟了 .select(id)', () => {
    const deletes = cloudRepo.match(/\.delete\(\)\.eq\('id', id\)/g) ?? []
    const guarded = cloudRepo.match(/\.delete\(\)\.eq\('id', id\)\.select\('id'\)/g) ?? []

    expect(deletes.length).toBeGreaterThanOrEqual(5)
    expect(
      guarded.length,
      '有删除方法没有 .select(\'id\') 复查：RLS 把无权限的行过滤掉时同样返回 204、error 为 null，\n' +
        '  前端会以为删成功（清缓存跳走），几秒后记录又「复活」',
    ).toBe(deletes.length)
  })

  it('存在 assertDeleted 兜底，且在 0 行时抛错', () => {
    expect(cloudRepo).toMatch(/function assertDeleted/)
    expect(cloudRepo).toMatch(/if \(!data\?\.length\) throw new Error/)
  })
})

describe('静态守卫 · 缓存读函数必须有 FRESH_MS 闸门', () => {
  it('cloudAdmin 的 listMyPatients / listMembers 都带闸门', () => {
    const src = stripComments(read('src/lib/cloudAdmin.ts'))
    const gates = src.match(/Date\.now\(\) - cached\.updatedAt >= FRESH_MS/g) ?? []

    expect(
      gates.length,
      'cloudAdmin 里命中缓存就无条件后台刷新 + cacheVersion++ 的话，会和页面的 watch(cacheVersion)\n' +
        '  组成自激循环（成员页曾每轮打一次 join 查询）。两个读函数都必须有 FRESH_MS 判断',
    ).toBe(2)
  })
})

describe('静态守卫 · 导入备份必须先校验、后清库', () => {
  it('validateBackup 排在清库之前，且清库与写入在同一个事务里', () => {
    const src = stripComments(read('src/repo/localRepository.ts'))
    const validateAt = src.indexOf('validateBackup(parsed)')
    const clearAt = src.indexOf('db.patients.clear()')

    expect(validateAt, '找不到 validateBackup(parsed) 调用').toBeGreaterThan(-1)
    expect(clearAt, '找不到清库调用').toBeGreaterThan(-1)
    expect(
      validateAt,
      '校验必须排在清库之前：先 clear 再 bulkPut 的话，备份能解析但字段不合法时本机数据已经没了',
    ).toBeLessThan(clearAt)
    expect(src, '清库 + 写入必须在同一个事务里，失败才能整体回滚').toMatch(/db\.transaction\(/)
  })
})

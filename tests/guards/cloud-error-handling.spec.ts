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
const cloudAdmin = stripComments(read('src/lib/cloudAdmin.ts'))

describe('静态守卫 · 云端读接口必须检查 error', () => {
  it('cloudRepository 没有任何「只解构 data、不看 error」的查询', () => {
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

  /**
   * cloudAdmin 是第二轮才补上的：它同样有读接口，但当时只扫了 cloudRepository，
   * 于是三个读函数长期「只解构 data」—— 出错时返回空数组，
   * 首页据此显示「还没有病人档案，去『设置』新建」，会诱导用户建出重复档案。
   */
  it('cloudAdmin 也没有「只解构 data、不看 error」的查询', () => {
    // 只管 PostgREST 查询（supabase!.from(...)）：`auth.getSession()` 是本地读，
    // 拿不到 session 就等于未登录，那里没有 error 可看
    const missed = cloudAdmin.match(/const \{ data \} = await supabase!\.from\(/g) ?? []

    expect(
      missed,
      `cloudAdmin 里有 ${missed.length} 处读方法没有解构 error（listMyPatients / listMembers / getMyProfile）：\n` +
        '  后果不是「卡住」而是「骗用户」：首页会说「还没有病人档案，去『设置』新建」，' +
        'store/patient.ts 里 hasNoCloudPatient() 的 catch 兜底也永远等不到 throw',
    ).toEqual([])
  })

  it('cloudAdmin 的读方法都带 if (error) throw error', () => {
    const guarded = cloudAdmin.match(/if \(error\) throw error/g) ?? []
    // listMyPatients / listMembers / getMyProfile 三个读方法
    expect(
      guarded.length,
      `cloudAdmin 只有 ${guarded.length} 处 error 检查（应为 3 个读方法）`,
    ).toBeGreaterThanOrEqual(3)
  })

  it('cloudAdmin 的 currentUid 读本地 session，不发 /auth/v1/user 往返', () => {
    expect(
      /auth\.getSession\(\)/.test(cloudAdmin),
      'currentUid 应改用 getSession()（只读本地存储）',
    ).toBe(true)
    expect(
      /auth\.getUser\(\)/.test(cloudAdmin),
      'currentUid 又用回 getUser() 了：它每次都要发一趟 /auth/v1/user，弱网下失败时\n' +
        '  data.user 为 null，会被调用方的 `if (!uid) return []` 静默变成「一个病人都没有」',
    ).toBe(false)
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

describe('静态守卫 · 缓存读函数必须带 FRESH_MS 闸门与在途去重', () => {
  it('cloudAdmin 的两个读函数统一走 cacheFirstWithRevalidate，不自己写一份闸门', () => {
    const src = stripComments(read('src/lib/cloudAdmin.ts'))
    const uses = src.match(/cacheFirstWithRevalidate\(/g) ?? []

    expect(
      uses.length,
      'listMyPatients / listMembers 必须调用 cloudCache 的统一实现：各写一份迟早走散\n' +
        '  （历史上就是一边漏了闸门、另一边漏了 error 检查）',
    ).toBe(2)
    expect(
      src.match(/Date\.now\(\) - cached\.updatedAt/g) ?? [],
      '不要在 cloudAdmin 里自己判断新鲜度，改由 cacheFirstWithRevalidate 统一负责',
    ).toHaveLength(0)
  })

  /**
   * 这一条对应真实事故：用户反馈「web 端长期打开后手机发烫、耗电激增」。
   * 实测把库请求延迟 800ms 后打开趋势页，30 秒内打出 131614 个请求且停不下来 ——
   * 命中陈旧缓存 → 每个 key 后台刷新 → 成功就 cacheVersion++ → 页面 watch 重跑 →
   * 重跑时**还在途**的 key 依旧陈旧（FRESH_MS 只看写入时间）→ 再刷新……无限循环。
   */
  it('cloudCache 的统一读法同时具备「新鲜度闸门」和「在途去重」', () => {
    const src = stripComments(read('src/lib/cloudCache.ts'))

    expect(
      src,
      '缺少新鲜度闸门：刚写完又会被判定为陈旧，反复触发后台刷新',
    ).toMatch(/Date\.now\(\) - cached\.updatedAt >= FRESH_MS/)
    expect(
      src,
      '缺少在途去重（inflight）：同一 key 在刷新返回前会被重复触发，和 watch(cacheVersion) 组成请求风暴',
    ).toMatch(/const inflight = new Map/)
    expect(src, '必须导出 dedupe 供批量刷新复用').toMatch(/export function dedupe/)
    expect(src, '去重登记必须在任务结束后清理，否则失败后再也不会重试').toMatch(/inflight\.delete\(key\)/)
  })

  it('cachedRepository 的后台刷新也走去重，不自己 void 一个裸异步', () => {
    const src = stripComments(read('src/repo/cachedRepository.ts'))

    expect(
      src.match(/void \(async \(\) => \{/g) ?? [],
      '裸的 `void (async () => …)()` 刷新没有在途去重 —— 这正是请求风暴的来源，改走 dedupe / cacheFirstWithRevalidate',
    ).toHaveLength(0)
    expect(
      src,
      '子表批量刷新要按 key 登记「在刷」（shareRefresh）：只拿这一批的 id 列表当去重键不行 ——\n' +
        '  写回途中页面重读时陈旧集合会少几个 id，键一变去重就失效，又会发一次批量请求',
    ).toMatch(/shareRefresh\(/)
  })
})

describe('静态守卫 · 加载失败必须有出口（不能只剩骨架）', () => {
  it('SettingsView 的 load() 用 finally 收起骨架，并给出可见的错误文案', () => {
    const src = stripComments(read('src/views/SettingsView.vue'))

    expect(
      /finally\s*\{[\s\S]{0,160}loading\.value\s*=\s*false/.test(src),
      '设置页的 load() 没有把 loading 放 finally：本机还没有缓存时一旦首次加载失败\n' +
        '（弱网、令牌失效），页面会永久停在骨架屏上，没有文案也没有「重试」，用户只能杀进程。\n' +
        '其他页面（首页/详情/趋势/报告）全都是 try/catch + finally + 重试。',
    ).toBe(true)
    expect(/loadError/.test(src), '设置页需要可见的加载失败文案与「重试」入口').toBe(true)
  })

  it('后台管理端的 supabase 客户端与 admin-api 调用都带超时', () => {
    const adminClient = stripComments(read('src/admin/lib/supabase.ts'))
    const adminApi = stripComments(read('src/admin/lib/api.ts'))

    expect(
      /resilientFetch/.test(adminClient),
      '后台的 supabase 客户端没有注入 global.fetch：supabase-js 默认既不超时也不重试，\n' +
        '弱网下请求会一直挂着（App 端已修，后台漏了 → 两端表现不一致）',
    ).toBe(true)
    expect(
      /resilientFetch/.test(adminApi),
      'admin-api 用裸 fetch 调用：连上了但服务端不响应时 fetch 不会 reject，\n' +
        'call() 永不返回 → 页面的 v-loading 与 finally 永远不执行',
    ).toBe(true)
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

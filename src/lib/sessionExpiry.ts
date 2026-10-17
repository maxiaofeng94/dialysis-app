import { watch } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import { isLoggedIn } from '../stores/auth'

/**
 * 「被踢下线 / 令牌失效」的统一处理：提示 + 回登录页。
 *
 * 为什么每个云端页面都必须挂上：
 * 仓储是按登录态分发的（`repo/index.ts` 的 `activeRepository()`），一旦 `isLoggedIn`
 * 变成 false，下一次读取就会切回**本地仓储** —— 而云端账号的本机 `dialysis-db` 通常是空的。
 * 于是页面渲染成「请先建立病人档案」「暂无透析记录」，用户以为档案和记录全丢了；
 * 更迷惑的是如果本机还留着单机模式时期的数据，会显示迁移前的旧记录。
 * 而且此时**没有任何导航**，路由守卫不会执行，页面会一直停在这个假象上。
 *
 * 只处理「由已登录变为未登录」。主动点「退出登录」不会误报：那条路径会先导航离开当前页
 * （`router.replace('/login')`），watch 随组件卸载一起停掉；设置页另有自己的 `loggingOut`
 * 标志，因为它的跳转发生在 `logout()` 之后、卸载之前。
 */
export function useSessionExpiryRedirect(): void {
  const router = useRouter()
  watch(isLoggedIn, (val, old) => {
    if (old && !val) {
      showToast('登录状态已失效，请重新登录')
      void router.replace('/login')
    }
  })
}

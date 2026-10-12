import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { showToast } from 'vant'
import router from '../router'

/**
 * Android 返回键接管。
 *
 * Capacitor 的规则是：**JS 侧注册了 `backButton` 监听，系统就不再默认 `finish()`**。
 * 之前一个监听都没注册，于是在任何页面（包括弹窗打开时）按返回键都是直接退出 App ——
 * 正在弹窗里填的血压 / 血糖全丢，用户感知就是「App 又没了」。
 *
 * 优先级：关掉最上层弹层 → 退回上一页 → 首页双击退出。
 */

/** 双击退出的时间窗 */
const EXIT_WINDOW_MS = 2000
let lastBackAt = 0

/**
 * 只看**可见**的元素。
 * Vant 的弹窗 / 遮罩关闭后 DOM 仍然留在页面上（只是高度与透明度变成 0），
 * 不过滤可见性的话会一直以为「还有弹窗开着」，返回键就再也退不出去了。
 */
function visible(selector: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(selector)].filter((el) => {
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  })
}

/**
 * 关掉最上层的弹层，返回是否消费了这次返回键。
 *
 * 用户在弹窗里按返回，期望的是「关掉这个弹窗」，而不是退出 App。
 */
function closeTopOverlay(): boolean {
  // ① 命令式对话框（showConfirmDialog）：点「取消」。
  //    ⚠️ 绝不能点确认 —— 那些确认按钮背后是删除记录、删除病人这类不可逆操作。
  const dialogs = visible('.van-dialog')
  if (dialogs.length) {
    const cancel = dialogs[dialogs.length - 1].querySelector<HTMLElement>('.van-dialog__cancel')
    cancel?.click()
    // 没有取消按钮（纯提示型）也照样消费掉：宁可这一下没反应，也不能误触发确认
    return true
  }

  // ② 普通弹窗（van-popup）：点遮罩关闭。
  //    项目里所有 van-popup 都没有关掉 closeOnClickOverlay，默认可关。
  const overlays = visible('.van-overlay')
  if (overlays.length) {
    overlays[overlays.length - 1].click()
    return true
  }

  return false
}

/** 只在 Android 上接管：iOS 没有系统返回键，而且 Apple 也不允许应用主动退出 */
export function setupAndroidBackButton(): void {
  if (Capacitor.getPlatform() !== 'android') return

  void App.addListener('backButton', () => {
    if (closeTopOverlay()) return

    const route = router.currentRoute.value
    if (route.path !== '/') {
      // 历史栈里有上一条就正常后退；冷启动直接落在详情页时兜底回首页，别让返回键失灵
      if (window.history.state?.back) router.back()
      else void router.replace('/')
      return
    }

    // 已在首页：双击退出，避免误触
    const now = Date.now()
    if (now - lastBackAt < EXIT_WINDOW_MS) {
      void App.exitApp()
      return
    }
    lastBackAt = now
    showToast('再按一次返回键退出')
  })
}

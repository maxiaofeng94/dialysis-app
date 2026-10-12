/**
 * 给 Promise 加一道超时闸门：到点就 resolve 兜底值，**不 reject**。
 *
 * 用途只有一个 —— 别让首屏被一个挂死的网络请求永久卡住。
 * 路由守卫会 `await` 登录态恢复与病人校准，弱网下这些请求可能长时间没有响应，
 * 而 `router-view` 在守卫返回前是空的：挂住 = 白屏，用户只能杀进程。
 *
 * 注意：超时后原 Promise 仍在后台跑，只是结果被丢弃（调用方已经把兜底值当结果用了）。
 */
export function withTimeout<T, F = T>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  return new Promise<T | F>((resolve) => {
    let settled = false
    const finish = (value: T | F) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(fallback), ms)
    promise.then(finish, () => finish(fallback))
  })
}

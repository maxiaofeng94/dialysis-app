/*
 * 启动引导 —— 必须在任何外链资源之前同步执行，所以放在 <head> 里且不带 async/defer。
 *
 * 为什么是独立文件而不是内联脚本：生产 CSP 是
 *   script-src 'self' https://challenges.cloudflare.com
 * （见 public/_headers）——**内联脚本会被直接拦掉**，兜底逻辑等于没写。
 * 改动这个文件时不要再塞回 index.html。
 *
 * 职责：
 *   ① 清掉原生壳里历史遗留的 Service Worker 与 Cache Storage。
 *      覆盖安装后 WebView 里还留着上一次的 SW，它用 NavigationRoute 返回**旧的
 *      index.html**；而旧 HTML 引用的旧 hash 资源会被新 SW 的 skipWaiting + 预缓存
 *      清理删掉 → 脚本 404 → 整页白屏。Web 端（Cloudflare Pages）靠 SW 做离线，
 *      所以只在原生壳里清。
 *   ② JS 起来之前给出可看的界面，失败时给一个「重新打开」按钮。
 *      以前 #app 是空的：脚本一旦加载失败，用户看到纯白，只能杀进程重开。
 *
 * 语法必须是 ES5：老 WebView 解析不了箭头函数 / 模板字符串就直接白屏，
 * tests/guards/boot-splash.spec.ts 会断言这一点。
 */
(function () {
  var mounted = false
  var failed = false
  var splash = null

  function splashEl() {
    if (!splash) splash = document.getElementById('boot-splash')
    return splash
  }

  function isNativeShell() {
    try {
      if (window.androidBridge) return true
      if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function') {
        return window.Capacitor.isNativePlatform() === true
      }
      // Capacitor 的 Android WebView 固定跑在 https://localhost 上
      return location.protocol === 'https:' && location.hostname === 'localhost'
    } catch (e) {
      return false
    }
  }

  if (isNativeShell()) {
    try {
      if (navigator.serviceWorker) {
        navigator.serviceWorker.getRegistrations().then(
          function (regs) {
            for (var i = 0; i < regs.length; i++) regs[i].unregister()
          },
          function () {},
        )
      }
    } catch (e) {}
    // 等首屏该拿的资源都拿完再清缓存，别和自己的请求抢时间
    window.addEventListener('load', function () {
      try {
        if (!window.caches) return
        caches.keys().then(
          function (keys) {
            for (var i = 0; i < keys.length; i++) caches['delete'](keys[i])
          },
          function () {},
        )
      } catch (e) {}
    })
  }

  function fail(detail) {
    var box = splashEl()
    if (failed || mounted || !box) return
    failed = true
    box.innerHTML =
      '<div class="boot-logo">透</div>' +
      '<div class="boot-tip">打开失败，请检查网络后重试</div>' +
      '<button type="button" class="boot-retry" id="boot-retry">重新打开</button>' +
      (detail ? '<div class="boot-detail">' + String(detail).slice(0, 120) + '</div>' : '')
    var btn = document.getElementById('boot-retry')
    if (btn) btn.onclick = function () { location.reload() }
  }

  // main.ts 挂载成功后回调，撤掉下面的超时兜底
  window.__bootMounted = function () { mounted = true }

  window.addEventListener(
    'error',
    function (e) {
      if (mounted || failed) return
      var t = e && e.target
      if (t && t !== window && t.tagName) {
        // 只认「页面根本跑不起来」的资源：脚本与样式表。
        // 图标之类的 404 不该把正常页面换成错误页。
        var tag = String(t.tagName).toUpperCase()
        if (tag !== 'SCRIPT' && !(tag === 'LINK' && /stylesheet/i.test(t.rel || ''))) return
        fail(tag.toLowerCase() + ' ' + (t.src || t.href || ''))
        return
      }
      fail(e && e.message)
    },
    true,
  )

  // 脚本压根没跑起来（SW 换掉了、解析失败）时，页面上至少还留一个出口
  window.setTimeout(function () {
    if (!mounted) fail('启动超时')
  }, 20000)
})()

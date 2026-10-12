package com.dialysis.record;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import java.io.File;

public class MainActivity extends BridgeActivity {
  /**
   * 覆盖安装后 WebView 里的 Service Worker 数据还留在上一次安装。
   * 旧 SW 用 NavigationRoute 返回**旧的 index.html**，而旧 HTML 引用的旧 hash 资源
   * 已经被新 SW 的 skipWaiting + 预缓存清理删掉 → 脚本 404 → 整页白屏。
   *
   * 纯 Web 侧的 unregister 要等页面脚本跑起来才生效，而白屏恰恰发生在脚本跑起来之前，
   * 所以在 WebView 创建之前把这个目录整个删掉。
   *
   * 只动 Service Worker 子树：IndexedDB（业务数据与云端缓存）、Local Storage、
   * SharedPreferences（登录态与当前病人）一概不碰。
   *
   * 必须在 super.onCreate() 之前执行 —— 那一刻 WebView 还没创建，删了不会被占用。
   */
  @Override
  public void onCreate(Bundle savedInstanceState) {
    dropStaleServiceWorkerData();
    super.onCreate(savedInstanceState);
  }

  private void dropStaleServiceWorkerData() {
    try {
      File filesDir = getFilesDir();
      File dataDir = filesDir == null ? null : filesDir.getParentFile();
      if (dataDir == null) {
        return;
      }
      File[] roots = dataDir.listFiles();
      if (roots == null) {
        return;
      }
      for (File root : roots) {
        // Chromium WebView 的数据目录是 app_webview（个别实现会带进程后缀）
        if (!root.isDirectory() || !root.getName().startsWith("app_webview")) {
          continue;
        }
        File swDir = new File(root, "Default/Service Worker");
        if (swDir.exists()) {
          deleteRecursively(swDir);
        }
      }
    } catch (Throwable ignored) {
      // 清理失败不能挡住启动：Web 侧还有一层 unregister + 清 Cache Storage 兜底
    }
  }

  private static void deleteRecursively(File target) {
    File[] children = target.listFiles();
    if (children != null) {
      for (File child : children) {
        deleteRecursively(child);
      }
    }
    //noinspection ResultOfMethodCallIgnored
    target.delete();
  }
}

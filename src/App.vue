<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()

/**
 * 首次导航是否已完成。
 *
 * 正常路径下 main.ts 会等到 `router.isReady()` 再挂载，这里初值就是 true、不闪。
 * 只有「守卫被网络请求挂住、main.ts 超时兜底挂载」（见 src/main.ts）时才是 false ——
 * 那种情况下 `router-view` 渲染为空，必须自己顶一个占位，否则又是一片白屏。
 * 用 `matched.length` 而不是 `isReady().then()` 判断，是为了不在正常路径上多闪一帧。
 */
const routeReady = ref(router.currentRoute.value.matched.length > 0)
if (!routeReady.value) {
  router.isReady().then(
    () => {
      routeReady.value = true
    },
    () => {
      routeReady.value = true
    },
  )
}

const showTabbar = computed(() => Boolean(route.meta.tabbar))
const active = computed(() => {
  if (route.path.startsWith('/trend')) return 1
  if (route.path.startsWith('/settings')) return 2
  return 0
})

function onTab(index: number | string) {
  const i = typeof index === 'number' ? index : Number(index)
  const paths = ['/', '/trend', '/settings']
  router.push(paths[i] ?? '/')
}
</script>

<template>
  <div class="app-shell">
    <router-view v-if="routeReady" />
    <div v-else class="app-booting">正在打开…</div>
    <van-tabbar v-if="showTabbar" :model-value="active" @change="onTab" fixed placeholder>
      <van-tabbar-item icon="records">记录</van-tabbar-item>
      <van-tabbar-item icon="chart-trending-o">趋势</van-tabbar-item>
      <van-tabbar-item icon="setting-o">设置</van-tabbar-item>
    </van-tabbar>
  </div>
</template>

<style scoped>
.app-booting {
  padding-top: 40vh;
  text-align: center;
  color: #969799;
  font-size: 14px;
}
</style>

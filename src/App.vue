<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()

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
    <router-view />
    <van-tabbar v-if="showTabbar" :model-value="active" @change="onTab" fixed placeholder>
      <van-tabbar-item icon="records">记录</van-tabbar-item>
      <van-tabbar-item icon="chart-trending-o">趋势</van-tabbar-item>
      <van-tabbar-item icon="setting-o">设置</van-tabbar-item>
    </van-tabbar>
  </div>
</template>

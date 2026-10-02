<script setup lang="ts">
import { ElConfigProvider } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
</script>

<template>
  <!-- Element Plus 推荐用法：统一提供中文语言包与 zIndex 上下文（弹窗层级、表格固定列等） -->
  <el-config-provider :locale="zhCn">
    <router-view />
  </el-config-provider>
</template>

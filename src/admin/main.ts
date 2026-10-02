import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import App from './App.vue'
import router from './router'
import './style.css'

// 语言包等全局配置由 App.vue 里的 <el-config-provider> 提供
createApp(App).use(ElementPlus).use(router).mount('#admin-app')

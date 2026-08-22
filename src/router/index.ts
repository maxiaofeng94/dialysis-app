import { createRouter, createWebHashHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'
import SessionView from '../views/SessionView.vue'
import ReportView from '../views/ReportView.vue'
import TrendView from '../views/TrendView.vue'
import SettingsView from '../views/SettingsView.vue'
import LoginView from '../views/LoginView.vue'
import MembersView from '../views/MembersView.vue'
import { useAuth } from '../stores/auth'
import { isCloudConfigured } from '../lib/supabase'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView, meta: { tabbar: true } },
    { path: '/session/:id', name: 'session', component: SessionView },
    { path: '/report/:id', name: 'report', component: ReportView },
    { path: '/trend', name: 'trend', component: TrendView, meta: { tabbar: true } },
    { path: '/settings', name: 'settings', component: SettingsView, meta: { tabbar: true } },
    { path: '/login', name: 'login', component: LoginView },
    { path: '/members', name: 'members', component: MembersView },
  ],
})

// 多人版登录守卫：云端模式下未登录跳转登录页；本地模式（未配置 Supabase）不受影响
router.beforeEach(async (to) => {
  const { initialized, isLoggedIn, init } = useAuth()
  if (!initialized.value) await init()
  if (!isCloudConfigured) return true
  if (to.path === '/login') {
    return isLoggedIn.value ? '/' : true
  }
  return isLoggedIn.value ? true : '/login'
})

export default router

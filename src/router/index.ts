import { createRouter, createWebHashHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'
import SessionView from '../views/SessionView.vue'
import ReportView from '../views/ReportView.vue'
import TrendView from '../views/TrendView.vue'
import SettingsView from '../views/SettingsView.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView, meta: { tabbar: true } },
    { path: '/session/:id', name: 'session', component: SessionView },
    { path: '/report/:id', name: 'report', component: ReportView },
    { path: '/trend', name: 'trend', component: TrendView, meta: { tabbar: true } },
    { path: '/settings', name: 'settings', component: SettingsView, meta: { tabbar: true } },
  ],
})

export default router

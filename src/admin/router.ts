import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import { adminUser, initAuth, logout, me, ready } from './lib/auth'
import AdminLayout from './layout/AdminLayout.vue'

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('./views/LoginView.vue'),
    meta: { public: true, title: '登录' },
  },
  {
    path: '/',
    component: AdminLayout,
    children: [
      { path: '', name: 'dashboard', component: () => import('./views/DashboardView.vue'), meta: { title: '概览' } },
      { path: 'users', name: 'users', component: () => import('./views/UserListView.vue'), meta: { title: '用户管理' } },
      {
        path: 'users/:id',
        name: 'user-detail',
        component: () => import('./views/UserDetailView.vue'),
        meta: { title: '用户详情' },
      },
      {
        path: 'patients',
        name: 'patients',
        component: () => import('./views/PatientListView.vue'),
        meta: { title: '病人管理' },
      },
      {
        path: 'patients/:id',
        name: 'patient-detail',
        component: () => import('./views/PatientDetailView.vue'),
        meta: { title: '病人详情' },
      },
      { path: 'audit', name: 'audit', component: () => import('./views/AuditView.vue'), meta: { title: '操作日志' } },
      { path: 'me', name: 'me', component: () => import('./views/MeView.vue'), meta: { title: '我的账号' } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

// 后台守卫：未登录跳登录页；登录了但没有管理员权限 → 立即登出
router.beforeEach(async (to) => {
  if (!ready.value) await initAuth()

  if (to.meta.public) {
    return adminUser.value && me.value?.isAdmin ? '/' : true
  }
  if (!adminUser.value) {
    return to.fullPath === '/' ? '/login' : { path: '/login', query: { redirect: to.fullPath } }
  }
  if (!me.value?.isAdmin) {
    await logout('该账号没有后台权限')
    return '/login'
  }
  return true
})

export default router

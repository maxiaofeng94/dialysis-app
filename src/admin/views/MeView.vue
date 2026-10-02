<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { me } from '../lib/auth'
import { supabase } from '../lib/supabase'
import { messageOf } from '../lib/api'

const pwd1 = ref('')
const pwd2 = ref('')
const saving = ref(false)

const whoText = computed(() => me.value?.name || me.value?.phone || '管理员')

async function onChangePassword() {
  if (pwd1.value.length < 6) {
    ElMessage.warning('新密码至少 6 位')
    return
  }
  if (pwd1.value !== pwd2.value) {
    ElMessage.warning('两次输入的密码不一致')
    return
  }
  if (!supabase) return
  saving.value = true
  try {
    const { error } = await supabase.auth.updateUser({ password: pwd1.value })
    if (error) throw error
    ElMessage.success('密码已修改，下次登录请使用新密码')
    pwd1.value = ''
    pwd2.value = ''
  } catch (err) {
    ElMessage.error(messageOf(err))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div>
    <el-card class="page-card" shadow="never">
      <template #header>当前账号</template>
      <el-descriptions :column="2" border>
        <el-descriptions-item label="姓名">{{ me?.name || '未设置' }}</el-descriptions-item>
        <el-descriptions-item label="手机号">
          <span class="mono">{{ me?.phone || '—' }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="后台权限">
          <el-tag type="success" size="small">管理员</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="用户 ID">
          <span class="mono" style="font-size: 12px">{{ me?.userId }}</span>
        </el-descriptions-item>
      </el-descriptions>
      <div class="muted" style="margin-top: 12px; line-height: 1.8">
        · 管理员身份由数据库 <span class="mono">public.admins</span> 表决定，无法自助获取；如需撤销，请让另一位管理员在用户详情页操作。<br />
        · 连续 30 分钟无操作会自动退出登录；登录凭证由 Supabase Auth 托管，有效期 1 小时并自动续期。
      </div>
    </el-card>

    <el-card class="page-card" shadow="never">
      <template #header>修改我的密码</template>
      <el-form label-width="90px" style="max-width: 420px">
        <el-form-item label="新密码">
          <el-input v-model="pwd1" type="password" show-password placeholder="至少 6 位" />
        </el-form-item>
        <el-form-item label="确认密码">
          <el-input v-model="pwd2" type="password" show-password placeholder="再输入一次" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="saving" @click="onChangePassword">保存</el-button>
        </el-form-item>
      </el-form>
      <div class="muted" style="font-size: 12px">
        当前登录的管理员：{{ whoText }}。修改的是你自己的 App 登录密码（手机端同样生效）。
      </div>
    </el-card>
  </div>
</template>

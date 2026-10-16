<script setup lang="ts">
import { NAlert, NButton, NCard, NForm, NFormItem, NInput } from 'naive-ui'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { login } from '../api'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const token = ref('')
const error = ref('')
const loading = ref(false)
const logoFailed = ref(false)

// The terminal prints a sign-in link with the token in the URL fragment, which never reaches the server.
onMounted(() => {
  const match = /^#token=(.+)$/.exec(location.hash)
  if (!match) return
  token.value = decodeURIComponent(match[1])
  history.replaceState(history.state, '', location.pathname + location.search)
  submit()
})

async function submit() {
  if (!token.value.trim()) return
  loading.value = true
  error.value = ''
  try {
    if (await login(token.value.trim())) {
      router.replace(typeof route.query.next === 'string' ? route.query.next : '/bots')
    } else {
      error.value = t('login.wrong')
    }
  } catch {
    error.value = t('login.unreachable')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login">
    <NCard class="login-card" :bordered="true">
      <div class="login-brand">
        <img v-if="!logoFailed" src="/logo.png" alt="" @error="logoFailed = true">
        <h1>Mushin.js <span>無心</span></h1>
        <p>{{ t('app.tagline') }}</p>
      </div>
      <NAlert v-if="route.query.expired" type="warning" :show-icon="false" class="expired">{{ t('login.expired') }}</NAlert>
      <NForm @submit.prevent="submit">
        <NFormItem :label="t('login.token')" :feedback="error || t('login.tokenHint')" :validation-status="error ? 'error' : undefined">
          <NInput
            v-model:value="token"
            type="password"
            show-password-on="click"
            :placeholder="t('login.token')"
            :input-props="{ autocomplete: 'current-password' }"
            autofocus
            @keyup.enter="submit"
          />
        </NFormItem>
        <NButton type="primary" block :loading="loading" attr-type="submit">{{ t('login.submit') }}</NButton>
      </NForm>
    </NCard>
  </div>
</template>

<style scoped>
.login {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  box-sizing: border-box;
}

.login-card {
  width: 100%;
  max-width: 400px;
}

.expired {
  margin-bottom: 16px;
}

.login-brand {
  text-align: center;
  margin-bottom: 20px;
}

.login-brand img {
  width: 72px;
  height: 72px;
}

.login-brand h1 {
  margin: 8px 0 4px;
  font-size: 24px;
}

.login-brand h1 span {
  font-weight: 400;
  opacity: 0.55;
}

.login-brand p {
  margin: 0;
  opacity: 0.65;
}
</style>

<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  errorMessage: { type: String, default: '' },
  message: { type: String, default: '' },
  resetPasswordVersion: { type: Number, default: 0 },
  resetModeVersion: { type: Number, default: 0 }
})
const emit = defineEmits(['submit', 'close', 'clear-message'])

const mode = ref('login')
const email = ref('')
const password = ref('')

watch(() => props.resetPasswordVersion, () => { password.value = '' })
watch(() => props.resetModeVersion, () => { mode.value = 'login' })

function submit() {
  emit('submit', { mode: mode.value, email: email.value, password: password.value })
}

function toggleMode() {
  mode.value = mode.value === 'login' ? 'register' : 'login'
  emit('clear-message')
}
</script>

<template>
  <div v-if="open" class="mobile-overlay fixed inset-0 z-[60] flex items-center justify-center bg-[#20251f66] p-4" @click.self="emit('close')">
    <section class="mobile-dialog w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
      <div class="flex items-start justify-between"><div><p class="text-[10px] font-semibold uppercase tracking-[.18em] text-[#8c9284]">Your reading space</p><h2 class="mt-2 font-serif text-2xl">{{ mode === 'login' ? '欢迎回来' : '创建账号' }}</h2></div><button class="rounded-full px-2 py-1 text-[#888]" @click="emit('close')">×</button></div>
      <form class="mt-5 space-y-3" @submit.prevent="submit">
        <label class="block text-xs font-medium text-[#62645c]">邮箱<input v-model="email" type="email" required autocomplete="email" class="mt-1.5 w-full rounded-lg border border-[#e8e6df] px-3 py-2.5 text-sm outline-none focus:border-[#82917f]" /></label>
        <label class="block text-xs font-medium text-[#62645c]">密码<input v-model="password" type="password" required minlength="6" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" class="mt-1.5 w-full rounded-lg border border-[#e8e6df] px-3 py-2.5 text-sm outline-none focus:border-[#82917f]" /></label>
        <p v-if="errorMessage" class="text-xs leading-5 text-[#a45e4f]">{{ errorMessage }}</p><p v-if="message" class="text-xs leading-5 text-[#59765e]">{{ message }}</p>
        <button :disabled="loading" class="w-full rounded-lg bg-[#273b32] px-4 py-2.5 text-sm text-white disabled:opacity-60">{{ loading ? '请稍候…' : mode === 'login' ? '登录' : '注册' }}</button>
      </form>
      <button class="mt-4 w-full text-xs text-[#71816f]" @click="toggleMode">{{ mode === 'login' ? '还没有账号？注册' : '已有账号？返回登录' }}</button>
    </section>
  </div>
</template>

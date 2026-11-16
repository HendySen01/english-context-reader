<script setup>
defineProps({
  open: { type: Boolean, default: false },
  sentenceCount: { type: Number, default: 0 },
  noteCount: { type: Number, default: 0 }
})
const emit = defineEmits(['import', 'skip', 'close'])
</script>

<template>
  <div v-if="open" class="mobile-overlay fixed inset-0 z-[70] flex items-center justify-center bg-[#20251f66] p-4">
    <section class="mobile-dialog w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
      <p class="text-[10px] font-semibold uppercase tracking-[.18em] text-[#8c9284]">Local data found</p><h2 class="mt-2 font-serif text-2xl">导入本地数据？</h2>
      <p class="mt-3 text-sm leading-6 text-[#777970]">此设备上有 <strong>{{ sentenceCount }}</strong> 条自定义句子，以及 <strong>{{ noteCount }}</strong> 条带星标或复习进度的词条。是否导入到当前账号？</p>
      <div class="mt-6 flex justify-end gap-2"><button class="rounded-lg border border-[#e8e6df] px-4 py-2 text-sm text-[#62645c]" @click="emit('skip')">暂不导入</button><button class="rounded-lg bg-[#273b32] px-4 py-2 text-sm text-white" @click="emit('import')">导入到账号</button></div>
    </section>
  </div>
</template>

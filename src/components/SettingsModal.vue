<script setup>
import { ref } from 'vue'

defineProps({
  open: { type: Boolean, default: false },
  managedAi: { type: Boolean, default: false },
  defaultBlurTranslation: { type: Boolean, default: true },
  dailyReviewGoal: { type: Number, default: 10 },
  apiBaseUrl: { type: String, default: '' },
  apiModel: { type: String, default: '' },
  apiKey: { type: String, default: '' }
})
const emit = defineEmits(['close', 'update:defaultBlurTranslation', 'update:dailyReviewGoal', 'update:apiBaseUrl', 'update:apiModel', 'update:apiKey', 'export-backup', 'import-file', 'export-anki'])
const backupInput = ref(null)
</script>

<template>
  <div v-if="open" class="shrink-0 overflow-y-auto border-b border-[#e8e6df] bg-[#f7f6f2] px-5 py-3 md:px-12">
    <div class="mb-3 flex flex-wrap gap-2"><button class="rounded-full border bg-white px-3 py-2 text-xs"
        @click="emit('export-backup')">导出备份 JSON</button><button class="rounded-full border bg-white px-3 py-2 text-xs"
        @click="backupInput?.click()">导入恢复</button><button class="rounded-full border bg-white px-3 py-2 text-xs"
        @click="emit('export-anki')">导出已学词汇为 Anki CSV</button><input ref="backupInput" type="file"
        accept="application/json,.json" class="hidden" @change="emit('import-file', $event)" /></div>
    <label class="mb-3 flex min-h-10 items-center gap-2 text-xs text-[#62645c]"><input type="checkbox"
        :checked="defaultBlurTranslation" class="h-4 w-4 accent-[#49634e]"
        @change="emit('update:defaultBlurTranslation', $event.target.checked)" />默认遮住翻译</label>
    <div class="rounded-xl border border-[#e8e6df] bg-white p-5"><label
        class="block text-xs font-medium">每日复习目标</label><select :value="dailyReviewGoal"
        class="mt-2 min-h-10 w-full rounded-lg border border-[#e8e6df] bg-white px-3 text-sm"
        @change="emit('update:dailyReviewGoal', Number($event.target.value))">
        <option :value="5">5 个</option>
        <option :value="10">10 个</option>
        <option :value="20">20 个</option>
        <option :value="30">30 个</option>
      </select><template v-if="!managedAi"><label class="mt-4 block text-xs font-medium">Base
        URL</label><input :value="apiBaseUrl" type="url" placeholder="https://api.openai.com/v1"
        class="mt-2 w-full rounded-lg border border-[#e8e6df] px-3 py-2 text-sm outline-none focus:border-[#82917f]"
        @input="emit('update:apiBaseUrl', $event.target.value)" /><label
        class="mt-4 block text-xs font-medium">Model</label><input :value="apiModel"
        placeholder="gpt-4o-mini 或 deepseek-chat"
        class="mt-2 w-full rounded-lg border border-[#e8e6df] px-3 py-2 text-sm outline-none focus:border-[#82917f]"
        @input="emit('update:apiModel', $event.target.value)" /><label class="mt-4 block text-xs font-medium">大模型 API
        Key <span class="text-[#999]">（保存在此浏览器）</span></label><input :value="apiKey" type="password" autocomplete="off"
        placeholder="sk-…"
        class="mt-2 w-full rounded-lg border border-[#e8e6df] px-3 py-2 text-sm outline-none focus:border-[#82917f]"
        @input="emit('update:apiKey', $event.target.value)" />
      <p class="mt-2 text-[11px] text-[#92938a]">点击未缓存词语时，通过本地 /api/llm 代理调用上方配置的兼容接口。
      </p>
      </template>
      <p v-else class="mt-4 text-xs text-[#777970]">AI 由本站提供，登录并获得授权后即可查词和翻译。</p>
    </div>
  </div>
</template>

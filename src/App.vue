<script setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { entries as mockEntries, passage as defaultPassage } from './data/entries.js'

const STORE = 'context-reader-state-v1'
const saved = (() => { try { return JSON.parse(localStorage.getItem(STORE) || '{}') } catch { return {} } })()
const passages = ref(saved.passages?.length ? saved.passages : [{ id: 'default', sentence: 'After hours of driving, we finally found a quiet parking space behind the museum.', translation: '开了几个小时的车后，我们终于在博物馆后面找到一个安静的停车位。' }])
// 只恢复新版语境缓存，丢弃旧的单词级缓存。
const cache = ref(Object.fromEntries(Object.entries(saved.cache || {}).filter(([, value]) => value?.llmSuccess === true && value?.deepSchema === 4)))
const apiKey = ref(localStorage.getItem('context-reader-api-key') || '')
const apiBaseUrl = ref(localStorage.getItem('context-reader-base-url') || 'https://api.openai.com/v1')
const apiModel = ref(localStorage.getItem('context-reader-model') || 'gpt-4o-mini')
const speakingExample = ref('')
let currentUtterance = null
const showForm = ref(false)
const showLibrary = ref(false)
const passageSearch = ref('')
const translating = ref(false)
const showSettings = ref(false)
const draftSentence = ref('')
const draftTranslation = ref('')
const activePassageId = ref(passages.value[0].id)
const selectedId = ref('parking-space')
const loading = ref(false)
const error = ref('')
const activePassage = computed(() => passages.value.find(p => p.id === activePassageId.value) || passages.value[0])
// 用稳定句子 id 隔离不同语境下的同一词条解析。
function makeCacheKey(passageId, key) { return `${passageId}::${key}` }
const filteredPassages = computed(() => passages.value.filter(p => `${p.sentence} ${p.translation}`.toLowerCase().includes(passageSearch.value.toLowerCase())))
const sentencePreview = sentence => sentence.trim().split(/\s+/).slice(0, 8).join(' ')
const mockMap = Object.fromEntries(mockEntries.map(entry => [entry.text.toLowerCase(), entry]))
// 面板按当前句子与词条共同读取缓存，避免跨句复用解析。
const selected = computed(() => cache.value[makeCacheKey(activePassage.value.id, selectedId.value)] || mockMap[selectedId.value] || placeholder(selectedId.value))
const selectedParts = computed(() => selected.value?.type === 'phrase'
  ? selected.value.text.trim().split(/\s+/).filter(Boolean)
  : [])
watch([passages, cache], () => localStorage.setItem(STORE, JSON.stringify({ passages: passages.value, cache: cache.value })), { deep: true })
watch(apiKey, value => localStorage.setItem('context-reader-api-key', value))
watch(apiBaseUrl, value => localStorage.setItem('context-reader-base-url', value))
watch(apiModel, value => localStorage.setItem('context-reader-model', value))
onBeforeUnmount(() => window.speechSynthesis?.cancel())

const normalize = (word) => word.toLowerCase().replace(/^[^a-z'-]+|[^a-z'-]+$/gi, '')
const fixedPhrases = ['parking space', 'look at']
const tokens = computed(() => {
  const sentence = activePassage.value?.sentence || ''
  const words = [...sentence.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)]
  const result = []; let cursor = 0; let i = 0
  while (i < words.length) {
    const current = words[i], next = words[i + 1]
    const phrase = next && `${normalize(current[0])} ${normalize(next[0])}`
    // 词组缓存判断也必须限定在当前句子语境内。
    const phraseKnown = phrase && (fixedPhrases.includes(phrase) || mockMap[phrase] || cache.value[makeCacheKey(activePassage.value.id, phrase)])
    const start = current.index
    if (start > cursor) result.push({ text: sentence.slice(cursor, start), key: null })
    if (phraseKnown) { const end = next.index + next[0].length; result.push({ text: sentence.slice(start, end), key: phrase }); cursor = end; i += 2 }
    else { const end = start + current[0].length; const word = normalize(current[0]); result.push({ text: current[0], key: word }); cursor = end; i++ }
  }
  if (cursor < sentence.length) result.push({ text: sentence.slice(cursor), key: null })
  return result
})

function baseForm(word) {
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3).replace(/(.)\1$/, '$1')
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2)
  if (word.endsWith('s') && word.length > 3 && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}
function placeholder(word) {
  const lemma = baseForm(word); const likelyVerb = /(?:ing|ed)$/.test(word) || ['is', 'are', 'was', 'were', 'has', 'have', 'do', 'does'].includes(word)
  return { id: word, text: word, type: 'word', pronunciation: '点击播放发音', partOfSpeech: likelyVerb ? '可能是动词 / 形容词（需结合语境确认）' : '词性需结合语境确认', definition: `语境占位说明：在“${activePassage.value.sentence}”中，${word} 的具体含义需要结合上下文确认。`, etymology: `原型推断：${lemma}${lemma !== word ? `（从 ${word} 还原的可能原型）` : '（当前词形）'}。此为规则推断，并非词典结论。`, comparisons: [{ word: 'similar', note: '可尝试使用含义相近的表达，具体替换需结合语境。' }, { word: 'related', note: '选择同主题词汇时注意搭配与语气。' }], examples: [{ text: `I noticed “${word}” in this sentence.`, translation: `我在这个句子里注意到了“${word}”。` }, { text: `Can you explain how “${word}” is used here?`, translation: `你能解释“${word}”在这里的用法吗？` }], dynamic: true }
}
async function fetchWordContext(word, fullSentence) {
  console.log('开始请求LLM:', word)
  if (!apiKey.value.trim()) throw new Error('未配置 API Key')
  const base = apiBaseUrl.value.trim().replace(/\/+$/, '')
  if (!base || !apiModel.value.trim()) throw new Error('请填写有效的 Base URL 和 Model')
  let lastError
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 使用 JSON 模式并提高输出上限，降低格式漂移和内容截断概率。
      // 深度词源 JSON 较长，提升上限避免例句字段被截断。
      const response = await fetch('/api/llm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: base, model: apiModel.value.trim(), apiKey: apiKey.value.trim(), temperature: 0.2, max_tokens: 8000, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: '你是英语词源与语境解析专家。全文中文内容必须使用简体中文，英文例句及词源原文可保留英文。只输出一个严格合法、可被 JSON.parse 解析的 JSON 对象，不要 Markdown、代码围栏、注释或任何额外文字。所有字符串中的双引号和换行必须正确转义。examples 必须正好 2 条，semanticRoutes 必须正好 3 条。格式示例：{"text":"word","type":"word","pronunciation":"/wɜːd/","partOfSpeech":"名词","definition":"语境释义","usage":"用法","etymology":{"prefix":"无","root":"词根","suffix":"无","origin":"来源","originalImage":"原始画面","certainty":"较确定"},"semanticRoutes":[{"label":"线路A","steps":"演变过程","modernMeaning":"现代义","domain":"日常"},{"label":"线路B","steps":"演变过程","modernMeaning":"现代义","domain":"商业"},{"label":"线路C","steps":"演变过程","modernMeaning":"现代义","domain":"技术"}],"comparisons":[{"word":"near-synonym","partOfSpeech":"名词","difference":"区别"}],"examples":[{"text":"Example sentence.","translation":"例句译文","contextNote":"语境说明"},{"text":"Another example.","translation":"另一例句","contextNote":"语境说明"}]}。必须包含全部字段。' }, { role: 'user', content: `当前完整句子：${fullSentence}\n目标词/词组：${word}\n只返回符合 schema 的 JSON。` }] }) })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        const hint = response.status === 401 ? 'API Key 无效或权限不足。' : response.status === 403 ? '当前 Key 无权调用该模型。' : response.status === 404 ? '检查 Base URL、接口路径和模型服务商文档。' : `HTTP ${response.status}`
        throw new Error(`${hint}${detail ? ` 服务端信息：${detail.slice(0, 240)}` : ''}`)
      }
      const data = await response.json()
      const content = data.choices?.[0]?.message?.content
      if (!content) throw new Error('接口响应缺少 choices[0].message.content')
      // finish_reason=length 表示模型触及输出上限，直接触发一次重试。
      if (data.choices?.[0]?.finish_reason === 'length') throw new SyntaxError('模型输出达到 token 上限，JSON 可能被截断。')
      // 临时输出原文以定位偶发的格式错误或截断位置。
      console.log('[LLM 原始返回]', content)
      const cleaned = content.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim()
      const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}')
      const parsed = JSON.parse(start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned)
      const required = ['text', 'type', 'pronunciation', 'partOfSpeech', 'definition', 'usage', 'etymology', 'semanticRoutes', 'comparisons', 'examples']
      const missing = required.filter(key => parsed[key] == null)
      // 至少要有一项；超出的内容截取到面板约定数量。
      if (missing.length || !parsed.etymology?.originalImage || !Array.isArray(parsed.semanticRoutes) || parsed.semanticRoutes.length < 1 || !Array.isArray(parsed.examples) || parsed.examples.length < 1 || !Array.isArray(parsed.comparisons) || parsed.comparisons.some(item => !item.word || !item.difference || !item.partOfSpeech)) throw new Error('模型返回的数据结构不完整，请重试。')
      // 保留最多两条例句和三条演变线路，避免多返回时报错。
      parsed.examples = parsed.examples.slice(0, 2)
      parsed.semanticRoutes = parsed.semanticRoutes.slice(0, 3)
      return parsed
    } catch (error) {
      lastError = error
      if (attempt === 0 && error instanceof SyntaxError) console.warn('[LLM JSON 解析失败，自动重试一次]', error.message)
      else if (!(error instanceof SyntaxError) || attempt === 1) throw error
    }
  }
  throw lastError
}
async function analyze(key) {
  selectedId.value = key; error.value = ''
  if (mockMap[key]) return
  // 当前句子的 id 与词条组成唯一缓存 key。
  const cacheKey = makeCacheKey(activePassage.value.id, key)
  if (cache.value[cacheKey]?.llmSuccess === true) return
  // Clear legacy placeholder cache entries; only successful model results are cached.
  if (cache.value[cacheKey]) delete cache.value[cacheKey]
  loading.value = true
  try {
    const parsed = await fetchWordContext(key, activePassage.value.sentence)
    // 只在当前句子对应的缓存槽写入成功解析，并升级缓存结构版本。
    cache.value[cacheKey] = { ...parsed, id: key, text: parsed.text || key, dynamic: true, llmSuccess: true, deepSchema: 4 }
  } catch (cause) {
    error.value = '解析请求未成功，当前显示临时说明；点击词语可重试。'
    console.error('[fetchWordContext]', { baseUrl: apiBaseUrl.value, model: apiModel.value, word: key, error: cause })
  } finally { loading.value = false }
}
async function translateSentence(sentence) {
  if (!apiKey.value.trim()) throw new Error('请先在设置中填写 API Key')
  const base = apiBaseUrl.value.trim().replace(/\/+$/, '')
  const response = await fetch('/api/llm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: base, model: apiModel.value.trim(), apiKey: apiKey.value.trim(), temperature: 0.4, messages: [{ role: 'system', content: '你是专业英语译者。将用户提供的英文句子译为自然、准确、流畅的简体中文，兼顾信、达、雅。只返回译文，不添加引号、解释或其他内容。' }, { role: 'user', content: sentence }] }) })
  if (!response.ok) throw new Error(`翻译服务暂不可用（${response.status}）`)
  const data = await response.json()
  const translation = data.choices?.[0]?.message?.content?.trim()
  if (!translation) throw new Error('未能生成译文')
  return translation
}
async function addPassage() {
  const sentence = draftSentence.value.trim(); if (!sentence) return
  translating.value = !draftTranslation.value.trim()
  let translation = draftTranslation.value.trim()
  try { if (!translation) translation = await translateSentence(sentence) }
  catch { error.value = '自动翻译暂不可用，请填写中文译文后重试。'; translating.value = false; return }
  translating.value = false
  const passage = { id: `custom-${Date.now()}`, sentence, translation }
  passages.value.push(passage); activePassageId.value = passage.id; draftSentence.value = ''; draftTranslation.value = ''; showForm.value = false
  const first = [...sentence.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)].find(m => !mockMap[normalize(m[0])])
  if (first) analyze(normalize(first[0]))
}
function playExample(text) {
  if (!('speechSynthesis' in window)) { error.value = '此浏览器不支持 Web Speech API'; return }
  if (speakingExample.value === text) { window.speechSynthesis.cancel(); speakingExample.value = ''; return }
  window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'en-US'; currentUtterance = utterance; speakingExample.value = text
  utterance.onend = utterance.onerror = () => { if (currentUtterance === utterance) { speakingExample.value = ''; currentUtterance = null } }
  window.speechSynthesis.speak(utterance)
}
</script>

<template>
  <main class="flex h-screen flex-col overflow-hidden bg-[#f7f6f2] text-[#23241f]">
    <div v-if="showLibrary" class="fixed inset-0 z-50 flex items-center justify-center bg-[#20251f66] p-4"
      @click.self="showLibrary = false">
      <section class="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <header class="flex items-center justify-between border-b border-[#eeece6] p-5">
          <div>
            <h2 class="font-serif text-2xl">语料句子库</h2>
            <p class="mt-1 text-xs text-[#92938a]">点击句子切换阅读</p>
          </div><button class="rounded-full px-3 py-2 text-sm text-[#777]" @click="showLibrary = false">关闭 ×</button>
        </header>
        <div class="p-4"><input v-model="passageSearch" placeholder="搜索英文句子或中文翻译"
            class="w-full rounded-lg border border-[#e8e6df] px-3 py-2 text-sm" /></div>
        <div class="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-4">
          <article v-for="passage in filteredPassages" :key="passage.id" class="flex gap-3 rounded-xl border p-4"
            :class="activePassageId === passage.id ? 'border-[#9bad96] bg-[#f4f6f1]' : 'border-[#eeece6]'"
            @click="activePassageId = passage.id; showLibrary = false">
            <div class="min-w-0 flex-1 text-left">
              <p class="text-sm leading-6">{{ sentencePreview(passage.sentence) }}<span
                  v-if="passage.sentence.trim().split(/\s+/).length > 8">…</span></p>
              <p class="mt-1.5 text-xs leading-5 text-[#92938a]">{{ passage.translation }}</p>
            </div><button v-if="passage.id !== 'default'" class="self-start rounded-md px-2 py-1 text-xs text-[#a36b5b]"
              @click.stop="passages = passages.filter(item => item.id !== passage.id); if (activePassageId === passage.id) activePassageId = passages[0]?.id || ''">删除</button>
          </article>
          <p v-if="!filteredPassages.length" class="py-8 text-center text-sm text-[#999]">没有匹配的句子</p>
        </div>
      </section>
    </div>
    <header class="flex h-[76px] items-center justify-between border-b border-[#e7e5df] px-6 md:px-12"><a
        class="flex items-center gap-3" href="#"><span
          class="grid h-9 w-9 place-items-center rounded-xl bg-[#273b32] text-sm font-semibold text-white">C.</span><span
          class="text-[15px] font-semibold tracking-tight">context<span class="text-[#9a9c91]"> /
            reader</span></span></a>
      <div class="hidden items-center gap-2 text-xs text-[#85877d] sm:flex"><span
          class="h-2 w-2 rounded-full bg-[#87a88d]"></span> A small study space</div><button
        class="rounded-full border border-[#e5e3dc] bg-white px-4 py-2 text-xs" @click="showSettings = !showSettings">⚙
        设置</button>
    </header>
    <div v-if="showSettings" class="shrink-0 overflow-y-auto border-b border-[#e8e6df] bg-[#f7f6f2] px-5 py-3 md:px-12">
      <div class="rounded-xl border border-[#e8e6df] bg-white p-5"><label class="text-xs font-medium">Base
          URL</label><input v-model="apiBaseUrl" type="url" placeholder="https://api.openai.com/v1"
          class="mt-2 w-full rounded-lg border border-[#e8e6df] px-3 py-2 text-sm outline-none focus:border-[#82917f]" /><label
          class="mt-4 block text-xs font-medium">Model</label><input v-model="apiModel"
          placeholder="gpt-4o-mini 或 deepseek-chat"
          class="mt-2 w-full rounded-lg border border-[#e8e6df] px-3 py-2 text-sm outline-none focus:border-[#82917f]" /><label
          class="mt-4 block text-xs font-medium">大模型 API Key <span class="text-[#999]">（保存在此浏览器）</span></label><input
          v-model="apiKey" type="password" autocomplete="off" placeholder="sk-…"
          class="mt-2 w-full rounded-lg border border-[#e8e6df] px-3 py-2 text-sm outline-none focus:border-[#82917f]" />
        <p class="mt-2 text-[11px] text-[#92938a]">点击未缓存词语时，通过本地 /api/llm 代理调用上方配置的兼容接口。
        </p>
      </div>
    </div>
    <div class="mx-auto flex min-h-0 w-full max-w-[1440px] flex-1 flex-col px-5 pb-5 pt-5 md:px-12 md:pt-6">
      <div class="mb-9 flex items-end justify-between">
        <div>
          <div class="mb-3 text-[10px] font-semibold uppercase tracking-[.22em] text-[#8c9284]">Reading in context <span
              class="px-1">·</span> 01</div>
          <h1 class="font-serif text-3xl tracking-[-.04em] md:text-[40px]">Words make sense <span
              class="italic text-[#82917f]">together.</span></h1>
          <p class="mt-3 text-sm text-[#898a81]">点亮的词语可以点击，看看它们在这里的意思。</p>
        </div>
        <div class="hidden text-right text-xs text-[#9a9b92] md:block">A short passage<br />Every word has a place</div>
      </div>
      <section
        class="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(38%,0.9fr)_minmax(0,1.1fr)] overflow-hidden rounded-2xl border border-[#e8e6df] bg-white shadow-[0_12px_40px_rgba(43,48,38,.035)] lg:grid-rows-1 lg:grid-cols-[1.02fr_.98fr]">
        <div
          class="flex min-h-0 flex-col overflow-y-auto border-b border-[#eeece6] p-4 md:p-8 lg:border-b-0 lg:border-r lg:p-10">
          <div class="flex items-center justify-between"><span
              class="text-[10px] font-semibold uppercase tracking-[.18em] text-[#9a9b91]">The passage</span>
            <div class="flex items-center gap-2"><button
                class="rounded-full border border-[#e9e8e1] bg-white px-3 py-1.5 text-[10px] text-[#62645c]"
                @click="showLibrary = true">语料库 · {{ passages.length }}</button><button
                class="rounded-full bg-[#273b32] px-3 py-1.5 text-[10px] text-white hover:bg-[#385344]"
                @click="showForm = !showForm">+ 新增句子</button></div>
          </div>
          <form v-if="showForm" class="mt-5 space-y-2 rounded-xl bg-[#f7f7f3] p-4" @submit.prevent="addPassage">
            <textarea v-model="draftSentence" required rows="2" placeholder="输入英文句子"
              class="w-full resize-y rounded-lg border border-[#e8e6df] bg-white p-3 text-sm outline-none focus:border-[#82917f]"></textarea><input
              v-model="draftTranslation" placeholder="对应的中文翻译（可选）"
              class="w-full rounded-lg border border-[#e8e6df] bg-white p-3 text-sm outline-none focus:border-[#82917f]" />
            <div class="flex justify-end gap-2"><button type="button" class="rounded-lg px-3 py-2 text-xs text-[#777]"
                @click="showForm = false">取消</button><button :disabled="translating"
                class="rounded-lg bg-[#273b32] px-4 py-2 text-xs text-white disabled:opacity-60">{{ translating ?
                '正在生成译文…' : '添加并解析' }}</button></div>
          </form>
          <div
            class="my-auto py-14 font-serif text-[27px] leading-[2.15] tracking-[-.02em] text-[#35372f] md:text-[32px]">
            <template v-for="(token, index) in tokens" :key="index"><button v-if="token.key" class="interactive-word"
                :class="{ 'active-word': selectedId === token.key }" @click="analyze(token.key)">{{ token.text
                }}</button><span v-else>{{ token.text }}</span></template>
          </div>
          <div class="border-t border-[#f0efe9] pt-5">
            <p class="text-[13px] leading-6 text-[#85877d]">{{ activePassage.translation }}</p>
            <p class="mt-2 text-[10px] text-[#b0b1a8]">↗ 点击高亮词语，查看语境中的解析</p>
          </div>
        </div>
        <div class="min-h-0 overflow-y-auto overscroll-contain">
          <Transition name="panel" mode="out-in">
            <article v-if="selected" :key="selected.id" class="p-6 md:p-10">
              <div class="flex items-center justify-between"><span
                  class="text-[10px] font-semibold uppercase tracking-[.18em] text-[#9a9b91]">Word notes</span><span
                  class="rounded-full border border-[#e9e8e1] px-3 py-1.5 text-[10px] text-[#888a80]">{{ selected.type
                    ===
                    'phrase' ? '短语' : '词汇' }}</span></div>
              <div v-if="selectedParts.length" class="mt-4 rounded-xl bg-[#f4f5f0] p-4">
                <p class="text-[10px] font-semibold uppercase tracking-[.16em] text-[#92958a]">词组组成 · 点击单词查看解析</p>
                <div class="mt-2 flex flex-wrap gap-2">
                  <button v-for="part in selectedParts" :key="part"
                    class="rounded-full border border-[#dfe5da] bg-white px-3 py-1.5 text-xs font-medium text-[#49634e] transition hover:border-[#9bad96] hover:bg-[#eaf0e6]"
                    @click="analyze(part.toLowerCase())">{{ part }}</button>
                </div>
              </div>
              <div class="mt-7 flex items-start justify-between gap-4">
                <div>
                  <h2 class="font-serif text-[36px] leading-tight tracking-[-.04em]">{{ selected.text }}</h2>
                  <div class="mt-2 flex gap-2 text-xs text-[#8c8e84]"><span>{{ selected.pronunciation
                      }}</span><span>·</span><span>{{ selected.partOfSpeech }}</span></div>
                </div><button
                  class="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-[#e6e5dd] text-[#657664]"
                  @click="playExample(selected.text)">▶</button>
              </div>
              <p class="mt-5 text-sm leading-7 text-[#696b62]">{{ selected.definition }}</p>
              <p v-if="loading" class="mt-3 text-xs text-[#82917f]">正在根据句子语境生成解析…</p>
              <p v-if="error" class="mt-2 text-xs text-[#a56d52]">{{ error }}</p>
              <div class="mt-7 rounded-xl bg-[#f4f5f0] p-4">
                <h3 class="section-label">语境中的核心用法 <span>IN CONTEXT</span></h3>
                <p class="mt-3 text-xs leading-6 text-[#62665d]">{{ selected.usage || selected.etymology }}</p>
              </div>
              <div v-if="typeof selected.etymology === 'object'" class="mt-6 border-t border-[#eeece6] pt-5">
                <h3 class="section-label">词源与原始画面 <span>ETYMOLOGY</span></h3>
                <p class="mt-3 text-xs leading-6 text-[#777970]">{{ selected.etymology.originalImage }}</p>
                <div class="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <div v-for="part in ['prefix', 'root', 'suffix']" :key="part" class="rounded-lg bg-[#f7f7f3] p-3">
                    <div class="text-[10px] uppercase tracking-wide text-[#999b91]">{{ part }}</div>
                    <div class="mt-1 text-[#55584f]">{{ selected.etymology[part] || '无' }}</div>
                  </div>
                </div>
                <p class="mt-3 text-xs leading-6 text-[#777970]">{{ selected.etymology.origin }} <span
                    v-if="selected.etymology.certainty">（{{ selected.etymology.certainty }}）</span></p>
              </div>
              <div v-else class="mt-6 border-t border-[#eeece6] pt-5">
                <h3 class="section-label">词源与构成 <span>ETYMOLOGY</span></h3>
                <p class="mt-3 text-xs leading-6 text-[#777970]">{{ selected.etymology }}</p>
              </div>
              <div v-if="selected.semanticRoutes?.length" class="mt-6 border-t border-[#eeece6] pt-5">
                <h3 class="section-label">语义演变线路 <span>SEMANTIC ROUTES</span></h3>
                <div v-for="route in selected.semanticRoutes" :key="route.label"
                  class="mt-3 rounded-lg border border-[#eeece6] p-3">
                  <div class="text-xs font-semibold text-[#4e6854]">{{ route.label }} <span
                      class="font-normal text-[#999b91]">·
                      {{ route.domain }}</span></div>
                  <p class="mt-1 text-xs leading-5 text-[#777970]">{{ route.steps }}</p>
                  <p class="mt-1 text-xs text-[#55584f]">现代含义：{{ route.modernMeaning }}</p>
                </div>
              </div>
              <div class="mt-6 border-t border-[#eeece6] pt-5">
                <h3 class="section-label">近义表达 <span>COMPARE</span></h3>
                <div class="mt-3 space-y-2.5">
                  <div v-for="item in selected.comparisons || []" :key="item.word" class="rounded-lg bg-[#f7f7f3] p-3">
                    <button
                      class="rounded-full bg-white px-2.5 py-1 font-semibold text-[#49634e] shadow-sm hover:bg-[#eaf0e6]"
                      @click="analyze(item.word.toLowerCase())">{{ item.word }}</button>
                    <span class="ml-2 text-[10px] text-[#999b91]">{{ item.partOfSpeech }}</span>
                    <p class="mt-2 text-xs leading-5 text-[#777970]">{{ item.difference }}</p>
                  </div>
                </div>
              </div>
              <div class="mt-6 border-t border-[#eeece6] pt-5">
                <h3 class="section-label">放进句子里 <span>EXAMPLES</span></h3>
                <div v-for="example in selected.examples || []" :key="example.text"
                  class="mt-3 rounded-xl bg-[#f7f7f3] p-4">
                  <div class="flex items-start gap-3">
                    <p class="flex-1 font-serif text-sm leading-6 text-[#43463f]">{{ example.text }}</p><button
                      class="text-xs text-[#71816f]" @click="playExample(example.text)">▶</button>
                  </div>
                  <p class="mt-1.5 text-[11px] text-[#999b91]">{{ example.translation }}</p>
                </div>
              </div>
            </article>
          </Transition>
        </div>
      </section>
      <div v-if="activePassage" class="mt-3 text-right text-[11px] text-[#999b91]">{{ activePassage.translation }}</div>
      <footer
        class="mt-3 hidden shrink-0 justify-between text-[10px] uppercase tracking-[.16em] text-[#aaa99f] sm:flex">
        <span>Learn a
          little,
          notice a lot.</span><span>Made for curious readers</span>
      </footer>
    </div>
  </main>
</template>

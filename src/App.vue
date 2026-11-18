<script setup>
import { computed, ref, watch, onBeforeUnmount, onMounted } from 'vue'
import { entries as mockEntries, passage as defaultPassage } from './data/entries.js'
import { supabase } from './lib/supabase.js'
import { calculateReviewSchedule, shuffled } from './lib/srs.js'
import { baseForm, escapeRegExp, inflectionForms, isInflectionNear, makeTargetMatcher, normalize, splitArticleSentences, tokenizeSentence } from './lib/text.js'
import { cacheWord, dedupeSentences, isTranslationMissing, makeCacheKey, mergeSentences, sentenceKey, sentencePreview } from './lib/sentences.js'
import { buildAnkiCsv, buildStarredNotesCsv } from './lib/csv.js'
import { createBackupJson, parseBackupData } from './lib/backup.js'
import { calculateStreakDays, localDateKey } from './lib/date.js'
import { readStorage, readStorageJson, writeStorage, writeStorageJson } from './lib/storage.js'
import { validateAnalysis, validateTranslations } from './lib/validate.js'
import { AiAccessError, requestLlm as sendLlmRequest } from './lib/llm-request.js'
import AuthModal from './components/AuthModal.vue'
import SettingsModal from './components/SettingsModal.vue'
import ImportConfirmModal from './components/ImportConfirmModal.vue'

const STORE = 'context-reader-state-v1'
const ecsAi = import.meta.env.VITE_AI_MODE === 'ecs'
const requestLlm = payload => sendLlmRequest(payload, { managed: ecsAi, auth: supabase?.auth })
const DEFAULT_PASSAGE = { id: 'default', sentence: 'After hours of driving, we finally found a quiet parking space behind the museum.', translation: '开了几个小时的车后，我们终于在博物馆后面找到一个安静的停车位。' }
const saved = readStorageJson(localStorage, STORE, {})
const passages = ref([DEFAULT_PASSAGE, ...(saved.passages || []).filter(p => p.id !== 'default')])
// 只恢复新版语境缓存，丢弃旧的单词级缓存。
const cache = ref(Object.fromEntries(Object.entries(saved.cache || {}).filter(([, value]) => value?.llmSuccess === true && value?.deepSchema === 4)))
const apiKey = ref(readStorage(localStorage, 'context-reader-api-key', '') || '')
const apiBaseUrl = ref(readStorage(localStorage, 'context-reader-base-url', '') || 'https://api.openai.com/v1')
const apiModel = ref(readStorage(localStorage, 'context-reader-model', '') || 'gpt-4o-mini')
const speakingExample = ref('')
let currentUtterance = null
const defaultBlurTranslation = ref(readStorage(localStorage, 'context-reader-blur-translation', null) !== 'false')
const translationVisible = ref(!defaultBlurTranslation.value)
const sentenceSpeaking = ref(false)
const sentenceSpeechRate = ref(1)
const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
let sentenceUtterance = null
const showForm = ref(false)
const addTab = ref('sentence')
const articleText = ref('')
const articleChecks = ref({})
const articleImportMessage = ref('')
const showLibrary = ref(false)
const passageSearch = ref('')
const pendingDeletes = ref({})
const deleteTimers = new Map()
const translationProgress = ref({ running: false, total: 0, completed: 0 })
const translationFailed = ref([])
const translationQueue = []
const translationQueuedKeys = new Set()
let translationWorkerActive = false
const showSettings = ref(false)
const draftSentence = ref('')
const draftTranslation = ref('')
const activePassageId = ref(passages.value[0].id)
const selectedId = ref('parking-space')
const selectionReady = ref(false)
const loading = ref(false)
const error = ref('')
const syncNotice = ref('')
const user = ref(null)
const showAuth = ref(false)
const authBusy = ref(false)
const authError = ref('')
const authMessage = ref('')
const authResetModeVersion = ref(0)
const authResetPasswordVersion = ref(0)
let authSubscription
const cloudSyncing = ref(false)
let cloudLoadSequence = 0
let lookupWriteQueue = Promise.resolve()
const importPrompt = ref(false)
const importCounts = ref({ sentences: 0, notes: 0 })
const importAttempt = ref(0)
const importDecisionUser = ref('')
const showWordBook = ref(false)
const wordBookView = ref('list')
const reviewMode = ref('flashcard')
const extraPractice = ref(false)
const practiceRound = ref([])
const practiceIndex = ref(0)
const wordBookFilter = ref('all')
const wordBookSort = ref('due')
const lookupCounts = ref({})
const flippedCard = ref(false)
const reviewCard = ref(null)
const clozeRound = ref([])
const clozeIndex = ref(0)
const clozeInput = ref('')
const clozeNear = ref(false)
const clozeAnswered = ref(false)
const clozeWasCorrect = ref(false)
const clozeCorrectCount = ref(0)
const clozeRoundFinished = ref(false)
const reviewStats = ref({ todayCount: 0, streakDays: 0 })
const storedDailyReviewGoal = Number(readStorage(localStorage, 'context-reader-daily-review-goal', null))
const dailyReviewGoal = ref([5, 10, 20, 30].includes(storedDailyReviewGoal)
  ? storedDailyReviewGoal
  : 10)
const goalCelebration = ref(false)
const dailyGoalProgress = computed(() => Math.min(100, (reviewStats.value.todayCount / dailyReviewGoal.value) * 100))
const contextCompletionCount = ref(0)
const contextProcessedWords = new Set()
let contextCompletionRunning = false
let contextCompletionPending = false
const starredNotes = computed(() => {
  const notes = Object.entries(cache.value).filter(([, value]) => value?.llmSuccess && value?.is_starred)
    .map(([cacheKey, value]) => ({ cacheKey, value, word: value.text || cacheKey.slice(cacheKey.indexOf('::') + 2) }))
    .filter(item => wordBookFilter.value === 'all' || (wordBookFilter.value === 'due' && (!item.value.next_review_at || new Date(item.value.next_review_at) <= new Date())))
  return notes.sort((a, b) => wordBookSort.value === 'lookup'
    ? (b.value.lookup_count || 0) - (a.value.lookup_count || 0)
    : new Date(a.value.next_review_at || 0) - new Date(b.value.next_review_at || 0))
})
const dueReviewNotes = computed(() => Object.entries(cache.value)
  .filter(([, value]) => value?.llmSuccess && value?.is_starred && (!value.next_review_at || new Date(value.next_review_at) <= new Date()))
  .map(([cacheKey, value]) => ({ cacheKey, value, word: value.text || cacheKey.slice(cacheKey.indexOf('::') + 2) }))
  .sort((a, b) => new Date(a.value.next_review_at || 0) - new Date(b.value.next_review_at || 0)))
const allStarredNotes = computed(() => Object.entries(cache.value)
  .filter(([, value]) => value?.llmSuccess && value?.is_starred)
  .map(([cacheKey, value]) => ({ cacheKey, value, word: value.text || cacheKey.slice(cacheKey.indexOf('::') + 2) })))
const clozeReviewNotes = computed(() => dueReviewNotes.value.filter(note => {
  const sentence = String(note.value.context_sentence || '').trim()
  if (!sentence) return false
  try { return makeTargetMatcher(note.word).test(sentence) } catch { return false }
}))
const allClozeNotes = computed(() => allStarredNotes.value.filter(note => {
  const sentence = String(note.value.context_sentence || '').trim()
  if (!sentence) return false
  try { return makeTargetMatcher(note.word).test(sentence) } catch { return false }
}))
const clozeMaskedSentence = computed(() => {
  const sentence = String(reviewCard.value?.value?.context_sentence || '')
  if (!sentence || !reviewCard.value?.word) return ''
  try { return sentence.replace(makeTargetMatcher(reviewCard.value.word), match => '_'.repeat(match.length)) } catch { return sentence }
})
const activePassage = computed(() => passages.value.find(p => p.id === activePassageId.value) || passages.value[0])
function restoreCurrentSelection(markReady = true) {
  let savedSelection = null
  savedSelection = readStorageJson(localStorage, 'crr:current', null)
  const target = savedSelection?.english
    ? passages.value.find(passage => passage.sentence.trim() === savedSelection.english.trim())
    : null
  activePassageId.value = (target || passages.value[0])?.id || ''
  if (savedSelection?.word) selectedId.value = savedSelection.word
  selectionReady.value = markReady
}
const availablePassages = computed(() => passages.value.filter(p => !pendingDeletes.value[p.id]))
const missingTranslationPassages = computed(() => availablePassages.value.filter(passage => isTranslationMissing(passage.translation)))
const failedTranslationCount = computed(() => translationFailed.value.filter(key => availablePassages.value.some(passage => passage.sentence.trim().toLowerCase() === key)).length)
const filteredPassages = computed(() => availablePassages.value.filter(p => `${p.sentence} ${p.translation}`.toLowerCase().includes(passageSearch.value.trim().toLowerCase())))
const articleSentences = computed(() => splitArticleSentences(articleText.value))
const checkedArticleSentences = computed(() => articleSentences.value.filter((_, index) => articleChecks.value[index] !== false))
const activePassageIndex = computed(() => availablePassages.value.findIndex(p => p.id === activePassageId.value))
const undoDeleteNotice = computed(() => Object.values(pendingDeletes.value).at(-1) || null)
const mockMap = Object.fromEntries(mockEntries.map(entry => [entry.text.toLowerCase(), entry]))
// 面板按当前句子与词条共同读取缓存，避免跨句复用解析。
const selected = computed(() => cache.value[makeCacheKey(activePassage.value.id, selectedId.value)] || mockMap[selectedId.value] || placeholder(selectedId.value))
const selectedParts = computed(() => selected.value?.type === 'phrase'
  ? selected.value.text.trim().split(/\s+/).filter(Boolean)
  : [])
watch([passages, cache], () => {
  if (user.value) return
  const safeCache = Object.fromEntries(Object.entries(cache.value).map(([key, value]) => {
    const { is_starred, review_count, next_review_at, ...analysis } = value || {}
    return [key, analysis]
  }))
  writeStorageJson(localStorage, STORE, { passages: [DEFAULT_PASSAGE, ...passages.value.filter(p => p.id !== 'default')], cache: safeCache })
}, { deep: true })
watch(apiKey, value => writeStorage(localStorage, 'context-reader-api-key', value))
watch(apiBaseUrl, value => writeStorage(localStorage, 'context-reader-base-url', value))
watch(apiModel, value => writeStorage(localStorage, 'context-reader-model', value))
watch(dailyReviewGoal, value => writeStorage(localStorage, 'context-reader-daily-review-goal', value))
watch([activePassageId, selectedId], () => {
  if (!selectionReady.value || !activePassage.value?.sentence) return
  writeStorageJson(localStorage, 'crr:current', { english: activePassage.value.sentence.trim(), word: selectedId.value })
})
watch(articleText, () => { articleChecks.value = {}; articleImportMessage.value = '' })
watch(defaultBlurTranslation, value => {
  writeStorage(localStorage, 'context-reader-blur-translation', value)
  translationVisible.value = !value
})
watch(activePassageId, () => {
  translationVisible.value = !defaultBlurTranslation.value
  stopSentenceSpeech()
})
onBeforeUnmount(() => window.speechSynthesis?.cancel())
onMounted(async () => {
  if (!supabase) { user.value = null; return }
  const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
    const nextUser = session?.user || null
    const currentId = user.value?.id || null
    const nextId = nextUser?.id || null
    if (event === 'SIGNED_OUT') { user.value = null; return }
    if (nextId && nextId !== currentId) user.value = nextUser
  })
  authSubscription = subscription
  const { data, error: sessionError } = await supabase.auth.getSession()
  if (sessionError) authError.value = sessionError.message
  const sessionUser = data.session?.user || null
  if ((user.value?.id || null) !== (sessionUser?.id || null)) user.value = sessionUser
})
onBeforeUnmount(() => authSubscription?.unsubscribe())
watch([() => user.value?.id || null, importAttempt], async ([nextUserId]) => {
  const nextUser = user.value
  const sequence = ++cloudLoadSequence
  selectionReady.value = false
  if (!supabase || !nextUser) {
    try { const local = readStorageJson(localStorage, STORE, {}); passages.value = [DEFAULT_PASSAGE, ...(local.passages || []).filter(p => p.id !== 'default')]; cache.value = Object.fromEntries(Object.entries(local.cache || {}).map(([key, value]) => { const { is_starred, review_count, next_review_at, ...rest } = value || {}; return [key, rest] })); restoreCurrentSelection() } catch { passages.value = [DEFAULT_PASSAGE]; restoreCurrentSelection() }
    return
  }
  cloudSyncing.value = true
  let syncFailed = false
  try {
    const [{ data: cloudSentences, error: sentenceError }, { data: cloudNotes, error: notesError }] = await Promise.all([
      supabase.from('sentences').select('id,user_id,english,chinese,created_at').eq('user_id', nextUser.id).order('created_at', { ascending: true }),
      supabase.from('word_notes').select('word,data,is_starred,review_count,next_review_at,lookup_count,updated_at').eq('user_id', nextUser.id),
    ])
    if (sequence !== cloudLoadSequence) return
    if (sentenceError) throw sentenceError
    if (notesError) throw notesError
    lookupCounts.value = Object.fromEntries((cloudNotes || []).map(row => [row.word.trim().toLowerCase(), Number(row.lookup_count) || 0]))
    const local = readStorageJson(localStorage, STORE, {})
    const promptKey = `context-reader-import-decided:${nextUser.id}`
    const localSentenceCandidates = (local.passages || []).filter(p => p.id !== 'default' && p.sentence?.trim())
    const localReviewCandidates = Object.values(local.cache || {}).filter(value => value?.llmSuccess && (value.is_starred || (value.review_count || 0) > 0))
    const decidedThisLogin = sessionStorage.getItem(promptKey) === '1'
    if (!decidedThisLogin && importDecisionUser.value !== nextUser.id && (localSentenceCandidates.length || localReviewCandidates.length)) {
      importCounts.value = { sentences: new Set(localSentenceCandidates.map(p => p.sentence.trim())).size, notes: new Set(localReviewCandidates.map(value => String(value.text || '').trim().toLowerCase()).filter(Boolean)).size }
      passages.value = [DEFAULT_PASSAGE, ...(cloudSentences || []).filter(row => row.english?.trim() !== DEFAULT_PASSAGE.sentence.trim()).map(row => ({ id: row.id, sentence: row.english, translation: row.chinese || '' }))]
      activePassageId.value = passages.value[0].id
      cache.value = Object.fromEntries((cloudNotes || []).filter(row => row.data?.analysis).map(row => [makeCacheKey(row.data.passageId || passages.value[0].id, row.word), { ...row.data.analysis, context_sentence: row.data.context_sentence || row.data.analysis.context_sentence, context_translation: row.data.context_translation || row.data.analysis.context_translation, id: row.word, is_starred: row.is_starred, review_count: row.review_count, next_review_at: row.next_review_at, lookup_count: Number(row.lookup_count) || 0, llmSuccess: true, deepSchema: 4 }]))
      restoreCurrentSelection(false)
      importPrompt.value = true
      cloudSyncing.value = false
      return
    }
    sessionStorage.setItem(promptKey, '1')
    const byEnglish = new Map()
    for (const row of cloudSentences || []) {
      const normalized = row.english?.trim()
      if (normalized && !byEnglish.has(normalized)) byEnglish.set(normalized, row)
    }
    const localSentenceMap = new Map()
    for (const item of (local.passages || []).filter(p => p.id !== 'default')) {
      const english = item.sentence?.trim()
      if (english && !byEnglish.has(english) && !localSentenceMap.has(english)) localSentenceMap.set(english, item)
    }
    const localOnly = [...localSentenceMap.values()]
    const idMap = new Map()
    if (localOnly.length) {
      // 用去重 upsert 迁移，trim 英文句子且不提交本地 custom-* ID。
      const { error } = await supabase.from('sentences').upsert(localOnly.map(item => ({ user_id: nextUser.id, english: item.sentence.trim(), chinese: item.translation || '' })), { onConflict: 'user_id,english', ignoreDuplicates: true })
      if (error) { syncFailed = true; syncNotice.value = '云端同步失败，已保存在本地'; console.error('[Supabase sentences migration]', error) }
    }
    // 重新读取以取得数据库生成的 UUID（含已存在而被 ignoreDuplicates 跳过的记录）。
    const { data: refreshedSentences, error: refreshError } = await supabase.from('sentences').select('id,user_id,english,chinese,created_at').eq('user_id', nextUser.id).order('created_at', { ascending: true })
    if (refreshError) throw refreshError
    const sentenceRows = []
    const seenEnglish = new Set()
    for (const row of refreshedSentences || []) {
      const normalized = row.english?.trim()
      if (!normalized || seenEnglish.has(normalized)) continue
      seenEnglish.add(normalized); sentenceRows.push(row); byEnglish.set(normalized, row)
    }
    // 将原本地句子 ID 映射到云端 UUID，关联缓存 key 也随之迁移。
    for (const item of local.passages || []) {
      const cloudRow = byEnglish.get(item.sentence?.trim())
      if (cloudRow) idMap.set(item.id, cloudRow.id)
    }
    const migratedPassages = sentenceRows.map(row => ({ id: row.id, sentence: row.english.trim(), translation: row.chinese || '' }))
    passages.value = [DEFAULT_PASSAGE, ...sentenceRows.filter(row => row.english.trim() !== DEFAULT_PASSAGE.sentence.trim()).map(row => ({ id: row.id, sentence: row.english, translation: row.chinese || '' }))]
    activePassageId.value = passages.value[0]?.id || ''
    const syncedCache = {}
    for (const row of cloudNotes || []) {
      const sentenceId = row.data?.passageId
      if (sentenceId && row.data?.analysis) syncedCache[makeCacheKey(sentenceId, row.word)] = { ...row.data.analysis, context_sentence: row.data.context_sentence || row.data.analysis.context_sentence, context_translation: row.data.context_translation || row.data.analysis.context_translation, id: row.word, is_starred: row.is_starred, review_count: row.review_count, next_review_at: row.next_review_at, lookup_count: Number(row.lookup_count) || 0, llmSuccess: true, deepSchema: 4 }
      else if (passages.value[0] && row.data) syncedCache[makeCacheKey(passages.value[0].id, row.word)] = { ...(row.data?.analysis || row.data), context_sentence: row.data?.context_sentence || row.data?.analysis?.context_sentence, context_translation: row.data?.context_translation || row.data?.analysis?.context_translation, id: row.word, is_starred: row.is_starred, review_count: row.review_count, next_review_at: row.next_review_at, lookup_count: Number(row.lookup_count) || 0, llmSuccess: true, deepSchema: 4 }
    }
    cache.value = syncedCache
    // 登录后把本机已学词条补传到云端，之后以云端数据为准。
    // 句子 ID 改为云端 UUID 时，同步重写本地词条缓存 key 和 data 中的 passageId。
    const localCache = {}
    for (const [oldKey, value] of Object.entries(local.cache || {})) {
      const split = oldKey.indexOf('::'); const oldPassageId = oldKey.slice(0, split)
      const newPassageId = idMap.get(oldPassageId) || oldPassageId
      const nextKey = makeCacheKey(newPassageId, oldKey.slice(split + 2))
      localCache[nextKey] = value
    }
    // 界面以云端拉取结果为准；本地缓存只作为后台补传来源，不覆盖云端内容。
    cache.value = syncedCache
    const cloudNotesByWord = new Map()
    for (const row of cloudNotes || []) {
      const normalized = row.word?.trim().toLowerCase()
      if (!normalized) continue
      const previous = cloudNotesByWord.get(normalized)
      if (!previous || new Date(row.updated_at || 0) > new Date(previous.updated_at || 0)) cloudNotesByWord.set(normalized, row)
    }
    const localNoteByWord = new Map()
    for (const [cacheKey, value] of Object.entries(localCache)) {
      if (!value?.llmSuccess || (!value.is_starred && !(value.review_count > 0))) continue
      const split = cacheKey.indexOf('::'); const word = cacheKey.slice(split + 2).trim().toLowerCase()
      if (!word) continue
      const cloud = cloudNotesByWord.get(word)
      const dataIsLocalNewer = !cloud || !cloud.data || new Date(value.updated_at || 0) > new Date(cloud.updated_at || 0)
      const row = { user_id: nextUser.id, word, data: dataIsLocalNewer ? { passageId: cacheKey.slice(0, split), analysis: value } : cloud.data, is_starred: cloud ? cloud.is_starred : !!value.is_starred, review_count: cloud ? cloud.review_count : value.review_count || 0, next_review_at: cloud ? cloud.next_review_at : value.next_review_at || new Date().toISOString(), lookup_count: cloud ? Number(cloud.lookup_count) || 0 : Number(value.lookup_count) || 0, updated_at: cloud?.updated_at && !dataIsLocalNewer ? cloud.updated_at : value.updated_at || new Date().toISOString() }
      const previous = localNoteByWord.get(word)
      if (!previous || new Date(row.updated_at) > new Date(previous.updated_at)) localNoteByWord.set(word, row)
    }
    const noteRows = [...localNoteByWord.values()]
    if (noteRows.length) {
      // 补传失败只记录日志，不回滚或覆盖已展示的云端数据。
      const { error } = await supabase.from('word_notes').upsert(noteRows, { onConflict: 'user_id,word' })
      if (error) { syncNotice.value = '云端同步失败，已保存在本地'; console.error('[Supabase word_notes migration]', error) }
      else {
        const cleanedLocalCache = Object.fromEntries(Object.entries(local.cache || {}).map(([key, value]) => { const { is_starred, review_count, next_review_at, ...rest } = value || {}; return [key, rest] }))
        writeStorageJson(localStorage, STORE, { passages: [DEFAULT_PASSAGE], cache: cleanedLocalCache })
      }
    }
    // 持久化 UUID 映射，刷新后语料和解析缓存仍使用一致的云端 ID。
    // 用云端 UUID 句子列表替换本地临时句子，避免后续登录重复迁移。
    if (!syncFailed) {
      // 账号云端数据不反写为匿名本地语料，退出登录仍只显示默认句与本地自有句。
      const localCacheNoReview = Object.fromEntries(Object.entries(local.cache || {}).map(([key, value]) => { const { is_starred, review_count, next_review_at, ...rest } = value || {}; return [key, rest] }))
      writeStorageJson(localStorage, STORE, { passages: [DEFAULT_PASSAGE], cache: localCacheNoReview })
      syncNotice.value = ''
    }
    restoreCurrentSelection()
  } catch (cause) {
    if (sequence === cloudLoadSequence) { syncNotice.value = '云端同步失败，已保存在本地'; console.error('[Supabase sync]', cause); passages.value = [DEFAULT_PASSAGE, ...passages.value.filter(p => p.id !== 'default')]; restoreCurrentSelection() }
  } finally { if (sequence === cloudLoadSequence) cloudSyncing.value = false }
}, { immediate: true })

function decideImport(shouldImport) {
  const currentUserId = user.value?.id
  if (!currentUserId) { importPrompt.value = false; restoreCurrentSelection(); return }
  sessionStorage.setItem(`context-reader-import-decided:${currentUserId}`, '1')
  importDecisionUser.value = currentUserId
  importPrompt.value = false
  if (shouldImport) importAttempt.value++
  else restoreCurrentSelection()
}

async function saveCloudSentence(passage) {
  if (!supabase || !user.value || cloudSyncing.value) return
  const english = passage.sentence.trim()
  const { error } = await supabase.from('sentences').upsert({ user_id: user.value.id, english, chinese: passage.translation || '' }, { onConflict: 'user_id,english', ignoreDuplicates: true })
  if (error) { console.error('[Supabase sentence save]', error); return }
  const { data, error: lookupError } = await supabase.from('sentences').select('id').eq('user_id', user.value.id).eq('english', english).single()
  if (lookupError) { console.error('[Supabase sentence lookup]', lookupError); return }
  const oldId = passage.id
  passage.id = data.id
  if (activePassageId.value === oldId) activePassageId.value = data.id
  const remapped = {}
  for (const [key, value] of Object.entries(cache.value)) {
    const split = key.indexOf('::')
    remapped[split >= 0 && key.slice(0, split) === oldId ? makeCacheKey(data.id, key.slice(split + 2)) : key] = value
  }
  cache.value = remapped
  await saveOrRemapCloudNotes(oldId, data.id)
}
async function saveOrRemapCloudNotes(oldId, newId) {
  if (!supabase || !user.value) return
  for (const [key, value] of Object.entries(cache.value)) {
    if (!key.startsWith(`${newId}::`) || !value?.llmSuccess) continue
    await saveCloudNote(key.slice(key.indexOf('::') + 2), newId, value)
  }
}
async function deleteCloudSentence(id) {
  if (!supabase || !user.value) return
  const { error } = await supabase.from('sentences').delete().eq('id', id).eq('user_id', user.value.id)
  if (error) console.error('[Supabase sentence delete]', error)
}
async function recordLookup(word, cacheKey) {
  if (!supabase || !user.value) return
  const normalized = word.trim().toLowerCase()
  const current = cache.value[cacheKey]
  const count = Math.max(Number(lookupCounts.value[normalized]) || 0, Number(current?.lookup_count) || 0) + 1
  lookupCounts.value = { ...lookupCounts.value, [normalized]: count }
  const nextCache = { ...cache.value }
  for (const [key, value] of Object.entries(nextCache)) {
    const split = key.indexOf('::')
    if ((split >= 0 ? key.slice(split + 2) : key).trim().toLowerCase() === normalized) nextCache[key] = { ...value, lookup_count: count }
  }
  if (current) nextCache[cacheKey] = { ...current, lookup_count: count }
  cache.value = nextCache
  // 尚无成功解析缓存时只在内存累计，整行解析写入时再带上次数。
  if (!current?.llmSuccess) return
  const userId = user.value.id
  lookupWriteQueue = lookupWriteQueue.catch(() => {}).then(async () => {
    if (!supabase || user.value?.id !== userId) return
    const latestCount = Math.max(count, Number(lookupCounts.value[normalized]) || 0)
    const { error } = await supabase.from('word_notes').update({ lookup_count: latestCount }).eq('user_id', userId).eq('word', normalized)
    if (error) throw error
  })
  try { await lookupWriteQueue } catch (cause) {
    syncNotice.value = '云端同步失败，已保存在本地'
    console.error('[Supabase lookup_count save]', cause)
  }
}
async function saveCloudNote(word, passageId, value, includeReviewFields = true) {
  if (!supabase || !user.value) return
  // 占位说明仅供临时展示，任何保存入口都不把它写入云端。
  if (String(value?.definition || '').includes('语境占位说明')) return
  const normalized = word.trim().toLowerCase()
  const payload = { user_id: user.value.id, word: normalized, data: { passageId, analysis: value, context_sentence: value.context_sentence || null, context_translation: value.context_translation || null }, updated_at: new Date().toISOString() }
  if (includeReviewFields) Object.assign(payload, { is_starred: !!value.is_starred, review_count: value.review_count || 0, next_review_at: value.next_review_at || new Date().toISOString() })
  if (value.lookup_count != null || lookupCounts.value[normalized] != null) payload.lookup_count = Math.max(Number(value.lookup_count) || 0, Number(lookupCounts.value[normalized]) || 0)
  const { error } = await supabase.from('word_notes').upsert(payload, { onConflict: 'user_id,word' })
  if (error) { syncNotice.value = '云端同步失败，已保存在本地'; console.error('[Supabase word note save]', error) }
}
async function toggleStar() {
  if (!supabase) return
  if (!user.value) { authMessage.value = '请先登录后使用生词本'; showAuth.value = true; return }
  if (loading.value || selected.value?.definition?.includes('语境占位说明')) return
  const cacheKey = makeCacheKey(activePassage.value.id, selectedId.value)
  const current = cache.value[cacheKey] || selected.value
  const updated = { ...current, is_starred: !current.is_starred, review_count: current.review_count || 0, next_review_at: current.next_review_at || new Date().toISOString() }
  cache.value[cacheKey] = updated
  await saveCloudNote(selectedId.value, activePassage.value.id, updated)
}
function openWordBook() {
  if (!supabase) return
  if (!user.value) { authMessage.value = '请先登录后使用生词本'; showAuth.value = true; return }
  wordBookView.value = 'list'
  reviewCard.value = null
  goalCelebration.value = false
  showWordBook.value = true
  loadReviewStats()
  void completeMissingContexts()
}
function startReview(mode, extra = false) {
  reviewMode.value = mode
  extraPractice.value = extra
  wordBookView.value = 'review'
  flippedCard.value = false
  clozeInput.value = ''
  clozeNear.value = false
  clozeAnswered.value = false
  clozeWasCorrect.value = false
  clozeCorrectCount.value = 0
  clozeRoundFinished.value = false
  const source = extra
    ? (mode === 'cloze' ? allClozeNotes.value : allStarredNotes.value)
    : (mode === 'cloze' ? clozeReviewNotes.value : dueReviewNotes.value)
  const items = extra ? shuffled(source) : [...source]
  practiceRound.value = mode === 'flashcard' ? items : []
  practiceIndex.value = 0
  if (mode === 'cloze') {
    clozeRound.value = items
    clozeIndex.value = 0
    reviewCard.value = clozeRound.value[0] || null
  } else {
    clozeRound.value = []
    clozeIndex.value = 0
    reviewCard.value = practiceRound.value[0] || null
  }
}
function returnToWordBookList() {
  wordBookView.value = 'list'
  reviewCard.value = null
  flippedCard.value = false
  extraPractice.value = false
}
function notifyContextCorpusChanged() {
  contextProcessedWords.clear()
  if (showWordBook.value) void completeMissingContexts()
}
function updateLocalContextCache(updatedEntries) {
  let local = {}
  local = readStorageJson(localStorage, STORE, {})
  const localCache = { ...(local.cache || {}) }
  for (const [key, value] of updatedEntries) {
    const { is_starred, review_count, next_review_at, ...safeValue } = value
    localCache[key] = safeValue
  }
  writeStorageJson(localStorage, STORE, { ...local, cache: localCache })
}
async function completeMissingContexts() {
  if (contextCompletionRunning) { contextCompletionPending = true; return }
  contextCompletionRunning = true
  try {
    do {
      contextCompletionPending = false
      const revisionUser = user.value?.id || 'local'
      let completedThisRun = 0
      const entries = Object.entries(cache.value).filter(([, value]) => value?.llmSuccess && !String(value.context_sentence || value.data?.context_sentence || value.data?.analysis?.context_sentence || '').trim())
      for (const [cacheKey, value] of entries) {
        const word = cacheWord(cacheKey, value)
        const normalizedWord = word.toLowerCase()
        const processedKey = `${revisionUser}::${normalizedWord}`
        if (!normalizedWord || contextProcessedWords.has(processedKey)) continue
        contextProcessedWords.add(processedKey)
        let matcher
        try { matcher = new RegExp(`(?<![A-Za-z])${escapeRegExp(word)}(?![A-Za-z])`, 'i') } catch (cause) { console.error('[Word context matcher]', { word, error: cause }); continue }
        const matchingPassage = passages.value.find(passage => matcher.test(passage.sentence))
        if (!matchingPassage) continue
        const contextSentence = matchingPassage.sentence.trim()
        const contextTranslation = String(matchingPassage.translation || '').trim()
        const matchingEntries = Object.entries(cache.value).filter(([key, item]) => item?.llmSuccess && cacheWord(key, item).toLowerCase() === normalizedWord)
        const updatedEntries = matchingEntries.map(([key, item]) => [key, { ...item, context_sentence: contextSentence, ...(contextTranslation ? { context_translation: contextTranslation } : {}) }])
        cache.value = { ...cache.value, ...Object.fromEntries(updatedEntries) }
        updateLocalContextCache(updatedEntries)
        completedThisRun++

        if (supabase && user.value) {
          try {
            const userId = user.value.id
            const { data: note, error: readError } = await supabase.from('word_notes').select('data').eq('user_id', userId).eq('word', normalizedWord).maybeSingle()
            if (readError) throw readError
            const data = note?.data && typeof note.data === 'object' ? { ...note.data } : { passageId: cacheKey.slice(0, cacheKey.indexOf('::')), analysis: value }
            data.context_sentence = contextSentence
            if (contextTranslation) data.context_translation = contextTranslation
            const { error: updateError } = await supabase.from('word_notes').update({ data }).eq('user_id', userId).eq('word', normalizedWord)
            if (updateError) console.error('[Supabase context completion]', updateError)
          } catch (cause) { console.error('[Supabase context completion]', cause) }
        }
      }
      if (completedThisRun) contextCompletionCount.value += completedThisRun
    } while (contextCompletionPending)
  } finally { contextCompletionRunning = false }
}
async function loadReviewStats() {
  if (!supabase || !user.value) return
  const { data, error } = await supabase.from('review_logs').select('word,reviewed_at').eq('user_id', user.value.id).order('reviewed_at', { ascending: false }).limit(10000)
  if (error) { console.error('[Supabase review stats]', error); return }
  const today = new Date(); const todayKey = localDateKey(today)
  // 今日进度按 review_logs 记录条数统计，闪卡和填空都会各记一条。
  reviewStats.value.todayCount = (data || []).filter(row => localDateKey(row.reviewed_at) === todayKey).length
  reviewStats.value.streakDays = calculateStreakDays(data || [], today)
  // 账号与本地日期共同作为键，确保达标祝贺每天只出现一次。
  const celebrationKey = `context-reader-daily-goal-celebrated:${user.value.id}:${todayKey}`
  if (reviewStats.value.todayCount >= dailyReviewGoal.value && !readStorage(localStorage, celebrationKey)) {
    writeStorage(localStorage, celebrationKey, '1')
    goalCelebration.value = true
  }
}
function exportStarredCsv() {
  downloadFile('english-context-starred.csv', buildStarredNotesCsv(starredNotes.value), 'text/csv;charset=utf-8')
}
async function markReviewed(rating, advance = true) {
  if (!reviewCard.value) return
  const { cacheKey, value, word } = reviewCard.value
  // 加练只浏览并反馈，不改变复习计划或写入复习日志。
  if (extraPractice.value) {
    if (advance && reviewMode.value === 'flashcard') {
      practiceIndex.value++
      reviewCard.value = practiceRound.value[practiceIndex.value] || null
    }
    flippedCard.value = false
    return
  }
  const previousCount = value.review_count || 0
  const { count, nextReviewAt } = calculateReviewSchedule(rating, previousCount)
  const updated = { ...value, review_count: count, next_review_at: nextReviewAt, is_starred: true }
  cache.value[cacheKey] = updated
  const split = cacheKey.indexOf('::'); const passageId = cacheKey.slice(0, split)
  await saveCloudNote(word.toLowerCase(), passageId, updated)
  const result = rating === '认识' ? 'know' : rating === '模糊' ? 'vague' : 'unknown'
  try {
    if (supabase && user.value) {
    const { error } = await supabase.from('review_logs').insert({ user_id: user.value.id, word: word.trim().toLowerCase(), result, reviewed_at: new Date().toISOString() })
    if (error) throw error
    await loadReviewStats()
    }
  } catch (cause) { console.error('[Supabase review log insert]', cause) }
  if (advance) reviewCard.value = dueReviewNotes.value.find(item => item.cacheKey !== cacheKey) || null
  flippedCard.value = false
}
async function submitClozeAnswer() {
  if (!reviewCard.value || clozeAnswered.value) return
  const answer = clozeInput.value.trim().toLowerCase().replace(/\s+/g, ' ')
  const target = reviewCard.value.word.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!answer) return
  if (answer === target) {
    clozeNear.value = false
    clozeAnswered.value = true
    clozeWasCorrect.value = true
    clozeCorrectCount.value++
    await markReviewed('认识', false)
  } else if (isInflectionNear(answer, target)) {
    clozeNear.value = true
  } else {
    clozeNear.value = false
    clozeAnswered.value = true
    clozeWasCorrect.value = false
    await markReviewed('不认识', false)
  }
}
async function revealClozeAnswer() {
  if (!reviewCard.value || clozeAnswered.value) return
  clozeNear.value = false
  clozeAnswered.value = true
  clozeWasCorrect.value = false
  await markReviewed('不认识', false)
}
function advanceClozeQuestion() {
  if (!clozeAnswered.value) return
  const nextIndex = clozeIndex.value + 1
  clozeNear.value = false
  clozeInput.value = ''
  clozeAnswered.value = false
  clozeWasCorrect.value = false
  if (nextIndex >= clozeRound.value.length) {
    clozeRoundFinished.value = true
    reviewCard.value = null
    return
  }
  clozeIndex.value = nextIndex
  reviewCard.value = clozeRound.value[nextIndex]
}

function openLoginModal() {
  authError.value = ''; authMessage.value = ''
  authResetModeVersion.value++
  showAuth.value = true
}
async function submitAuth({ mode, email, password }) {
  if (!supabase) return
  authBusy.value = true; authError.value = ''; authMessage.value = ''
  try {
    const result = mode === 'login'
      ? await supabase.auth.signInWithPassword({ email: email.trim(), password })
      : await supabase.auth.signUp({ email: email.trim(), password, ...(ecsAi && { options: { emailRedirectTo: window.location.origin } }) })
    if (result.error) throw result.error
    if (mode === 'register' && !result.data.session) {
      authMessage.value = '注册成功，请检查邮箱并完成验证后登录。'
    } else {
      user.value = result.data.user
      showAuth.value = false
      authResetPasswordVersion.value++
    }
  } catch (cause) {
    authError.value = cause.message || '认证失败，请检查邮箱和密码后重试。'
  } finally { authBusy.value = false }
}
async function signOut() {
  if (!supabase) { user.value = null; return }
  if (user.value?.id) sessionStorage.removeItem(`context-reader-import-decided:${user.value.id}`)
  const { error: signOutError } = await supabase.auth.signOut()
  if (signOutError) authError.value = signOutError.message
  else user.value = null
}

function downloadFile(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  URL.revokeObjectURL(url)
}
function exportBackup() {
  downloadFile('english-context-backup.json', createBackupJson(passages.value, cache.value), 'application/json;charset=utf-8')
}
function importBackup(event) {
  const file = event.target.files?.[0]; if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const data = parseBackupData(reader.result)
      passages.value = data.passages
      cache.value = data.cache
      notifyContextCorpusChanged()
      activePassageId.value = passages.value[0]?.id || ''
      writeStorageJson(localStorage, STORE, { passages: passages.value, cache: cache.value })
      error.value = ''
    } catch { error.value = '备份文件格式不正确，未导入。' }
    event.target.value = ''
  }
  reader.readAsText(file)
}
function exportAnki() {
  downloadFile('english-context-anki.csv', buildAnkiCsv(cache.value, passages.value), 'text/csv;charset=utf-8')
}

const fixedPhrases = ['parking space', 'look at']
const tokens = computed(() => {
  const sentence = activePassage.value?.sentence || ''
  const knownPhrases = new Set(fixedPhrases)
  for (const phrase of Object.keys(mockMap)) if (phrase.includes(' ')) knownPhrases.add(phrase)
  for (const key of Object.keys(cache.value)) {
    const separator = key.indexOf('::')
    const phrase = key.slice(separator + 2)
    if (cache.value[key] && separator >= 0 && key.slice(0, separator) === activePassage.value?.id && phrase.includes(' ')) knownPhrases.add(phrase)
  }
  return tokenizeSentence(sentence, knownPhrases)
})

function placeholder(word) {
  const lemma = baseForm(word); const likelyVerb = /(?:ing|ed)$/.test(word) || ['is', 'are', 'was', 'were', 'has', 'have', 'do', 'does'].includes(word)
  return { id: word, text: word, type: 'word', pronunciation: '点击播放发音', partOfSpeech: likelyVerb ? '可能是动词 / 形容词（需结合语境确认）' : '词性需结合语境确认', definition: `语境占位说明：在“${activePassage.value.sentence}”中，${word} 的具体含义需要结合上下文确认。`, etymology: `原型推断：${lemma}${lemma !== word ? `（从 ${word} 还原的可能原型）` : '（当前词形）'}。此为规则推断，并非词典结论。`, comparisons: [{ word: 'similar', note: '可尝试使用含义相近的表达，具体替换需结合语境。' }, { word: 'related', note: '选择同主题词汇时注意搭配与语气。' }], examples: [{ text: `I noticed “${word}” in this sentence.`, translation: `我在这个句子里注意到了“${word}”。` }, { text: `Can you explain how “${word}” is used here?`, translation: `你能解释“${word}”在这里的用法吗？` }], dynamic: true }
}
async function fetchWordContext(word, fullSentence) {
  console.log('开始请求LLM:', word)
  if (!ecsAi && !apiKey.value.trim()) throw new Error('未配置 API Key')
  const base = apiBaseUrl.value.trim().replace(/\/+$/, '')
  if (!ecsAi && (!base || !apiModel.value.trim())) throw new Error('请填写有效的 Base URL 和 Model')
  const maxRetries = 2
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let rawContent = null
    try {
      // 使用 JSON 模式并提高输出上限，降低格式漂移和内容截断概率。
      // 深度词源 JSON 较长，提升上限避免例句字段被截断。
      const response = await requestLlm({ baseUrl: base, model: apiModel.value.trim(), apiKey: apiKey.value.trim(), temperature: 0.2, max_tokens: 8000, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: '你是英语词源与语境解析专家。全文中文内容必须使用简体中文，英文例句及词源原文可保留英文。只输出一个严格合法、可被 JSON.parse 解析的 JSON 对象，不要 Markdown、代码围栏、注释或任何额外文字。所有字符串中的双引号和换行必须正确转义。examples 必须正好 2 条，semanticRoutes 必须正好 3 条。格式示例：{"text":"word","type":"word","pronunciation":"/wɜːd/","partOfSpeech":"名词","definition":"语境释义","usage":"用法","etymology":{"prefix":"无","root":"词根","suffix":"无","origin":"来源","originalImage":"原始画面","certainty":"较确定"},"semanticRoutes":[{"label":"线路A","steps":"演变过程","modernMeaning":"现代义","domain":"日常"},{"label":"线路B","steps":"演变过程","modernMeaning":"现代义","domain":"商业"},{"label":"线路C","steps":"演变过程","modernMeaning":"现代义","domain":"技术"}],"comparisons":[{"word":"near-synonym","partOfSpeech":"名词","difference":"区别"}],"examples":[{"text":"Example sentence.","translation":"例句译文","contextNote":"语境说明"},{"text":"Another example.","translation":"另一例句","contextNote":"语境说明"}]}。必须包含全部字段。' }, { role: 'user', content: `当前完整句子：${fullSentence}\n目标词/词组：${word}\n只返回符合 schema 的 JSON。` }] })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        const hint = response.status === 401 ? 'API Key 无效或权限不足。' : response.status === 403 ? '当前 Key 无权调用该模型。' : response.status === 404 ? '检查 Base URL、接口路径和模型服务商文档。' : `HTTP ${response.status}`
        throw new Error(`${hint}${detail ? ` 服务端信息：${detail.slice(0, 240)}` : ''}`)
      }
      // 留下未经清理的原文，校验失败时可直接定位模型输出与字段路径。
      const responseText = await response.text()
      rawContent = responseText
      const data = JSON.parse(responseText)
      const content = data?.choices?.[0]?.message?.content
      rawContent = content ?? responseText
      const validation = validateAnalysis(content)
      const validationErrors = [...validation.errors]
      if (typeof content !== 'string') validationErrors.push('choices[0].message.content 必须是字符串')
      if (data?.choices?.[0]?.finish_reason === 'length') validationErrors.push('finish_reason 为 length，模型输出可能被截断')
      if (validationErrors.length) {
        throw Object.assign(new Error('模型解析结构校验失败'), { validationErrors })
      }
      return validation.data
    } catch (cause) {
      const invalidResponse = cause instanceof SyntaxError || Array.isArray(cause.validationErrors)
      if (invalidResponse) {
        console.error('[LLM 解析校验失败]', { word, attempt: attempt + 1, raw: rawContent, errors: cause.validationErrors || [cause.message] })
      }
      if (!invalidResponse || attempt === maxRetries) throw cause
    }
  }
}
async function analyze(key, countLookup = true) {
  selectedId.value = key; error.value = ''
  const cacheKey = makeCacheKey(activePassage.value.id, key)
  if (countLookup) await recordLookup(key, cacheKey)
  if (mockMap[key]) return
  // 当前句子的 id 与词条组成唯一缓存 key。
  const cached = cache.value[cacheKey]
  if (cached?.llmSuccess === true && validateAnalysis(cached).ok) return
  // Clear legacy placeholder cache entries; only successful model results are cached.
  if (cache.value[cacheKey]) delete cache.value[cacheKey]
  loading.value = true
  try {
    const parsed = await fetchWordContext(key, activePassage.value.sentence)
    // 解析刷新沿用收藏与复习状态，避免覆盖星标数据。
    const previous = cache.value[cacheKey] || cached || {}
    cache.value[cacheKey] = { ...parsed, id: key, text: parsed.text || key, dynamic: true, llmSuccess: true, deepSchema: 4, context_sentence: activePassage.value.sentence, context_translation: activePassage.value.translation || '', is_starred: previous.is_starred || false, review_count: previous.review_count || 0, next_review_at: previous.next_review_at, lookup_count: Math.max(Number(previous.lookup_count) || 0, Number(lookupCounts.value[key.trim().toLowerCase()]) || 0) }
    await saveCloudNote(key, activePassage.value.id, cache.value[cacheKey], false)
  } catch (cause) {
    error.value = cause instanceof AiAccessError ? cause.message : '解析失败，点击重试'
    console.error('[fetchWordContext]', { baseUrl: apiBaseUrl.value, model: apiModel.value, word: key, error: cause })
  } finally { loading.value = false }
}
async function translateSentencesBatch(sentences) {
  if (!ecsAi && !apiKey.value.trim()) throw new Error('请先在设置中填写 API Key')
  const base = apiBaseUrl.value.trim().replace(/\/+$/, '')
  const indexedSentences = sentences.map((sentence, i) => ({ i, english: sentence }))
  const maxRetries = 2
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let rawContent = null
    try {
      const response = await requestLlm({ baseUrl: base, model: apiModel.value.trim(), apiKey: apiKey.value.trim(), temperature: 0.3, max_tokens: 4000, messages: [{ role: 'system', content: '你是专业英语译者。将每句英文译成自然、准确、流畅的简体中文，兼顾信、达、雅。必须只输出一个严格合法的 JSON 数组，不要 Markdown、代码围栏或解释。数组每项格式为 {"i":0,"zh":"译文"}，i 必须对应输入编号，所有输入句子都必须有一项。' }, { role: 'user', content: JSON.stringify(indexedSentences) }] })
      if (!response.ok) throw new Error(`翻译服务暂不可用（${response.status}）`)
      const responseText = await response.text()
      rawContent = responseText
      const data = JSON.parse(responseText)
      const content = data?.choices?.[0]?.message?.content
      rawContent = content ?? responseText
      const validation = validateTranslations(content, sentences.length)
      if (typeof content !== 'string') {
        throw Object.assign(new Error('翻译服务未返回有效内容'), { validationErrors: ['choices[0].message.content 必须是字符串'] })
      }
      // 部分条目错误时保留有效译文，队列只把缺少译文的句子列为失败。
      if (validation.data.length || validation.ok) {
        if (validation.errors.length) console.error('[翻译条目校验失败]', { attempt: attempt + 1, raw: rawContent, errors: validation.errors })
        return new Map(validation.data.map(item => [item.i, item.zh]))
      }
      throw Object.assign(new Error('批量翻译结构校验失败'), { validationErrors: validation.errors })
    } catch (cause) {
      const invalidResponse = cause instanceof SyntaxError || Array.isArray(cause.validationErrors)
      if (invalidResponse) {
        console.error('[翻译结果校验失败]', { attempt: attempt + 1, raw: rawContent, errors: cause.validationErrors || [cause.message] })
      }
      if (!invalidResponse || attempt === maxRetries) throw cause
    }
  }
}
async function addPassage() {
  const sentence = draftSentence.value.trim(); if (!sentence) return
  const passage = { id: `custom-${Date.now()}`, sentence, translation: draftTranslation.value.trim() }
  passages.value.push(passage); activePassageId.value = passage.id; draftSentence.value = ''; draftTranslation.value = ''; showForm.value = false
  await saveCloudSentence(passage)
  notifyContextCorpusChanged()
  if (isTranslationMissing(passage.translation)) enqueueSentenceTranslations([passage])
  const first = [...sentence.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)].find(m => !mockMap[normalize(m[0])])
  if (first) analyze(normalize(first[0]), false)
}
async function importArticleSentences() {
  articleImportMessage.value = ''
  const selectedSentences = checkedArticleSentences.value.map(sentence => sentence.trim()).filter(Boolean)
  if (!selectedSentences.length) { articleImportMessage.value = '请至少勾选一句要导入的句子。'; return }
  if (selectedSentences.length > 50) { articleImportMessage.value = '一次最多导入 50 句，请取消部分勾选后重试。'; return }

  const candidates = dedupeSentences(selectedSentences, sentence => sentence, true)
  const existing = new Set(passages.value.map(passage => passage.sentence.trim().toLowerCase()))
  const newCandidates = candidates.filter(sentence => !existing.has(sentenceKey(sentence, value => value, true)))
  let addedPassages = []

  if (user.value && supabase && newCandidates.length) {
    const rows = newCandidates.map(english => ({ user_id: user.value.id, english: english.trim(), chinese: '' }))
    const { data, error: importError } = await supabase.from('sentences')
      .upsert(rows, { onConflict: 'user_id,english', ignoreDuplicates: true })
      .select('id,english,chinese,created_at')
    if (importError) {
      console.error('[Supabase article import]', importError)
      articleImportMessage.value = '云端导入失败，请稍后重试。'
      return
    }
    addedPassages = (data || []).map(row => ({ id: row.id, sentence: row.english.trim(), translation: row.chinese || '' }))
  } else if (!user.value) {
    addedPassages = newCandidates.map((sentence, index) => ({ id: `custom-${Date.now()}-${index}`, sentence, translation: '' }))
  }

  passages.value = mergeSentences(passages.value, addedPassages, passage => passage.sentence, true)
  if (addedPassages.length) activePassageId.value = addedPassages[0].id
  const skipped = selectedSentences.length - addedPassages.length
  articleImportMessage.value = `已导入 ${addedPassages.length} 句，跳过重复 ${skipped} 句。`
  if (addedPassages.length) notifyContextCorpusChanged()
  enqueueSentenceTranslations(addedPassages)
}
function enqueueSentenceTranslations(passagesToTranslate) {
  const freshKeys = []
  for (const passage of passagesToTranslate) {
    if (!passage || !isTranslationMissing(passage.translation)) continue
    const key = passage.sentence.trim().toLowerCase()
    if (!key || translationQueuedKeys.has(key)) continue
    translationQueuedKeys.add(key)
    translationQueue.push(key)
    freshKeys.push(key)
  }
  if (!freshKeys.length) return
  translationFailed.value = translationFailed.value.filter(key => !freshKeys.includes(key))
  translationProgress.value = translationWorkerActive
    ? { ...translationProgress.value, total: translationProgress.value.total + freshKeys.length }
    : { running: true, total: freshKeys.length, completed: 0 }
  void processTranslationQueue()
}
function supplementTranslations() {
  enqueueSentenceTranslations(missingTranslationPassages.value)
}
function translateActivePassage() {
  if (activePassage.value && isTranslationMissing(activePassage.value.translation)) enqueueSentenceTranslations([activePassage.value])
}
function retryFailedTranslations() {
  const failedKeys = [...translationFailed.value]
  const failedPassages = failedKeys.map(key => passages.value.find(passage => passage.sentence.trim().toLowerCase() === key)).filter(Boolean)
  enqueueSentenceTranslations(failedPassages)
}
function markTranslationFailed(key) {
  if (!translationFailed.value.includes(key)) translationFailed.value = [...translationFailed.value, key]
}
async function saveSentenceTranslation(key, chinese) {
  const passage = passages.value.find(item => item.sentence.trim().toLowerCase() === key)
  if (!passage || !isTranslationMissing(passage.translation)) return
  if (user.value && supabase) {
    const { error } = await supabase.from('sentences').update({ chinese })
      .eq('user_id', user.value.id).eq('english', passage.sentence.trim())
    if (error) throw error
  }
  const current = passages.value.find(item => item.id === passage.id)
  if (!current || !isTranslationMissing(current.translation)) return
  passages.value = passages.value.map(item => item.id === passage.id ? { ...item, translation: chinese } : item)
}
async function processTranslationQueue() {
  if (translationWorkerActive) return
  translationWorkerActive = true
  try {
    while (translationQueue.length) {
      const batch = translationQueue.splice(0, 10)
      let translations
      try {
        const sentences = batch.map(key => passages.value.find(passage => passage.sentence.trim().toLowerCase() === key)?.sentence || '')
        translations = await translateSentencesBatch(sentences)
      } catch (cause) {
        console.error('[Sentence translation batch]', cause)
        for (const key of batch) {
          const passage = passages.value.find(item => item.sentence.trim().toLowerCase() === key)
          if (passage && isTranslationMissing(passage.translation)) markTranslationFailed(key)
          translationQueuedKeys.delete(key)
          translationProgress.value = { ...translationProgress.value, completed: translationProgress.value.completed + 1 }
        }
        continue
      }
      for (let index = 0; index < batch.length; index++) {
        const key = batch[index]
        const passage = passages.value.find(item => item.sentence.trim().toLowerCase() === key)
        try {
          const chinese = translations.get(index)
          if (passage && isTranslationMissing(passage.translation)) {
            if (chinese) await saveSentenceTranslation(key, chinese)
            else {
              console.error('[Sentence translation item]', { sentence: passage.sentence, error: 'Missing zh result' })
              markTranslationFailed(key)
            }
          }
        } catch (cause) {
          console.error('[Sentence translation save]', { sentence: passage?.sentence || key, error: cause })
          markTranslationFailed(key)
        } finally {
          translationQueuedKeys.delete(key)
          translationProgress.value = { ...translationProgress.value, completed: translationProgress.value.completed + 1 }
        }
      }
    }
  } finally {
    translationWorkerActive = false
    translationProgress.value = { ...translationProgress.value, running: false }
    if (translationQueue.length) {
      translationProgress.value = { ...translationProgress.value, running: true }
      void processTranslationQueue()
    }
  }
}
function playExample(text) {
  if (!('speechSynthesis' in window)) { error.value = '此浏览器不支持 Web Speech API'; return }
  if (speakingExample.value === text) { window.speechSynthesis.cancel(); speakingExample.value = ''; return }
  window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'en-US'; currentUtterance = utterance; speakingExample.value = text
  utterance.onend = utterance.onerror = () => { if (currentUtterance === utterance) { speakingExample.value = ''; currentUtterance = null } }
  window.speechSynthesis.speak(utterance)
}
function stopSentenceSpeech() {
  if (speechSupported) window.speechSynthesis.cancel()
  sentenceUtterance = null
  sentenceSpeaking.value = false
}
function toggleSentenceSpeech() {
  if (!speechSupported || !activePassage.value?.sentence) return
  if (sentenceSpeaking.value) { stopSentenceSpeech(); return }
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(activePassage.value.sentence)
  utterance.lang = 'en-US'
  utterance.rate = sentenceSpeechRate.value
  sentenceUtterance = utterance
  sentenceSpeaking.value = true
  utterance.onend = utterance.onerror = () => {
    if (sentenceUtterance === utterance) { sentenceUtterance = null; sentenceSpeaking.value = false }
  }
  window.speechSynthesis.speak(utterance)
}
function navigatePassage(direction) {
  const list = availablePassages.value
  if (!list.length) return
  if (direction === 'random') {
    const choices = list.filter(p => p.id !== activePassageId.value)
    const target = choices.length ? choices[Math.floor(Math.random() * choices.length)] : list[0]
    activePassageId.value = target.id
    return
  }
  const index = Math.max(0, activePassageIndex.value)
  activePassageId.value = list[(index + direction + list.length) % list.length].id
}
function requestDeletePassage(passage) {
  if (!passage || passage.id === 'default' || pendingDeletes.value[passage.id]) return
  const previousActiveId = activePassageId.value
  pendingDeletes.value = { ...pendingDeletes.value, [passage.id]: { passage, previousActiveId } }
  if (activePassageId.value === passage.id) {
    const next = availablePassages.value[0]
    if (next) activePassageId.value = next.id
  }
  const timer = setTimeout(async () => {
    deleteTimers.delete(passage.id)
    passages.value = passages.value.filter(item => item.id !== passage.id)
    notifyContextCorpusChanged()
    const cachePrefix = `${passage.id}::`
    cache.value = Object.fromEntries(Object.entries(cache.value).filter(([key]) => !key.startsWith(cachePrefix)))
    await deleteCloudSentence(passage.id)
    const { [passage.id]: _removed, ...remaining } = pendingDeletes.value
    pendingDeletes.value = remaining
  }, 5000)
  deleteTimers.set(passage.id, timer)
}
function undoDeletePassage(id) {
  const pending = pendingDeletes.value[id]
  if (!pending) return
  clearTimeout(deleteTimers.get(id)); deleteTimers.delete(id)
  const { [id]: _removed, ...remaining } = pendingDeletes.value
  pendingDeletes.value = remaining
  if (!passages.value.some(item => item.id === id)) passages.value.push(pending.passage)
  notifyContextCorpusChanged()
  activePassageId.value = pending.previousActiveId === id ? id : activePassageId.value
}
onBeforeUnmount(() => deleteTimers.forEach(timer => clearTimeout(timer)))
</script>

<template>
  <main class="app-shell flex h-screen flex-col overflow-hidden bg-[#f7f6f2] text-[#23241f]">
    <ImportConfirmModal :open="importPrompt" :sentence-count="importCounts.sentences" :note-count="importCounts.notes" @import="decideImport(true)" @skip="decideImport(false)" />
    <div v-if="showWordBook" class="mobile-overlay fixed inset-0 z-[55] flex items-center justify-center bg-[#20251f66] p-4" @click.self="showWordBook = false">
      <section class="mobile-dialog wordbook-dialog flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <header class="flex items-center justify-between gap-3 border-b p-4 sm:p-5">
          <div class="min-w-0"><h2 class="font-serif text-xl sm:text-2xl">⭐ 生词本 · {{ starredNotes.length }}</h2><p v-if="contextCompletionCount" class="mt-1 text-[11px] text-[#82917f]">已为 {{ contextCompletionCount }} 个词补全原句</p></div>
          <div class="flex shrink-0 items-center gap-2"><button v-if="wordBookView === 'list'" class="min-h-10 rounded-lg border px-3 py-2 text-xs" @click="exportStarredCsv">导出 CSV</button><button class="min-h-10 rounded-lg px-3 py-2 text-sm" @click="showWordBook = false">关闭 ×</button></div>
        </header>
        <div v-if="user" class="mx-4 mt-3 rounded-xl bg-[#f8f8f4] px-3 py-2.5">
          <div class="flex items-center justify-between gap-3 text-xs text-[#777970]"><span>今日 {{ reviewStats.todayCount }} / {{ dailyReviewGoal }}</span><span>连续学习 {{ reviewStats.streakDays }} 天</span></div>
          <div class="mt-2 h-2 overflow-hidden rounded-full bg-[#e9e9e1]"><div class="h-full rounded-full bg-[#829b7d] transition-[width] duration-500" :style="{ width: `${dailyGoalProgress}%` }"></div></div>
          <p v-if="goalCelebration" class="mt-2 text-xs font-medium text-[#59765e]">🎉 今日复习目标已完成，做得好！</p>
          <p class="mt-1 text-[10px] text-[#999b91]">今日已复习 {{ reviewStats.todayCount }} 次</p>
        </div>
        <div v-if="wordBookView === 'list'" class="flex flex-wrap items-center gap-2 p-4">
          <button class="min-h-10 rounded-full px-3 py-1.5 text-xs" @click="wordBookFilter = 'all'">全部</button><button class="min-h-10 rounded-full px-3 py-1.5 text-xs" @click="wordBookFilter = 'due'">待复习</button>
          <label class="flex items-center gap-2 text-xs text-[#777970]">排序<select v-model="wordBookSort" class="min-h-10 rounded-lg border border-[#e8e6df] bg-white px-2"><option value="due">按到期时间</option><option value="lookup">按查询次数（多的在前）</option></select></label>
          <div class="flex w-full flex-wrap gap-2 pt-1">
            <button class="min-h-10 rounded-full bg-[#273b32] px-4 py-2 text-xs text-white disabled:cursor-not-allowed disabled:bg-[#e8e8e2] disabled:text-[#999] sm:ml-auto" :disabled="dueReviewNotes.length === 0" @click="startReview('flashcard')">闪卡复习 · {{ dueReviewNotes.length }}</button>
            <button class="min-h-10 rounded-full bg-[#526b55] px-4 py-2 text-xs text-white disabled:cursor-not-allowed disabled:bg-[#e8e8e2] disabled:text-[#999]" :disabled="clozeReviewNotes.length === 0" @click="startReview('cloze')">填空练习 · {{ clozeReviewNotes.length }}</button>
          </div>
          <div v-if="dueReviewNotes.length === 0 && clozeReviewNotes.length === 0" class="w-full border-t border-[#eeece6] pt-3 text-center">
            <p class="text-xs text-[#92938a]">现在没有到期的词，下次复习时间由你的反馈决定</p>
            <p class="mt-3 text-[11px] font-medium text-[#777970]">加练：练习全部星标词</p>
            <div class="mt-2 flex justify-center gap-2"><button class="min-h-10 rounded-full border border-[#dce4d8] px-4 py-2 text-xs text-[#49634e] disabled:opacity-40" :disabled="allStarredNotes.length === 0" @click="startReview('flashcard', true)">闪卡加练 · {{ allStarredNotes.length }}</button><button class="min-h-10 rounded-full border border-[#dce4d8] px-4 py-2 text-xs text-[#49634e] disabled:opacity-40" :disabled="allClozeNotes.length === 0" @click="startReview('cloze', true)">填空加练 · {{ allClozeNotes.length }}</button></div>
          </div>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto p-4 pt-0">
          <template v-if="wordBookView === 'list'">
            <div v-if="starredNotes.length" class="space-y-2"><article v-for="note in starredNotes" :key="note.cacheKey" class="flex items-center gap-3 rounded-xl border p-4"><div class="min-w-0 flex-1"><p class="font-medium">{{ note.word }}</p><p class="mt-1 truncate text-xs text-[#898b82]">{{ note.value.definition }}</p><p class="mt-1 text-[10px]">已复习 {{ note.value.review_count || 0 }} 次 · 查询 {{ note.value.lookup_count || 0 }} 次</p></div></article></div>
            <p v-else class="py-12 text-center text-sm text-[#92938a]">暂无星标词条</p>
          </template>
          <div v-else class="space-y-4">
            <button class="min-h-10 rounded-lg px-2 py-2 text-xs text-[#526b55]" @click="returnToWordBookList">← 返回列表</button>
            <p v-if="extraPractice" class="rounded-lg bg-[#f2f4ee] px-3 py-2 text-xs text-[#667661]">加练模式，不影响复习计划</p>
            <template v-if="reviewMode === 'flashcard'">
              <div v-if="reviewCard" class="rounded-xl border bg-[#f8f8f4] p-5"><button class="min-h-40 w-full text-left" @click="flippedCard = !flippedCard"><template v-if="!flippedCard"><span>正面 · 点击翻转</span><h3 class="mt-8 font-serif text-3xl">{{ reviewCard.word }}</h3></template><template v-else><span>背面</span><p class="mt-4 text-sm leading-6">{{ reviewCard.value.definition }}</p><p class="mt-3 text-xs">{{ reviewCard.value.etymology?.originalImage }}</p><div v-if="reviewCard.value.context_sentence" class="mt-4 rounded-lg border border-[#e8e6df] bg-white p-3"><p class="text-[10px] uppercase tracking-wide text-[#999]">原句</p><p class="mt-1 text-sm leading-6">{{ reviewCard.value.context_sentence }}</p><p v-if="reviewCard.value.context_translation" class="mt-1 text-xs leading-5 text-[#85877d]">{{ reviewCard.value.context_translation }}</p></div></template></button><div v-if="flippedCard" class="mt-4 grid grid-cols-3 gap-2"><button class="min-h-10 rounded-lg border px-2 py-2 text-xs" @click="markReviewed('认识')">认识</button><button class="min-h-10 rounded-lg border px-2 py-2 text-xs" @click="markReviewed('模糊')">模糊</button><button class="min-h-10 rounded-lg border px-2 py-2 text-xs" @click="markReviewed('不认识')">不认识</button></div></div>
              <p v-else class="rounded-xl bg-[#f8f8f4] py-12 text-center text-sm text-[#92938a]">今天没有需要复习的词</p>
            </template>
            <template v-else>
              <div v-if="clozeRoundFinished" class="rounded-xl bg-[#f8f8f4] p-6 text-center"><h3 class="font-serif text-2xl">本轮完成</h3><p class="mt-3 text-sm text-[#62645c]">本轮正确率：{{ clozeRound.length ? Math.round(clozeCorrectCount / clozeRound.length * 100) : 0 }}%（{{ clozeCorrectCount }} / {{ clozeRound.length }}）</p></div>
              <div v-else-if="reviewCard" class="rounded-xl border bg-[#f8f8f4] p-5"><p class="text-[10px] uppercase tracking-[.16em] text-[#9a9b91]">填空 · {{ clozeIndex + 1 }} / {{ clozeRound.length }}</p><p class="mt-4 font-serif text-lg leading-8 text-[#35372f]">{{ clozeMaskedSentence }}</p><p class="mt-3 rounded-lg bg-white p-3 text-xs leading-5 text-[#62645c]">提示：{{ reviewCard.value.definition }}</p><form class="mt-4 space-y-3" @submit.prevent="submitClozeAnswer"><input v-model="clozeInput" :disabled="clozeAnswered" autocomplete="off" class="min-h-11 w-full rounded-lg border border-[#e5e3dc] bg-white px-3 py-2 text-sm outline-none focus:border-[#82917f] disabled:bg-[#f3f4ef]" placeholder="输入答案，按回车提交" @input="clozeNear = false" /><p v-if="clozeNear" class="text-xs text-[#a36b5b]">词形不同，再看看</p><div class="flex flex-wrap gap-2"><button type="submit" :disabled="clozeAnswered" class="min-h-10 rounded-lg bg-[#273b32] px-4 py-2 text-xs text-white disabled:opacity-50">提交答案</button><button type="button" :disabled="clozeAnswered" class="min-h-10 rounded-lg border px-4 py-2 text-xs disabled:opacity-50" @click="revealClozeAnswer">不会，看答案</button></div></form><div v-if="clozeAnswered" class="mt-4 rounded-lg border border-[#e4e9df] bg-white p-3"><p class="text-sm font-medium" :class="clozeWasCorrect ? 'text-[#49634e]' : 'text-[#a36b5b]'">{{ clozeWasCorrect ? '答对了 · 正确答案：' + reviewCard.word : '正确答案：' + reviewCard.word }}</p><p class="mt-2 text-sm leading-6">{{ reviewCard.value.context_sentence }}</p><p v-if="reviewCard.value.context_translation" class="mt-1 text-xs leading-5 text-[#85877d]">{{ reviewCard.value.context_translation }}</p><button class="mt-3 min-h-10 rounded-lg bg-[#273b32] px-4 py-2 text-xs text-white" @click="advanceClozeQuestion">{{ clozeIndex + 1 === clozeRound.length ? '查看本轮结果' : '下一题' }}</button></div></div>
              <p v-else class="rounded-xl bg-[#f8f8f4] py-12 text-center text-sm text-[#92938a]">{{ dueReviewNotes.length ? '今天没有可填空的到期词' : '今天没有需要复习的词' }}</p>
            </template>
          </div>
        </div>
      </section>
    </div>
    <AuthModal :open="showAuth && !!supabase" :loading="authBusy" :error-message="authError" :message="authMessage" :reset-password-version="authResetPasswordVersion" :reset-mode-version="authResetModeVersion" @submit="submitAuth" @close="showAuth = false" @clear-message="authError = ''; authMessage = ''" />
    <div v-if="showLibrary" class="mobile-overlay fixed inset-0 z-50 flex items-center justify-center bg-[#20251f66] p-4"
      @click.self="showLibrary = false">
      <section class="mobile-dialog wordbook-dialog flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <header class="flex items-center justify-between border-b border-[#eeece6] p-5">
          <div>
            <h2 class="font-serif text-2xl">语料句子库</h2>
            <p class="mt-1 text-xs text-[#92938a]">点击句子切换阅读</p>
          </div><button class="rounded-full px-3 py-2 text-sm text-[#777]" @click="showLibrary = false">关闭 ×</button>
        </header>
        <div class="p-4"><input v-model="passageSearch" placeholder="搜索英文句子或中文翻译"
            class="w-full rounded-lg border border-[#e8e6df] px-3 py-2 text-sm" /></div>
        <div v-if="missingTranslationPassages.length || translationProgress.running || failedTranslationCount" class="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-[#eeece6] px-4 pb-3 text-xs">
          <button v-if="missingTranslationPassages.length" class="min-h-10 rounded-full bg-[#f0f4ed] px-3 py-2 font-medium text-[#49634e]" @click="supplementTranslations">{{ missingTranslationPassages.length }} 句缺翻译 · 全部补全</button>
          <span v-if="translationProgress.running" class="text-[#82917f]">翻译中 {{ translationProgress.completed }} / {{ translationProgress.total }}</span>
          <template v-if="failedTranslationCount"><span class="text-[#a36b5b]">有 {{ failedTranslationCount }} 句翻译失败</span><button class="min-h-10 px-1 text-[#49634e] underline underline-offset-2" @click="retryFailedTranslations">重新翻译</button></template>
        </div>
        <div class="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-4">
          <article v-for="passage in filteredPassages" :key="passage.id" class="flex gap-3 rounded-xl border p-4"
            :class="activePassageId === passage.id ? 'border-[#9bad96] bg-[#f4f6f1]' : 'border-[#eeece6]'"
            @click="activePassageId = passage.id; showLibrary = false">
            <div class="min-w-0 flex-1 text-left">
              <p class="text-sm leading-6">{{ sentencePreview(passage.sentence) }}<span
                  v-if="passage.sentence.trim().split(/\s+/).length > 8">…</span></p>
              <p class="mt-1.5 text-xs leading-5 text-[#92938a]">{{ passage.translation }}</p>
            </div><button v-if="passage.id !== 'default'" class="self-start rounded-md px-2 py-1 text-xs text-[#a36b5b]"
              @click.stop="requestDeletePassage(passage)">删除</button>
          </article>
          <p v-if="!filteredPassages.length" class="py-8 text-center text-sm text-[#999]">没有匹配的句子</p>
        </div>
      </section>
    </div>
    <div v-if="undoDeleteNotice" class="fixed bottom-5 left-1/2 z-[65] flex -translate-x-1/2 items-center gap-4 rounded-xl bg-[#273b32] px-4 py-3 text-sm text-white shadow-lg"><span>已删除</span><button class="font-semibold underline underline-offset-2" @click="undoDeletePassage(undoDeleteNotice.passage.id)">撤销</button></div>
    <header class="flex min-h-[68px] flex-wrap items-center justify-between gap-y-2 border-b border-[#e7e5df] px-4 py-2 md:h-[76px] md:flex-nowrap md:px-12 md:py-0"><a
        class="flex items-center gap-3" href="#"><span
          class="grid h-9 w-9 place-items-center rounded-xl bg-[#273b32] text-sm font-semibold text-white">C.</span><span
          class="text-[15px] font-semibold tracking-tight">context<span class="text-[#9a9c91]"> /
            reader</span></span></a>
      <div class="hidden items-center gap-2 text-xs text-[#85877d] sm:flex"><span
          class="h-2 w-2 rounded-full bg-[#87a88d]"></span> A small study space</div><div class="flex flex-wrap items-center justify-end gap-2"><template v-if="user"><span class="max-w-[120px] truncate text-xs text-[#62645c] sm:max-w-[180px]">{{ user.email }}</span><button class="rounded-full border border-[#e5e3dc] bg-white px-3 py-2 text-xs" @click="signOut">退出</button></template>

<button v-else-if="supabase" class="rounded-full border border-[#dce4d8] bg-white px-3 py-2 text-xs text-[#49634e] hover:bg-[#f0f4ed]" @click="openLoginModal"><span class="sm:hidden">登录</span><span class="hidden sm:inline">登录 / 注册</span></button><button
        class="rounded-full border border-[#e5e3dc] bg-white px-3 py-2 text-xs" @click="openWordBook"><span class="sm:hidden">⭐ 生词</span><span class="hidden sm:inline">⭐ 生词本</span></button><span v-if="syncNotice" class="hidden text-[10px] text-[#a36b5b] md:inline">{{ syncNotice }}</span><button class="rounded-full border border-[#e5e3dc] bg-white px-4 py-2 text-xs" @click="showSettings = !showSettings">⚙ 设置</button></div>
    </header>
    <SettingsModal :managed-ai="ecsAi" :open="showSettings" :default-blur-translation="defaultBlurTranslation" :daily-review-goal="dailyReviewGoal" :api-base-url="apiBaseUrl" :api-model="apiModel" :api-key="apiKey" @close="showSettings = false" @update:defaultBlurTranslation="defaultBlurTranslation = $event" @update:dailyReviewGoal="dailyReviewGoal = $event" @update:apiBaseUrl="apiBaseUrl = $event" @update:apiModel="apiModel = $event" @update:apiKey="apiKey = $event" @export-backup="exportBackup" @import-file="importBackup" @export-anki="exportAnki" />
    <div class="reading-content mx-auto flex min-h-0 w-full flex-1 flex-col px-5 pb-5 pt-3 md:px-8 md:pt-3">
      <div class="mb-4 flex items-end justify-between md:mb-3">
        <div>
          <div class="mb-1.5 text-[10px] font-semibold uppercase tracking-[.22em] text-[#8c9284]">Reading in context <span
              class="px-1">·</span> 01</div>
          <h1 class="font-serif text-[26px] tracking-[-.04em] md:text-[34px]">Words make sense <span
              class="italic text-[#82917f]">together.</span></h1>
          <p class="mt-1.5 text-sm text-[#898a81]">点亮的词语可以点击，看看它们在这里的意思。</p>
        </div>
        <div class="hidden text-right text-xs text-[#9a9b92] md:block">A short passage<br />Every word has a place</div>
      </div>
      <section
        class="reading-layout grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(38%,0.9fr)_minmax(0,1.1fr)] overflow-hidden rounded-2xl border border-[#e8e6df] bg-white shadow-[0_12px_40px_rgba(43,48,38,.035)] md:grid-rows-1 md:grid-cols-[1.02fr_.98fr]">
        <div
          class="reading-pane flex min-h-0 flex-col overflow-hidden border-b border-[#eeece6] p-4 md:border-b-0 md:border-r md:p-6 lg:p-8">
          <div class="flex items-center justify-between"><span
              class="text-[10px] font-semibold uppercase tracking-[.18em] text-[#9a9b91]">The passage</span>
            <div class="flex items-center gap-2"><button
                class="rounded-full border border-[#e9e8e1] bg-white px-3 py-1.5 text-[10px] text-[#62645c]"
                @click="showLibrary = true">语料库 · {{ availablePassages.length }}</button><button
                class="rounded-full bg-[#273b32] px-3 py-1.5 text-[10px] text-white hover:bg-[#385344]"
                @click="showForm = !showForm">+ 新增句子</button></div>
          </div>
          <div class="passage-toolbar mt-3 flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-2"><button class="min-h-10 rounded-full border border-[#e9e8e1] px-3 py-2 text-xs text-[#62645c] disabled:opacity-40" :disabled="availablePassages.length < 2" @click="navigatePassage(-1)">← 上一句</button><button class="min-h-10 rounded-full border border-[#e9e8e1] px-3 py-2 text-xs text-[#62645c] disabled:opacity-40" :disabled="availablePassages.length < 2" @click="navigatePassage(1)">下一句 →</button><button class="min-h-10 rounded-full bg-[#f3f4ef] px-3 py-2 text-xs text-[#526b55] disabled:opacity-40" :disabled="availablePassages.length < 2" @click="navigatePassage('random')">随机一句 ⤨</button></div>
            <div v-if="speechSupported" class="flex flex-wrap items-center gap-2"><button class="min-h-10 rounded-full border border-[#e9e8e1] bg-white px-3 py-2 text-xs text-[#49634e]" @click="toggleSentenceSpeech">{{ sentenceSpeaking ? '■ 停止' : '🔊 朗读整句' }}</button><button class="min-h-10 rounded-full border border-[#e9e8e1] bg-[#f0f4ed] px-3 py-2 text-xs text-[#49634e]" @click="sentenceSpeechRate = sentenceSpeechRate === 0.7 ? 1 : 0.7">语速 {{ sentenceSpeechRate }}x · 切换</button></div>
          </div>
          <form v-if="showForm" class="mt-5 space-y-3 rounded-xl bg-[#f7f7f3] p-4" @submit.prevent="addPassage">
            <div class="flex gap-2 border-b border-[#e8e6df] pb-2"><button type="button" class="rounded-full px-3 py-2 text-xs" :class="addTab === 'sentence' ? 'bg-[#273b32] text-white' : 'text-[#777]'" @click="addTab = 'sentence'">新增句子</button><button type="button" class="rounded-full px-3 py-2 text-xs" :class="addTab === 'article' ? 'bg-[#273b32] text-white' : 'text-[#777]'" @click="addTab = 'article'">导入文章</button></div>
            <template v-if="addTab === 'sentence'">
              <textarea v-model="draftSentence" required rows="2" placeholder="输入英文句子" class="w-full resize-y rounded-lg border border-[#e8e6df] bg-white p-3 text-sm outline-none focus:border-[#82917f]"></textarea>
              <input v-model="draftTranslation" placeholder="对应的中文翻译（可选）" class="w-full rounded-lg border border-[#e8e6df] bg-white p-3 text-sm outline-none focus:border-[#82917f]" />
              <div class="flex justify-end gap-2"><button type="button" class="rounded-lg px-3 py-2 text-xs text-[#777]" @click="showForm = false">取消</button><button class="rounded-lg bg-[#273b32] px-4 py-2 text-xs text-white">添加并解析</button></div>
            </template>
            <template v-else>
              <textarea v-model="articleText" rows="5" placeholder="粘贴英文文章或段落，系统会自动拆分句子" class="w-full resize-y rounded-lg border border-[#e8e6df] bg-white p-3 text-sm leading-6 outline-none focus:border-[#82917f]"></textarea>
              <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-[#777970]"><span>已选 {{ checkedArticleSentences.length }} / {{ articleSentences.length }} 句</span><span v-if="checkedArticleSentences.length > 50" class="text-[#a36b5b]">一次最多导入 50 句，请取消部分勾选</span></div>
              <div v-if="articleSentences.length" class="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-[#e8e6df] bg-white p-3">
                <label v-for="(sentence, index) in articleSentences" :key="index" class="flex cursor-pointer items-start gap-2 rounded-md p-2 text-sm leading-6 hover:bg-[#f7f7f3]"><input type="checkbox" class="mt-1 h-4 w-4 shrink-0 accent-[#49634e]" :checked="articleChecks[index] !== false" @change="articleChecks[index] = $event.target.checked" /><span>{{ sentence }}</span></label>
              </div>
              <p v-else class="rounded-lg bg-white p-3 text-xs text-[#999]">粘贴至少包含 3 个单词的英文句子以查看预览。</p>
              <p v-if="articleImportMessage" class="text-xs text-[#526b55]">{{ articleImportMessage }}</p>
              <div class="flex justify-end gap-2"><button type="button" class="rounded-lg px-3 py-2 text-xs text-[#777]" @click="showForm = false">关闭</button><button type="button" :disabled="!checkedArticleSentences.length || checkedArticleSentences.length > 50" class="rounded-lg bg-[#273b32] px-4 py-2 text-xs text-white disabled:opacity-50" @click="importArticleSentences">导入 {{ checkedArticleSentences.length }} 句</button></div>
            </template>
          </form>
          <div
            class="sentence-display my-auto py-10 font-serif text-[clamp(24px,3vw,40px)] leading-[1.85] tracking-[-.02em] text-[#35372f]">
            <template v-for="(token, index) in tokens" :key="index"><button v-if="token.key" class="interactive-word"
                :class="{ 'active-word': selectedId === token.key }" @click="analyze(token.key)">{{ token.text
                }}</button><span v-else>{{ token.text }}</span></template>


          </div>
          <div class="border-t border-[#f0efe9] pt-4">
            <div v-if="isTranslationMissing(activePassage.translation)" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-6 text-[#85877d]"><span>尚未翻译 ·</span><button class="min-h-10 rounded-lg px-1 text-left font-medium text-[#526b55] underline underline-offset-2" @click="translateActivePassage">{{ translationProgress.running && translationQueuedKeys.has(activePassage.sentence.trim().toLowerCase()) ? '翻译中…' : '翻译这句' }}</button><span v-if="translationFailed.includes(activePassage.sentence.trim().toLowerCase())" class="text-xs text-[#a36b5b]">翻译失败</span><button v-if="translationFailed.includes(activePassage.sentence.trim().toLowerCase())" class="min-h-10 rounded-lg px-1 text-xs text-[#49634e] underline underline-offset-2" @click="retryFailedTranslations">重新翻译</button></div>
            <p v-else class="cursor-pointer text-[13px] leading-6 text-[#85877d]" :class="{ 'translation-blurred': !translationVisible }" title="点击显示或遮住翻译" @click="translationVisible = !translationVisible">{{ activePassage.translation }}</p>
            <p class="mt-2 text-[10px] text-[#b0b1a8]">↗ 点击高亮词语，查看语境中的解析</p>
          </div>
        </div>
        <div class="notes-pane min-h-0 overflow-y-auto overscroll-contain">
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
                </div><div class="flex items-center gap-2"><button class="rounded-full border px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-40" :disabled="loading || selected.definition?.includes('语境占位说明')" :class="selected.is_starred ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-[#e6e5dd] text-[#777]'" @click="toggleStar">{{ selected.is_starred ? '⭐ 已星标' : '☆ 星标' }}</button><button
                  class="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-[#e6e5dd] text-[#657664]"
                  @click="playExample(selected.text)">▶</button></div>
              </div>
              <p class="mt-5 text-sm leading-7 text-[#696b62]">{{ selected.definition }}</p>
              <p v-if="loading" class="mt-3 text-xs text-[#82917f]">正在根据句子语境生成解析…</p>
              <p v-if="error" class="mt-2 text-xs text-[#a56d52]"><span v-if="error === '解析失败，点击重试'" role="button" tabindex="0" @click="analyze(selectedId, false)" @keydown.enter="analyze(selectedId, false)" @keydown.space.prevent="analyze(selectedId, false)">{{ error }}</span><template v-else>{{ error }}</template></p>
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
      <footer
        class="mt-3 hidden shrink-0 justify-between text-[10px] uppercase tracking-[.16em] text-[#aaa99f] sm:flex">
        <span>Learn a
          little,
          notice a lot.</span><span>Made for curious readers</span>
      </footer>
    </div>
  </main>
</template>

<style scoped>
.translation-blurred { filter: blur(6px); user-select: none; transition: filter .2s ease; }
</style>

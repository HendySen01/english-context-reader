// Pure sentence collection helpers; English text is normalized only as requested.
// The caller can opt into case-insensitive matching to preserve existing workflows.
export function isTranslationMissing(value) {
  const translation = String(value || '').trim()
  return !translation || ['尚未填写中文翻译', '（尚未填写中文翻译）', '(尚未填写中文翻译)'].includes(translation)
}

export function sentenceKey(item, getEnglish = value => value?.english ?? value?.sentence ?? '', ignoreCase = false) {
  const english = String(getEnglish(item) || '').trim()
  return ignoreCase ? english.toLowerCase() : english
}

export function dedupeSentences(items, getEnglish = value => value?.english ?? value?.sentence ?? '', ignoreCase = false) {
  const seen = new Set()
  return items.filter(item => {
    const key = sentenceKey(item, getEnglish, ignoreCase)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function mergeSentences(existing, incoming, getEnglish = value => value?.english ?? value?.sentence ?? '', ignoreCase = false) {
  const merged = new Map()
  for (const item of [...existing, ...incoming]) {
    const key = sentenceKey(item, getEnglish, ignoreCase)
    if (key && !merged.has(key)) merged.set(key, item)
  }
  return [...merged.values()]
}

export function makeCacheKey(passageId, key) {
  return `${passageId}::${key}`
}

export function cacheWord(key, value) {
  const separator = key.indexOf('::')
  return String(value?.id || value?.text || (separator >= 0 ? key.slice(separator + 2) : key)).trim()
}

export function sentencePreview(sentence) {
  return sentence.trim().split(/\s+/).slice(0, 8).join(' ')
}

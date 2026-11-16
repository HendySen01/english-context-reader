// Pure CSV serialization for the starred-word review export.
// Keeps Excel's UTF-8 BOM and escapes embedded quotes, commas, and line breaks.
function quoteCsvField(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`
}

export function buildStarredNotesCsv(items) {
  const rows = [['单词', '释义', '原句', '复习次数', '下次复习时间']]
  for (const item of items) rows.push([item.word, item.value.definition, item.value.context_sentence || '', item.value.review_count || 0, item.value.next_review_at || ''])
  return `\uFEFF${rows.map(row => row.map(quoteCsvField).join(',')).join('\r\n')}`
}

export function buildAnkiCsv(cache, passages) {
  const rows = [['Front', 'Back']]
  for (const [cacheKey, entry] of Object.entries(cache)) {
    if (!entry?.llmSuccess) continue
    const split = cacheKey.indexOf('::')
    const passageId = cacheKey.slice(0, split)
    const passage = passages.find(item => item.id === passageId)
    const etymology = entry.etymology
    const parts = typeof etymology === 'object' ? `词根：${etymology.root || ''}；前缀：${etymology.prefix || ''}；后缀：${etymology.suffix || ''}` : String(etymology || '')
    const back = [`语境释义：${entry.definition || ''}`, `原始画面：${etymology?.originalImage || ''}`, parts, `所在原句：${passage?.sentence || ''}`, `中文译文：${passage?.translation || ''}`].join('<br>')
    rows.push([entry.text || cacheKey.slice(split + 2), back])
  }
  return `\uFEFF${rows.map(row => row.map(quoteCsvField).join(',')).join('\r\n')}`
}

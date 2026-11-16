// Pure backup serialization and shape validation; file selection and downloads stay in App.vue.
// Parsing failures are thrown to the caller so it can retain the existing user-facing message.
export function createBackupJson(passages, cache, exportedAt = new Date().toISOString()) {
  return JSON.stringify({ version: 1, exportedAt, passages, cache }, null, 2)
}

export function parseBackupData(content) {
  const data = JSON.parse(content)
  if (!Array.isArray(data.passages) || !data.cache || typeof data.cache !== 'object') throw new Error('Invalid backup data')
  return {
    passages: data.passages.filter(passage => passage?.id && typeof passage.sentence === 'string').map(passage => ({ ...passage, translation: passage.translation || '' })),
    cache: Object.fromEntries(Object.entries(data.cache).filter(([, value]) => value?.llmSuccess && value?.deepSchema === 4))
  }
}

// 校验并规范化模型的词条解析与批量翻译，返回可定位到字段的错误信息。
// 只处理传入的数据，不读取应用状态，也不执行请求或缓存写入。
function parseModelJson(raw) {
  if (typeof raw !== 'string') return raw
  const cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim()
  return JSON.parse(cleaned)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readString(source, key, path, required, errors) {
  const value = source[key]
  if (value == null && !required) return ''
  if (typeof value !== 'string') {
    errors.push(`${path} 必须是字符串`)
    return ''
  }
  const trimmed = value.trim()
  if (required && !trimmed) errors.push(`${path} 不能为空`)
  return trimmed
}

function readItems(source, key, required, requiredFields, optionalFields, errors) {
  const value = source[key]
  if (value == null && !required) return []
  if (!Array.isArray(value)) {
    errors.push(`${key} 必须是数组`)
    return []
  }
  if (required && !value.length) errors.push(`${key} 至少需要一项`)
  return value.map((item, index) => {
    const path = `${key}[${index}]`
    if (!isObject(item)) {
      errors.push(`${path} 必须是对象`)
      return {}
    }
    const normalized = {}
    for (const field of requiredFields) normalized[field] = readString(item, field, `${path}.${field}`, true, errors)
    for (const field of optionalFields) normalized[field] = readString(item, field, `${path}.${field}`, false, errors)
    return normalized
  })
}

export function validateAnalysis(raw) {
  let source
  try { source = parseModelJson(raw) } catch (cause) {
    return { ok: false, data: null, errors: [`JSON 解析失败：${cause.message}`] }
  }
  if (!isObject(source)) return { ok: false, data: null, errors: ['解析结果必须是 JSON 对象'] }

  const errors = []
  const data = {}
  for (const field of ['text', 'type', 'pronunciation', 'partOfSpeech', 'definition', 'usage']) {
    data[field] = readString(source, field, field, true, errors)
  }
  if (!['word', 'phrase'].includes(data.type)) errors.push('type 必须是 word 或 phrase')

  const etymology = isObject(source.etymology) ? source.etymology : {}
  if (!isObject(source.etymology)) errors.push('etymology 必须是对象')
  data.etymology = {}
  for (const field of ['origin', 'originalImage']) {
    data.etymology[field] = readString(etymology, field, `etymology.${field}`, true, errors)
  }
  for (const field of ['prefix', 'root', 'suffix', 'certainty']) {
    data.etymology[field] = readString(etymology, field, `etymology.${field}`, false, errors)
  }

  // 保留原有的展示上限，超出数量本身不会使解析失败。
  data.semanticRoutes = readItems(source, 'semanticRoutes', true, ['label', 'steps', 'modernMeaning'], ['domain'], errors).slice(0, 3)
  data.comparisons = readItems(source, 'comparisons', false, ['word', 'partOfSpeech', 'difference'], [], errors)
  data.examples = readItems(source, 'examples', true, ['text', 'translation'], ['contextNote'], errors).slice(0, 2)
  if (JSON.stringify(data).includes('语境占位说明')) errors.push('解析结果包含语境占位说明，不能作为成功解析')

  return { ok: errors.length === 0, data: errors.length ? null : data, errors }
}

export function validateTranslations(raw, sentenceCount) {
  let source
  try { source = parseModelJson(raw) } catch (cause) {
    return { ok: false, data: [], errors: [`JSON 解析失败：${cause.message}`] }
  }
  if (!Array.isArray(source)) return { ok: false, data: [], errors: ['翻译结果必须是 JSON 数组'] }

  const errors = []
  const translations = new Map()
  const seenIndexes = new Set()
  const duplicateIndexes = new Set()
  source.forEach((item, index) => {
    const path = `[${index}]`
    if (!isObject(item)) {
      errors.push(`${path} 必须是对象`)
      return
    }
    if (!Number.isInteger(item.i) || item.i < 0 || item.i >= sentenceCount) {
      errors.push(`${path}.i 必须是 0 到 ${sentenceCount - 1} 的整数`)
      return
    }
    if (seenIndexes.has(item.i)) {
      duplicateIndexes.add(item.i)
      translations.delete(item.i)
      errors.push(`${path}.i 重复（句子 ${item.i}）`)
      return
    }
    seenIndexes.add(item.i)
    const zh = readString(item, 'zh', `${path}.zh（句子 ${item.i}）`, true, errors)
    if (zh) translations.set(item.i, { i: item.i, zh })
  })
  for (let index = 0; index < sentenceCount; index++) {
    if (!translations.has(index) && !duplicateIndexes.has(index)) errors.push(`句子 ${index} 缺少有效译文`)
  }
  return { ok: errors.length === 0, data: [...translations.values()], errors }
}

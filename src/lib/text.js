// Pure helpers for English tokenization, sentence splitting, and whole-word matching.
// Inputs such as known phrases and target words are provided by the caller.
export function normalize(word) {
  return word.toLowerCase().replace(/^[^a-z'-]+|[^a-z'-]+$/gi, '')
}

export function splitArticleSentences(text) {
  const protectedPeriod = '\uE000'
  const endAwarePeriod = '\uE001'
  const protectedText = String(text || '')
    .replace(/\bU\.S\./gi, match => `${match.slice(0, 2).replace(/\./g, protectedPeriod)}${match.slice(2, -1)}${endAwarePeriod}`)
    .replace(/\b(?:Mr|Mrs|Ms|Dr|Prof|e\.g|i\.e)\./gi, match => match.replace(/\./g, protectedPeriod))
    .replace(/(\d)\.(?=\d)/g, `$1${protectedPeriod}`)
    .replace(new RegExp(`${endAwarePeriod}(?=\\s*(?:[\\"“”'’(\\[]*[A-Z0-9]|$))`, 'g'), '.')
    .replaceAll(endAwarePeriod, protectedPeriod)
  const parts = protectedText.match(/(?:[^.!?]+[.!?]+["'’”)]*|[^.!?]+$)/g) || []
  return parts.map(part => part.replaceAll(protectedPeriod, '.').trim()).filter(part => {
    const words = part.match(/\b[A-Za-z0-9]+(?:['’-][A-Za-z]+)*\b/g) || []
    return words.length >= 3
  })
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function makeTargetMatcher(word) {
  return new RegExp(`(?<![A-Za-z])${escapeRegExp(String(word).trim())}(?![A-Za-z])`, 'i')
}

export function tokenizeSentence(sentence, knownPhrases = []) {
  const known = knownPhrases instanceof Set ? knownPhrases : new Set(knownPhrases)
  const words = [...String(sentence || '').matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)]
  const result = []
  let cursor = 0
  let index = 0
  while (index < words.length) {
    const current = words[index]
    const next = words[index + 1]
    const phrase = next && `${normalize(current[0])} ${normalize(next[0])}`
    const start = current.index
    if (start > cursor) result.push({ text: sentence.slice(cursor, start), key: null })
    if (phrase && known.has(phrase)) {
      const end = next.index + next[0].length
      result.push({ text: sentence.slice(start, end), key: phrase })
      cursor = end
      index += 2
    } else {
      const end = start + current[0].length
      result.push({ text: current[0], key: normalize(current[0]) })
      cursor = end
      index++
    }
  }
  if (cursor < sentence.length) result.push({ text: sentence.slice(cursor), key: null })
  return result
}

export function baseForm(word) {
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3).replace(/(.)\1$/, '$1')
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2)
  if (word.endsWith('s') && word.length > 3 && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

export function inflectionForms(word) {
  const forms = new Set([word])
  if (word.endsWith('ies') && word.length > 3) forms.add(`${word.slice(0, -3)}y`)
  if (word.endsWith('ing') && word.length > 4) {
    const stem = word.slice(0, -3)
    forms.add(stem); forms.add(`${stem}e`)
    if (/(.)\1$/.test(stem)) forms.add(stem.slice(0, -1))
  }
  if (word.endsWith('ed') && word.length > 3) {
    const stem = word.slice(0, -2)
    forms.add(stem); forms.add(`${stem}e`)
    if (/(.)\1$/.test(stem)) forms.add(stem.slice(0, -1))
  }
  if (word.endsWith('es') && word.length > 3) forms.add(word.slice(0, -2))
  if (word.endsWith('s') && word.length > 2) forms.add(word.slice(0, -1))
  return forms
}

export function isInflectionNear(answer, target) {
  const answerWords = answer.trim().toLowerCase().split(/\s+/)
  const targetWords = target.trim().toLowerCase().split(/\s+/)
  if (answerWords.length !== targetWords.length) return false
  return answerWords.every((word, index) => inflectionForms(word).has(targetWords[index]) || inflectionForms(targetWords[index]).has(word))
}

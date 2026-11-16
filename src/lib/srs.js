// Pure spaced-repetition scheduling helpers for the three review responses.
// Callers provide the previous count and current time; no app state is read here.
export function calculateReviewSchedule(rating, previousCount, now = Date.now()) {
  const count = rating === '认识' ? previousCount + 1 : rating === '不认识' ? 0 : previousCount
  const days = rating === '认识' ? [1, 2, 4, 7, 15, 30][Math.min(count - 1, 5)] : rating === '模糊' ? 1 : 0
  const delay = rating === '不认识' ? 10 * 60 * 1000 : days * 86400000
  return { count, nextReviewAt: new Date(now + delay).toISOString() }
}

export function shuffled(items) {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[result[index], result[swapIndex]] = [result[swapIndex], result[index]]
  }
  return result
}

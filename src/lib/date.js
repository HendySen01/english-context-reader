// Pure local-calendar helpers for review history and streak calculations.
// Dates are interpreted in the browser's local time zone.
export function localDateKey(value) {
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function calculateStreakDays(reviewRows, now = new Date()) {
  const byDate = new Set(reviewRows.map(row => localDateKey(row.reviewed_at)))
  const todayKey = localDateKey(now)
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (!byDate.has(todayKey)) cursor.setDate(cursor.getDate() - 1)
  let streak = 0
  while (byDate.has(localDateKey(cursor))) { streak++; cursor.setDate(cursor.getDate() - 1) }
  return streak
}

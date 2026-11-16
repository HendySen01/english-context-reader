// Safe browser-storage helpers; storage is passed in so callers choose localStorage or another store.
// Read and parse errors return the supplied fallback, and write errors never escape.
export function readStorage(storage, key, fallback = null) {
  try { return storage.getItem(key) ?? fallback } catch { return fallback }
}

export function writeStorage(storage, key, value) {
  try { storage.setItem(key, String(value)); return true } catch { return false }
}

export function readStorageJson(storage, key, fallback) {
  try {
    const value = storage.getItem(key)
    return value == null ? fallback : JSON.parse(value)
  } catch { return fallback }
}

export function writeStorageJson(storage, key, value) {
  try { storage.setItem(key, JSON.stringify(value)); return true } catch { return false }
}

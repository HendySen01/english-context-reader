import { createClient } from '@supabase/supabase-js'

const cleanEnv = value => String(value || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim()
const supabaseUrl = cleanEnv(import.meta.env.VITE_SUPABASE_URL)
const supabaseAnonKey = cleanEnv(import.meta.env.VITE_SUPABASE_ANON_KEY)

let client = null
try {
  if (!/^https?:\/\//i.test(supabaseUrl)) throw new Error('Supabase URL must start with http or https')
  const parsedUrl = new URL(supabaseUrl)
  if (!/^https?:$/.test(parsedUrl.protocol) || !parsedUrl.hostname || !supabaseAnonKey) throw new Error('Missing or invalid Supabase URL/key')
  client = createClient(parsedUrl.toString().replace(/\/$/, ''), supabaseAnonKey)
} catch {
  console.warn('[Supabase] URL 或 publishable key 缺失/无效，已切换为本地模式。')
}

export const supabase = client

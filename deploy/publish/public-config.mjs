// Accept only canonical hosted Supabase project URLs and browser-safe key formats.
export function validatePublicConfig(url, key) {
  const project = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(url ?? '')?.[1]
  if (!project || (url !== `https://${project}.supabase.co` && url !== `https://${project}.supabase.co/`)) return false
  if (typeof key !== 'string' || key !== key.trim() || /placeholder|example/i.test(key)) return false
  if (/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(key)) return true

  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(key)) return false
  try {
    const [encodedHeader, encodedPayload] = key.split('.')
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url'))
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url'))
    return header.alg === 'HS256' && payload.iss === 'supabase' && payload.role === 'anon' && payload.ref === project
  } catch {
    return false
  }
}

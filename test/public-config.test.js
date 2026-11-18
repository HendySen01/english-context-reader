import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validatePublicConfig } from '../deploy/publish/public-config.mjs'

const project = 'a'.repeat(20)
const url = `https://${project}.supabase.co`
const publicKey = `sb_publishable_${'a'.repeat(24)}`
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const legacy = (role, ref = project) => `${encode({ alg: 'HS256' })}.${encode({ iss: 'supabase', role, ref })}.${'a'.repeat(43)}`

test('accepts hosted project and publishable or matching legacy anon key', () => {
  assert.ok(validatePublicConfig(url, publicKey))
  assert.ok(validatePublicConfig(`${url}/`, legacy('anon')))
})

test('rejects service_role, secret and DeepSeek-shaped keys, and placeholders', () => {
  for (const key of [legacy('service_role'), 'sb_secret_synthetic', 'sk-synthetic', 'sb_publishable_ci_placeholder', '']) {
    assert.equal(validatePublicConfig(url, key), false)
  }
})

test('rejects project mismatch and URLs with credentials, ports, paths or queries', () => {
  assert.equal(validatePublicConfig(url, legacy('anon', 'b'.repeat(20))), false)
  for (const value of [`${url}:443`, `${url}/a`, `${url}?`, `${url}\n`, url.replace('://', '://user@'), url.replace('https:', 'http:')]) {
    assert.equal(validatePublicConfig(value, publicKey), false)
  }
})

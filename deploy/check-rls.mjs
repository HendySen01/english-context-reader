// Read-only staging check. Each test account needs at least one row in each table.
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

async function run() {
  const project = new URL(requireEnv('RLS_TEST_SUPABASE_URL'))
  assert.equal(project.protocol, 'https:')
  assert.match(project.hostname, /^[a-z0-9-]+\.supabase\.co$/)
  const key = requireEnv('RLS_TEST_SUPABASE_KEY')
  assert.match(key, /^sb_publishable_/)
  const accounts = await Promise.all(['A', 'B'].map(async label => {
    const client = createClient(project.origin, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (url, options) => fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(8000) }) }
    })
    const { data, error } = await client.auth.signInWithPassword({
      email: requireEnv(`RLS_TEST_EMAIL_${label}`), password: requireEnv(`RLS_TEST_PASSWORD_${label}`)
    })
    assert.ok(!error && data?.user?.id, `Account ${label} sign-in failed`)
    return { client, id: data.user.id }
  }))
  assert.notEqual(accounts[0].id, accounts[1].id, 'Use two distinct test accounts')
  for (const table of ['sentences', 'word_notes', 'review_logs']) {
    for (const [mine, other] of [accounts, [...accounts].reverse()]) {
      const own = await mine.client.from(table).select('id').eq('user_id', mine.id).limit(1)
      assert.ok(!own.error && own.data.length === 1, `${table}: missing readable own-account fixture`)
      const foreign = await mine.client.from(table).select('id').eq('user_id', other.id).limit(1)
      assert.ok(!foreign.error && foreign.data.length === 0, `${table}: foreign rows are visible or the query failed`)
    }
    console.log(`${table}: both accounts can read their own rows, foreign rows are filtered`)
  }
}

run().catch(error => { console.error(error.message); process.exitCode = 1 })

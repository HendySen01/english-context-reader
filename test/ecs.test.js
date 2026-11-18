import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { createApi } from '../server/index.js'
import { createProvider, prepareCompletion } from '../server/llm.js'
import { assertPublicSupabaseKey, createQuota, resolvePublicIPv4 } from '../server/security.js'
import { requestLlm } from '../src/lib/llm-request.js'
import { validateAnalysis, validateTranslations } from '../src/lib/validate.js'

const body = {
  messages: [{ role: 'system', content: 'Return JSON' }, { role: 'user', content: 'Read this.' }],
  max_tokens: 4000, temperature: 0.3
}
const envelope = content => ({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] })

test('build and runtime credential guard refuses privileged Supabase keys', () => {
  const jwt = role => `header.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`
  assert.doesNotThrow(() => assertPublicSupabaseKey('sb_publishable_fake_value'))
  assert.doesNotThrow(() => assertPublicSupabaseKey(jwt('anon')))
  for (const key of ['', 'sb_secret_fake_value', jwt('service_role')]) {
    assert.throws(() => assertPublicSupabaseKey(key), /publishable or legacy anon/)
  }
})

test('SSRF: mixed DNS answers and special addresses fail closed', async () => {
  for (const denied of ['100.100.100.200', '10.0.0.1', '127.0.0.1', '169.254.1.2', '172.31.1.2', '192.168.1.1', '::1', 'fe80::1', '::ffff:127.0.0.1']) {
    await assert.rejects(resolvePublicIPv4('api.deepseek.com', undefined, async () => ['8.8.8.8', denied]))
  }
  await assert.rejects(resolvePublicIPv4('api.deepseek.com', undefined, async () => []))
})

test('SSRF: transport pins the checked IP, uses provider TLS name, and refuses redirects', async () => {
  const calls = []
  const complete = createProvider('test-secret', {
    resolve: async host => { assert.equal(host, 'api.deepseek.com'); return '8.8.8.8' },
    httpsRequest(options, callback) {
      calls.push(options)
      const stream = Readable.from([])
      stream.statusCode = 302
      stream.headers = { location: 'http://blocked.invalid/' }
      const outgoing = new EventEmitter()
      outgoing.end = () => callback(stream)
      return outgoing
    }
  })
  await assert.rejects(complete(body), { status: 502 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].hostname, '8.8.8.8')
  assert.equal(calls[0].servername, 'api.deepseek.com')
  assert.equal(calls[0].headers.Host, 'api.deepseek.com')
})

test('provider parameters and cost controls are fixed server-side', () => {
  for (const fields of [{ baseUrl: 'https://example.invalid' }, { apiKey: 'key' }, { model: 'other' }, { stream: true }, { tools: [] }, { max_tokens: 8001 }]) {
    assert.throws(() => prepareCompletion({ ...body, ...fields }), { status: 400 })
  }
  const prepared = prepareCompletion({ ...body, messages: body.messages.map(m => ({ ...m, tools: [] })) })
  assert.equal(prepared.model, 'deepseek-flash')
  assert.equal(prepared.stream, false)
  assert.equal(prepared.thinking.type, 'disabled')
  assert.equal('tools' in prepared.messages[0], false)
})

test('provider transport returns bounded chat completions with no upstream metadata', async () => {
  let responseBody = JSON.stringify({ ...envelope({ definition: '阅读' }), internal: 'private' })
  const complete = createProvider('test-secret', {
    resolve: async () => '8.8.8.8',
    httpsRequest(_options, callback) {
      const stream = Readable.from([Buffer.from(responseBody)])
      stream.statusCode = 200
      stream.headers = { 'content-type': 'application/json' }
      const outgoing = new EventEmitter()
      outgoing.end = () => callback(stream)
      return outgoing
    }
  })
  assert.deepEqual(await complete(body), envelope({ definition: '阅读' }))
  responseBody = 'x'.repeat(1024 * 1024 + 1)
  await assert.rejects(complete(body), { status: 502, message: 'Model response is too large' })
})

test('account and global daily budgets persist and reset on UTC rollover', t => {
  const dir = mkdtempSync(join(tmpdir(), 'reader-quota-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'quota.json')
  let currentDate = Date.UTC(2026, 10, 18)
  const limits = { perAccount: 1, globalCalls: 2, globalUnits: 100 }
  const make = () => createQuota(file, limits, () => currentDate)
  make()('a', 50)
  const restored = make()
  assert.throws(() => restored('a', 1), { status: 429 })
  assert.throws(() => restored('b', 51), { status: 429 })
  restored('b', 50)
  assert.throws(() => restored('c', 1), { status: 429 })
  currentDate += 86_400_000
  make()('a', 30)
})

const analysis = {
  text: 'read', type: 'word', pronunciation: '/riːd/', partOfSpeech: 'verb',
  usage: '阅读文字', definition: '阅读',
  etymology: { origin: 'Old English', originalImage: '解读文字' },
  examples: [{ text: 'Read this.', translation: '读这个。' }],
  semanticRoutes: [{ label: 'A', steps: '解读到阅读', modernMeaning: '阅读' }]
}

test('local HTTP flow: Supabase SDK identity, authorization, isolation, analysis, translation and errors', async t => {
  const tokenA = 'fake.account.a'
  const tokenB = 'fake.account.b'
  const tokenC = 'fake.account.c'
  // Real SDK getUser path with an isolated fake Auth endpoint. No production database or network.
  const authClient = createClient('https://project.supabase.co', 'fake-public-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, options) => {
      assert.equal(new URL(input).pathname, '/auth/v1/user')
      const token = new Headers(options.headers).get('authorization')
      const id = new Map([[tokenA, 'a'], [tokenB, 'b'], [tokenC, 'c']]).get(token?.slice(7))
      return Response.json(id ? { id } : { msg: 'invalid token' }, { status: id ? 200 : 401 })
    } }
  })
  const charges = []
  let unblock
  let started
  const processing = new Promise(resolve => { started = resolve })
  const hold = new Promise(resolve => { unblock = resolve })
  const api = createApi({
    getUser: token => authClient.auth.getUser(token),
    allowedAccounts: new Set(['a', 'b']),
    reserve: id => charges.push(id),
    complete: async payload => {
      const input = payload.messages[1].content
      if (input === 'hold') { started(); await hold }
      if (input === 'error') throw new Error('private upstream response')
      return envelope(input === 'translate' ? [{ i: 0, zh: '第一句' }, { i: 1, zh: '' }] : analysis)
    }
  })
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  t.after(() => { unblock(); api.closeAllConnections(); return new Promise(resolve => api.close(resolve)) })
  const direct = (path, options) => fetch(`http://127.0.0.1:${api.address().port}${path}`, options)
  const post = (token, payload = body) => direct('/api/llm', { method: 'POST', headers: {
    'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` })
  }, body: JSON.stringify(payload) })
  const auth = token => ({ getSession: async () => ({ data: { session: { access_token: token } } }) })
  const managed = (token, input) => requestLlm({
    ...body, baseUrl: 'https://ignored.invalid', apiKey: 'ignored', model: 'ignored',
    messages: [body.messages[0], { role: 'user', content: input }]
  }, { managed: true, auth: auth(token), fetcher: direct })

  assert.equal((await direct('/healthz')).status, 200)
  assert.equal((await direct('/api/llm')).status, 405)
  assert.equal((await post()).status, 401)
  assert.equal((await post('fake.invalid.token')).status, 401)
  await assert.rejects(managed(tokenC, 'lookup'), /没有 AI 使用权限/)
  assert.equal((await post(tokenA, { ...body, baseUrl: 'https://example.invalid' })).status, 400)
  assert.equal((await post(tokenA, { ...body, padding: 'x'.repeat(128 * 1024) })).status, 413)
  assert.deepEqual(charges, [])
  const lookup = await (await managed(tokenA, 'lookup')).json()
  assert.equal(validateAnalysis(lookup.choices[0].message.content).data.definition, '阅读')
  const translation = await (await managed(tokenB, 'translate')).json()
  assert.deepEqual(validateTranslations(translation.choices[0].message.content, 2).data, [{ i: 0, zh: '第一句' }])

  const inFlight = managed(tokenA, 'hold')
  await processing
  try {
    await assert.rejects(managed(tokenA, 'lookup'), /AI 服务繁忙/)
    assert.equal((await managed(tokenB, 'lookup')).status, 200)
  } finally { unblock() }
  assert.equal((await inFlight).status, 200)
  const failed = await managed(tokenB, 'error')
  assert.equal(failed.status, 502)
  assert.doesNotMatch(await failed.text(), /private upstream/)
  assert.deepEqual(charges, ['a', 'b', 'a', 'b', 'b'])
})

test('Vercel/development mode keeps the original body and does not require Supabase', async () => {
  const payload = { ...body, apiKey: 'user-key', baseUrl: 'https://example.invalid', model: 'legacy' }
  await requestLlm(payload, { fetcher: async (path, options) => {
    assert.equal(path, '/api/llm')
    assert.deepEqual(JSON.parse(options.body), payload)
    assert.equal(options.headers.Authorization, undefined)
    return Response.json({})
  } })
})

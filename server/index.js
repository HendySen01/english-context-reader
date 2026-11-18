import { createServer } from 'node:http'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { createProvider, prepareCompletion } from './llm.js'
import { assertPublicSupabaseKey, createQuota, HttpError } from './security.js'

const bodyLimit = 128 * 1024
const shutdownMessage = 'AI service is shutting down. Please retry shortly.'

function shuttingDown(res) {
  res.setHeader('Connection', 'close')
  res.setHeader('Retry-After', '5')
  json(res, 503, { error: shutdownMessage })
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(data))
}

async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')
    || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) {
    throw new HttpError(415, 'Expected uncompressed application/json')
  }
  if (Number(req.headers['content-length']) > bodyLimit) throw new HttpError(413, 'Request body is too large')
  const chunks = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > bodyLimit) throw new HttpError(413, 'Request body is too large')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
}

export function createApi({
  getUser, allowedAccounts, reserve, complete, concurrency = 2, timeoutMs = 180_000,
  drainMs = 180_000, flushMs = 5000
}) {
  let closing
  const inFlight = new Map()
  const activeAccounts = new Set()
  const server = createServer({
    maxHeaderSize: 16 * 1024,
    requestTimeout: 15_000,
    headersTimeout: 10_000,
    connectionsCheckingInterval: 1000
  }, async (req, res) => {
    if (closing) return shuttingDown(res)
    if (req.url === '/healthz' && req.method === 'GET') return json(res, 200, { ok: true })
    if (req.url !== '/api/llm') return json(res, 404, { error: 'Not found' })
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return json(res, 405, { error: 'Method not allowed' })
    }
    const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(req.headers.authorization || '')?.[1]
    if (!token || token.length > 8192) return json(res, 401, { error: 'Sign in to use AI' })
    if (inFlight.size >= concurrency) return json(res, 429, { error: 'AI service is busy' })

    let account
    const client = new AbortController()
    const limit = AbortSignal.timeout(timeoutMs)
    const signal = AbortSignal.any([client.signal, limit])
    inFlight.set(res, client)
    res.once('close', () => {
      if (!res.writableFinished) client.abort()
    })
    try {
      // Validate the body before doing network I/O or reserving quota.
      const payload = prepareCompletion(await readBody(req))
      signal.throwIfAborted()
      const { data, error } = await getUser(token, signal)
      if (error && ![400, 401, 403].includes(error.status)) throw new HttpError(503, 'Authentication temporarily unavailable')
      const id = data?.user?.id
      if (error || !id) throw new HttpError(401, 'Sign in to use AI')
      if (!allowedAccounts.has(id)) throw new HttpError(403, 'Account is not authorized for AI')
      if (activeAccounts.has(id)) throw new HttpError(429, 'An AI request is already running for this account')
      signal.throwIfAborted()
      account = id
      activeAccounts.add(id)
      // Input bytes + framing margin + maximum output. This is a budget unit, not provider billing.
      reserve(id, Buffer.byteLength(JSON.stringify(payload.messages)) + 256 + payload.max_tokens)
      const result = await complete(payload, signal)
      signal.throwIfAborted()
      json(res, 200, result)
    } catch (error) {
      if (client.signal.aborted || res.destroyed || res.writableEnded) return
      const status = limit.aborted ? 504 : error instanceof HttpError ? error.status : 502
      if (status >= 500) console.error('[ecs-api]', { status, event: 'request-failed' })
      if (!req.readableEnded) res.setHeader('Connection', 'close')
      json(res, status, { error: status === 504 ? 'AI request timed out' : error instanceof HttpError ? error.message : 'AI service unavailable' })
    } finally {
      if (account) activeAccounts.delete(account)
      inFlight.delete(res)
    }
  })
  server.maxConnections = 64
  server.shutdown = () => {
    if (closing) return closing
    for (const res of inFlight.keys()) {
      if (!res.headersSent) res.setHeader('Connection', 'close')
    }
    closing = new Promise(resolve => {
      let forceTimer
      const drainTimer = setTimeout(() => {
        for (const [res, controller] of inFlight) {
          if (!res.headersSent && !res.destroyed) shuttingDown(res)
          controller.abort()
        }
        // Give the response time to flush before terminating any stubborn sockets.
        forceTimer = setTimeout(() => server.closeAllConnections(), flushMs)
        forceTimer.unref()
      }, drainMs)
      drainTimer.unref()
      server.close(() => {
        clearTimeout(drainTimer)
        clearTimeout(forceTimer)
        resolve()
      })
    })
    return closing
  }
  return server
}

function start() {
  const env = process.env
  const supabaseUrl = new URL(env.SUPABASE_URL)
  const publicKey = env.SUPABASE_PUBLISHABLE_KEY || ''
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supabaseUrl.origin)
    || supabaseUrl.pathname !== '/' || supabaseUrl.search || supabaseUrl.hash || supabaseUrl.username || supabaseUrl.password
    || !publicKey) throw new Error('Configure a hosted Supabase project and publishable key')
  assertPublicSupabaseKey(publicKey)
  const allowedAccounts = new Set((env.AI_ALLOWED_USER_IDS || '').split(',').map(id => id.trim().toLowerCase()).filter(Boolean))
  if (!allowedAccounts.size || [...allowedAccounts].some(id => !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))) {
    throw new Error('Configure AI_ALLOWED_USER_IDS with Supabase UUIDs')
  }
  const apiKey = readFileSync(env.DEEPSEEK_API_KEY_FILE || '/run/secrets/deepseek_api_key', 'utf8').trim()
  if (!/^[!-~]{1,512}$/.test(apiKey)) throw new Error('Invalid model API key file')
  function positive(name, fallback) {
    const value = Number(env[name] ?? fallback)
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`)
    return value
  }
  const authSignal = new AsyncLocalStorage()
  const supabase = createClient(supabaseUrl.origin, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (url, options) => {
        const signals = [authSignal.getStore(), options?.signal, AbortSignal.timeout(5000)].filter(Boolean)
        return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.any(signals) })
      }
    }
  })
  const reserve = createQuota(env.AI_QUOTA_FILE || '/var/lib/reader/quota.json', {
    perAccount: positive('AI_ACCOUNT_DAILY_CALLS', 30),
    globalCalls: positive('AI_GLOBAL_DAILY_CALLS', 100),
    globalUnits: positive('AI_GLOBAL_DAILY_UNITS', 500_000)
  })
  const api = createApi({
    getUser: (token, signal) => authSignal.run(signal, () => supabase.auth.getUser(token)),
    allowedAccounts, reserve, complete: createProvider(apiKey)
  })
  api.listen(3000, '0.0.0.0', () => console.log('[ecs-api] listening'))
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, api.shutdown)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { start() } catch {
    console.error('[ecs-api] startup failed: check public configuration, secret and quota volume')
    process.exitCode = 1
  }
}

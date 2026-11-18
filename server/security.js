import { Resolver } from 'node:dns/promises'
import { BlockList, isIPv4 } from 'node:net'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function assertPublicSupabaseKey(key) {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key || '')) return
  try {
    const segments = key.split('.')
    if (segments.length === 3 && JSON.parse(Buffer.from(segments[1], 'base64url')).role === 'anon') return
  } catch {
    // Invalid credentials are handled uniformly below without logging the value.
  }
  throw new Error('A Supabase publishable or legacy anon key is required')
}

const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) blocked.addSubnet(address, prefix)
blocked.addAddress('100.100.100.200')

export async function resolvePublicIPv4(host, signal, resolve = resolveProvider) {
  signal?.throwIfAborted()
  const addresses = await resolve(host)
  signal?.throwIfAborted()
  // Require public A records and never fall back to IPv6 or the system resolver.
  if (!addresses.length || addresses.some(ip => !isIPv4(ip) || blocked.check(ip))) {
    throw new HttpError(502, 'Provider address is unavailable')
  }
  return addresses[0]
}

async function resolveProvider(host, signal) {
  const resolver = new Resolver({ timeout: 2000, tries: 2 })
  const cancel = () => resolver.cancel()
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    return await resolver.resolve4(host)
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}

export function createQuota(file, { perAccount, globalCalls, globalUnits }, now = Date.now) {
  mkdirSync(dirname(file), { recursive: true })
  let state
  try {
    state = JSON.parse(readFileSync(file, 'utf8'))
    const count = value => Number.isSafeInteger(value) && value >= 0
    if (!/^\d{4}-\d{2}-\d{2}$/.test(state.day) || !count(state.calls) || !count(state.units)
      || !state.accounts || Array.isArray(state.accounts) || typeof state.accounts !== 'object'
      || !Object.values(state.accounts).every(count)) throw new Error('Invalid quota state')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return (id, units) => {
    const day = new Date(now()).toISOString().slice(0, 10)
    if (!state || state.day < day) state = { day, calls: 0, units: 0, accounts: {} }
    const calls = (Object.hasOwn(state.accounts, id) ? state.accounts[id] : 0) + 1
    if (state.day !== day || calls > perAccount || state.calls >= globalCalls || state.units + units > globalUnits) {
      throw new HttpError(429, 'Daily AI quota exceeded')
    }
    const next = { day, calls: state.calls + 1, units: state.units + units, accounts: { ...state.accounts, [id]: calls } }
    // Reserve before sending any paid request. The volume survives upgrades and restarts.
    writeFileSync(`${file}.tmp`, JSON.stringify(next), { mode: 0o600, flush: true })
    renameSync(`${file}.tmp`, file)
    state = next
  }
}

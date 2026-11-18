import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { validateAnalysis, validateTranslations } from '../../src/lib/validate.js'

const origin = `http://127.0.0.1:${process.env.WEB_PORT}`
const state = name => join(process.env.CI_STATE_DIR, name)
function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 110000 }).trim()
}
const compose = (...args) => docker('compose', ...args)
const inspect = service => {
  const id = compose('ps', '-a', '-q', service)
  return JSON.parse(docker('inspect', id))[0]
}
async function until(predicate) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return
    await delay(50)
  }
  throw new Error('Container test condition timed out')
}
let requestNumber = 0
function post(task, { signal, identity = 'authorized' } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    // Exercise discrete clients without exhausting one ingress IP's burst allowance.
    'X-Reader-Client-IP': `192.0.2.${++requestNumber}`
  }
  if (identity) headers.Authorization = `Bearer ci.${identity}.token`
  return fetch(`${origin}/api/llm`, {
    method: 'POST', headers, signal: signal || AbortSignal.timeout(15000),
    body: JSON.stringify({ messages: [{ role: 'system', content: 'Return JSON' }, { role: 'user', content: task }], max_tokens: 400, temperature: 0.2 })
  })
}

if (process.argv[2] === 'production-entry') {
  const web = inspect('web')
  const api = inspect('api')
  for (const container of [web, api]) assert.equal(container.State.Health.Status, 'healthy')
  assert.equal(web.HostConfig.Memory, 128 * 1024 * 1024)
  assert.equal(api.HostConfig.Memory, 384 * 1024 * 1024)
  const apiNetworks = Object.keys(api.NetworkSettings.Networks)
  assert.equal(apiNetworks.length, 2)
  for (const network of apiNetworks) {
    assert.equal(docker('network', 'inspect', '--format', '{{.Internal}}', network), 'true')
  }
  assert.deepEqual(web.NetworkSettings.Ports['80/tcp'], [{ HostIp: '127.0.0.1', HostPort: process.env.WEB_PORT }])
  assert.ok(Object.values(api.NetworkSettings.Ports).every(value => value === null))
  assert.equal((await fetch(`${origin}/healthz`)).status, 200)
  assert.equal((await fetch(origin)).status, 200)
  assert.equal((await post('lookup', { identity: '' })).status, 401)
  console.log('Production entry, Web/API health, reverse proxy, and published ports verified')
} else {
  assert.equal((await post('lookup', { identity: 'invalid' })).status, 401)
  const lookup = await post('lookup')
  assert.equal(lookup.status, 200)
  assert.ok(validateAnalysis((await lookup.json()).choices[0].message.content).ok)
  const translation = await post('translate')
  assert.equal(translation.status, 200)
  assert.deepEqual(validateTranslations((await translation.json()).choices[0].message.content, 2).data,
    [{ i: 0, zh: '第一句' }])

  assert.equal((await post('quota', { identity: 'quota' })).status, 200)
  const volumeName = inspect('api').Mounts.find(mount => mount.Destination === '/var/lib/reader').Name
  compose('restart', 'api')
  compose('up', '-d', '--wait', '--wait-timeout', '60', '--no-build', 'api', 'web')
  assert.equal(inspect('api').Mounts.find(mount => mount.Destination === '/var/lib/reader').Name, volumeName)
  const quota = await post('quota', { identity: 'quota' })
  assert.equal(quota.status, 429)
  assert.equal((await quota.json()).error, 'Daily AI quota exceeded')
  console.log('Mock completions, auth rejection, translation and quota restart verified')

  const abort = new AbortController()
  const cancelled = assert.rejects(post('cancel', { signal: abort.signal }), { name: 'AbortError' })
  await until(() => existsSync(state('cancel.started')))
  abort.abort()
  await cancelled
  await until(() => ['cancel.cancelled', 'cancel.upstream-closed'].every(name => existsSync(state(name))))

  for (const task of ['drain', 'deadline']) {
    rmSync(state('api.stopping'), { force: true })
    const result = post(task)
    // Attach a rejection handler while polling for receipt of the request.
    result.catch(() => {})
    await until(() => existsSync(state(`${task}.started`)))
    docker('kill', '--signal=TERM', inspect('api').Id)
    await until(() => existsSync(state('api.stopping')))
    if (task === 'drain') writeFileSync(state('drain.release'), '')
    const response = await result
    assert.equal(response.status, task === 'drain' ? 200 : 503)
    if (task === 'deadline') {
      assert.equal(response.headers.get('retry-after'), '5')
      await until(() => ['deadline.cancelled', 'deadline.upstream-closed'].every(name => existsSync(state(name))))
    }
    await response.text()
    assert.equal(docker('wait', inspect('api').Id), '0')
    if (task === 'drain') compose('up', '-d', '--wait', '--wait-timeout', '60', '--no-build', 'api', 'web')
  }
  console.log('Client disconnect reached mock upstream; SIGTERM drain and deadline exit verified')
}

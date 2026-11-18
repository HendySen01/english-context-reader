// Mounted only by the CI override. The real API image does not contain this file.
import { createServer } from 'node:http'
import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const state = '/ci/state'
const account = '12345678-1234-4234-8234-123456789abc'
const quotaAccount = '23456789-2345-4345-8345-23456789abcd'

if (process.argv[2] === 'mock') {
  createServer(async (req, res) => {
    if (req.url === '/healthz') return res.end('ok')
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
      res.writeHead(404).end()
      return
    }
    let input = ''
    for await (const chunk of req) input += chunk
    const { messages, model } = JSON.parse(input)
    if (model !== 'deepseek-flash') return res.writeHead(400).end()
    const task = messages[1].content
    if (task === 'cancel' || task === 'deadline') {
      res.on('close', () => writeFileSync(`${state}/${task}.upstream-closed`, ''))
      // Flush headers so the caller can observe the upstream has received the request.
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.flushHeaders()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (task === 'drain') {
      res.flushHeaders()
      while (!res.destroyed && !existsSync(`${state}/drain.release`)) await delay(30)
    }
    if (res.destroyed) return
    const content = task === 'translate'
      ? [{ i: 0, zh: '第一句' }, { i: 1, zh: '' }]
      : {
          text: 'read', type: 'word', pronunciation: '/riːd/', partOfSpeech: 'verb',
          usage: '阅读文字', definition: '阅读',
          etymology: { origin: 'Old English', originalImage: '解读文字' },
          examples: [{ text: 'Read this.', translation: '读这个。' }],
          semanticRoutes: [{ label: 'A', steps: '解读到阅读', modernMeaning: '阅读' }]
        }
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] }))
  }).listen(3100, '0.0.0.0')
} else {
  const { createApi } = await import('/app/server/index.js')
  const { createQuota } = await import('/app/server/security.js')
  const reserve = createQuota('/var/lib/reader/ci-quota.json', {
    perAccount: 1, globalCalls: 10, globalUnits: 100000
  })
  const api = createApi({
    getUser: async token => {
      const id = new Map([['ci.authorized.token', account], ['ci.quota.token', quotaAccount]]).get(token)
      return id ? { data: { user: { id } } } : { error: { status: 401 } }
    },
    allowedAccounts: new Set([account, quotaAccount]),
    reserve: (id, units) => {
      // Keep lifecycle scenarios independent of the dedicated quota account.
      if (id === quotaAccount) reserve(id, units)
    },
    drainMs: 5000,
    flushMs: 1000,
    complete: async (payload, signal) => {
      const task = payload.messages[1].content
      const response = await fetch('http://mock:3100/v1/chat/completions', {
        method: 'POST', body: JSON.stringify(payload), signal, redirect: 'error'
      })
      if (['cancel', 'deadline', 'drain'].includes(task)) {
        writeFileSync(`${state}/${task}.started`, '')
      }
      try {
        return await response.json()
      } finally {
        if (signal.aborted && ['cancel', 'deadline'].includes(task)) writeFileSync(`${state}/${task}.cancelled`, '')
      }
    }
  })
  api.listen(3000, '0.0.0.0')
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    api.shutdown()
    writeFileSync(`${state}/api.stopping`, '')
  })
}

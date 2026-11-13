import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { URL } from 'node:url'

function llmProxy() {
  return {
    name: 'llm-proxy-target',
    configureServer(server) {
      server.middlewares.use('/api/llm', async (req, res, next) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ error: 'POST required' }))
          return
        }
        try {
          let raw = ''
          for await (const chunk of req) raw += chunk
          const input = JSON.parse(raw)
          const base = new URL(input.baseUrl)
          if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Invalid Base URL protocol')
          const prefix = base.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '')
          const path = `${prefix}/v1/chat/completions`
          const upstream = new URL(path, base.origin)
          const { baseUrl, apiKey, ...payload } = input
          const response = await fetch(upstream, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(payload),
          })
          res.statusCode = response.status
          res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json')
          res.end(await response.text())
        } catch (error) {
          console.error('[llm-proxy]', error)
          res.statusCode = 502
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: error instanceof SyntaxError ? 'Invalid proxy request JSON' : 'Unable to reach model provider' }))
        }
      })
    },
  }
}

export default defineConfig({ plugins: [vue(), llmProxy()] })

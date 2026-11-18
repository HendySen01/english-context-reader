import { request } from 'node:https'
import { HttpError, resolvePublicIPv4 } from './security.js'

const provider = Object.freeze({ host: 'api.deepseek.com', path: '/v1/chat/completions', model: 'deepseek-flash' })
const maxResponseBytes = 1024 * 1024

export function prepareCompletion(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Expected a JSON object')
  const allowed = ['messages', 'max_tokens', 'temperature', 'response_format']
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new HttpError(400, 'Unsupported request field')
  const { messages, max_tokens, temperature, response_format } = input
  if (!Array.isArray(messages) || messages.length !== 2
    || messages.some((message, i) => message?.role !== ['system', 'user'][i]
      || typeof message?.content !== 'string' || !message.content.trim())
    || !Number.isInteger(max_tokens) || max_tokens < 1 || max_tokens > 8000
    || !Number.isFinite(temperature) || temperature < 0 || temperature > 1
    || (response_format !== undefined && response_format?.type !== 'json_object')) {
    throw new HttpError(400, 'Invalid completion parameters')
  }
  return {
    model: provider.model,
    messages: messages.map(({ role, content }) => ({ role, content })),
    max_tokens,
    temperature,
    stream: false,
    thinking: { type: 'disabled' },
    ...(response_format && { response_format: { type: 'json_object' } })
  }
}

export function createProvider(apiKey, { resolve = resolvePublicIPv4, httpsRequest = request } = {}) {
  return async (payload, signal) => {
    const address = await resolve(provider.host, signal)
    const body = JSON.stringify(payload)
    return new Promise((resolveResponse, reject) => {
      // Connect to the checked IP without a second DNS lookup. Keep TLS SNI and certificate verification for the provider.
      const upstream = httpsRequest({
        hostname: address, servername: provider.host, port: 443, path: provider.path,
        method: 'POST', agent: false, signal,
        headers: {
          Host: provider.host, Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body), 'Accept-Encoding': 'identity'
        }
      }, response => {
        // https.request never follows redirects. Treat all non-success responses as errors.
        if (response.statusCode !== 200 || !/^application\/json\b/i.test(response.headers['content-type'] || '')) {
          response.destroy()
          reject(new HttpError(response.statusCode === 429 ? 429 : 502, 'Model provider could not complete the request'))
          return
        }
        const chunks = []
        let size = 0
        response.on('data', chunk => {
          size += chunk.length
          if (size > maxResponseBytes) response.destroy(new HttpError(502, 'Model response is too large'))
          else chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () => {
          try {
            const { choices } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const choice = choices?.[0]
            if (typeof choice?.message?.content !== 'string') throw new Error()
            resolveResponse({ choices: [{ message: { content: choice.message.content }, finish_reason: choice.finish_reason }] })
          } catch {
            reject(new HttpError(502, 'Invalid model response'))
          }
        })
      })
      upstream.on('error', reject)
      upstream.end(body)
    })
  }
}

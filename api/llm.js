/**
 * Vercel Serverless Function: POST /api/llm
 * Accepts { baseUrl, model, apiKey, ...chatCompletionPayload } and forwards it
 * to an OpenAI-compatible /v1/chat/completions endpoint.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
    const { baseUrl, model, apiKey, ...payload } = body || {}

    const effectiveApiKey = typeof apiKey === 'string' && apiKey.trim()
      ? apiKey.trim()
      : process.env.DEEPSEEK_API_KEY

    if (!baseUrl || !model || !effectiveApiKey || !Array.isArray(payload.messages)) {
      return res.status(400).json({ error: 'baseUrl, model, and messages are required; configure apiKey or DEEPSEEK_API_KEY' })
    }

    let base
    try {
      base = new URL(baseUrl)
    } catch {
      return res.status(400).json({ error: 'Invalid baseUrl' })
    }
    if (!['http:', 'https:'].includes(base.protocol)) {
      return res.status(400).json({ error: 'baseUrl must use HTTP or HTTPS' })
    }

    const prefix = base.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '')
    const endpoint = new URL(`${prefix}/v1/chat/completions`, base.origin)
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${effectiveApiKey}`,
      },
      body: JSON.stringify({ ...payload, model }),
    })

    const responseBody = await upstream.text()
    res.status(upstream.status)
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json')
    return res.send(responseBody)
  } catch (error) {
    console.error('[api/llm] Upstream request failed:', error)
    return res.status(502).json({ error: 'Unable to reach the model provider' })
  }
}

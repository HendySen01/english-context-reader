export class AiAccessError extends Error {}

export async function requestLlm(payload, { managed = false, auth, fetcher = fetch } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  let body = payload
  if (managed) {
    const { data, error } = await auth?.getSession() || {}
    const token = data?.session?.access_token
    if (error || !token) throw new AiAccessError('请先登录后使用 AI 查词与翻译。')
    headers.Authorization = `Bearer ${token}`
    const { messages, max_tokens, temperature, response_format } = payload
    body = { messages, max_tokens, temperature, response_format }
  }
  const response = await fetcher('/api/llm', { method: 'POST', headers, body: JSON.stringify(body) })
  if (managed) {
    if (response.status === 401) throw new AiAccessError('登录已失效，请重新登录。')
    if (response.status === 403) throw new AiAccessError('当前账号没有 AI 使用权限。')
    if (response.status === 429) throw new AiAccessError('AI 服务繁忙或已达调用额度，请稍后再试。')
  }
  return response
}

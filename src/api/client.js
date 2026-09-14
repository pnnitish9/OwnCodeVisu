export class NetworkIssue extends Error {}

export const REQUEST_TIMEOUT_MS = { python: 15000, cpp: 25000 }

export async function apiFetch(baseUrl, path, options = {}, timeoutMs = 10000) {
  const url = baseUrl.replace(/\/+$/, '') + path
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal })
    clearTimeout(timer)
    let body
    try { body = await resp.json() }
    catch { throw new NetworkIssue('The backend returned a response that was not valid JSON.') }
    return { httpStatus: resp.status, body }
  } catch (err) {
    clearTimeout(timer)
    if (err.name === 'AbortError')
      throw new NetworkIssue(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`)
    if (err instanceof NetworkIssue) throw err
    throw new NetworkIssue(`Unable to reach the backend at ${baseUrl}. Is it running?`)
  }
}

export async function checkHealth(apiUrl) {
  try {
    const { httpStatus } = await apiFetch(apiUrl, '/health', {}, 4000)
    return httpStatus === 200
  } catch {
    return false
  }
}

export async function fetchLanguagesInfo(apiUrl) {
  try {
    const { body } = await apiFetch(apiUrl, '/api/languages', {}, 5000)
    if (body?.success) return body.data
  } catch {}
  return null
}

export async function postTrace(apiUrl, language, code, userInput) {
  const endpoint = language === 'python' ? '/api/python/trace' : '/api/cpp/trace'
  const timeout  = REQUEST_TIMEOUT_MS[language]
  return apiFetch(apiUrl, endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ code, user_input: userInput }),
  }, timeout)
}

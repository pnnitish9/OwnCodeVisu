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

export async function postTrace(apiUrl, language, code, userInput, limits = null) {
  const endpoint = language === 'python' ? '/api/python/trace' : '/api/cpp/trace'
  const timeout  = REQUEST_TIMEOUT_MS[language]
  
  const payload = { code, user_input: userInput }
  
  // Allow passing custom limits for complex programs
  if (limits && language === 'python') {
    payload.limits = limits
  }
  
  return apiFetch(apiUrl, endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  }, timeout)
}

/**
 * Reconstruct full heap snapshots from differential snapshots.
 * Smart snapshots store references to previous full snapshots to save memory.
 */
export function reconstructHeapSnapshots(traceData) {
  if (!traceData?.smart_snapshots_enabled) {
    return traceData // No reconstruction needed
  }
  
  const steps = traceData.steps
  let lastFullHeap = {}
  
  // Process each step and reconstruct heap state
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    
    if (step.heap_state && typeof step.heap_state === 'object') {
      if (step.heap_state._snapshot_ref !== undefined) {
        // This is a reference - reuse the last full snapshot
        step.heap_state = { ...lastFullHeap }
      } else {
        // This is a full snapshot - cache it
        lastFullHeap = { ...step.heap_state }
      }
    }
  }
  
  return traceData
}

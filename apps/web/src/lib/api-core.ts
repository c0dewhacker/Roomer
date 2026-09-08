export const BASE = '/api/v1'

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message)
    this.name = 'ApiError'
  }

  get fieldErrors(): string | null {
    const details = (this.body as { error?: { details?: { fieldErrors?: Record<string, string[]> } } })?.error?.details?.fieldErrors
    if (!details) return null
    const lines = Object.entries(details).filter(([, msgs]) => msgs.length > 0).map(([field, msgs]) => `${field}: ${msgs.join(', ')}`)
    return lines.length > 0 ? lines.join('; ') : null
  }
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isMutating = method !== 'GET' && method !== 'HEAD'
  const headers: Record<string, string> = isMutating ? { 'X-Requested-With': 'XMLHttpRequest' } : {}
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${BASE}${path}`, {
    method, credentials: 'include', headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let errorBody: unknown
    try { errorBody = await res.json() } catch { errorBody = null }
    const msg = (errorBody as { error?: { message?: string } })?.error?.message ?? (errorBody as { message?: string })?.message ?? `Request failed with status ${res.status}`
    throw new ApiError(res.status, msg, errorBody)
  }
  return res.json() as Promise<T>
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path), post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body), put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path), upload: <T>(path: string, formData: FormData) => request<T>('POST', path, formData),
}

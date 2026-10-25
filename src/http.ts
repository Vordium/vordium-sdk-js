import { VordiumError } from './errors.js'

/** How the SDK talks to a node. Injectable, so tests and other runtimes can answer without a network. */
export interface Transport {
  get(url: string, timeoutMs: number): Promise<{ status: number; body: unknown }>
  /** One attempt. `body` is sent byte for byte. */
  post(url: string, body: string, timeoutMs: number): Promise<{ status: number; body: unknown; retryAfter: string | null }>
}

const RETRY_STATUS = new Set([429, 502, 503, 504])

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctl.signal })
  } finally {
    clearTimeout(t)
  }
}

async function readBody(r: Response): Promise<unknown> {
  const text = await r.text()
  if (!text) return null
  try {
    return parseExactJson(text)
  } catch {
    return text.slice(0, 300)
  }
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))

/**
 * The default transport: `fetch`. A read (GET) is tried up to three times on a connection error, a timeout, 429 or
 * 502–504, with a random wait and the server's Retry-After. A write (POST) is never retried: a second attempt could
 * apply the same signed request twice.
 */
export const fetchTransport: Transport = {
  async get(url, timeoutMs) {
    let last: unknown = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetchWithTimeout(url, { headers: { accept: 'application/json' } }, timeoutMs)
        if (RETRY_STATUS.has(r.status) && attempt < 2) {
          const ra = Number(r.headers.get('retry-after'))
          await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 5) * 1000 : 250 * 2 ** attempt * (0.5 + Math.random() / 2))
          continue
        }
        return { status: r.status, body: await readBody(r) }
      } catch (e) {
        last = e
        if (attempt < 2) await sleep(250 * 2 ** attempt * (0.5 + Math.random() / 2))
      }
    }
    throw new VordiumError('unreachable', `The node at ${url} did not answer.`, String((last as Error)?.message ?? last))
  },
  async post(url, body, timeoutMs) {
    const r = await fetchWithTimeout(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, timeoutMs)
    return { status: r.status, body: await readBody(r), retryAfter: r.headers.get('retry-after') }
  },
}

/**
 * JSON.parse that keeps whole numbers past 2^53 exact: they come back as their digit strings (a size or a price in base
 * units can be larger than a JavaScript number holds). Every other value is parsed as usual.
 */
export function parseExactJson(text: string): unknown {
  // Quote every bare integer literal of 16+ digits outside strings, then parse.
  let out = ''
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      out += c
      if (c === '\\') { out += text[++i] ?? ''; continue }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; out += c; continue }
    if ((c === '-' || (c >= '0' && c <= '9')) && /[\s,:[]/.test(out.trimEnd().slice(-1) || '[')) {
      let j = i + 1
      while (j < text.length && /[0-9.eE+-]/.test(text[j])) j++
      const lit = text.slice(i, j)
      out += /^-?\d{16,}$/.test(lit) && !Number.isSafeInteger(Number(lit)) ? `"${lit}"` : lit
      i = j - 1
      continue
    }
    out += c
  }
  return JSON.parse(out)
}

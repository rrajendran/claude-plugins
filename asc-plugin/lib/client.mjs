import crypto from 'node:crypto';
import fs from 'node:fs';
import { sleep, UserError } from './util.mjs';

const BASE = process.env.ASC_API_BASE ?? 'https://api.appstoreconnect.apple.com';
const TOKEN_TTL = 15 * 60; // Apple allows at most 20 minutes

export class AscError extends Error {
  constructor(status, errors, method, url) {
    const detail = errors.length
      ? errors.map((e) => `${e.code ?? e.status}: ${e.title ?? ''}${e.detail ? ` — ${e.detail}` : ''}${e.source?.pointer ? ` (${e.source.pointer})` : e.source?.parameter ? ` (param ${e.source.parameter})` : ''}`).join('\n  ')
      : 'no error body';
    super(`${method} ${url.replace(BASE, '')} → HTTP ${status}\n  ${detail}`);
    this.status = status;
    this.errors = errors;
  }
}

const b64u = (x) => Buffer.from(x).toString('base64url');

export class AscClient {
  constructor({ keyId, issuerId, keyPath, verbose = false }) {
    this.keyId = keyId;
    this.issuerId = issuerId;
    this.keyPath = keyPath;
    this.verbose = verbose;
    this._tok = null;
    this._exp = 0;
  }

  /** ES256 JWT (cached until 60s before expiry). */
  token() {
    const now = Math.floor(Date.now() / 1000);
    if (this._tok && this._exp - now > 60) return this._tok;
    const header = { alg: 'ES256', kid: this.keyId, typ: 'JWT' };
    const claims = { iss: this.issuerId, iat: now, exp: now + TOKEN_TTL, aud: 'appstoreconnect-v1' };
    const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
    let sig;
    try {
      sig = crypto.sign('sha256', Buffer.from(input), { key: fs.readFileSync(this.keyPath), dsaEncoding: 'ieee-p1363' });
    } catch (e) {
      throw new UserError(`Could not sign JWT with ${this.keyPath}: ${e.message}`);
    }
    this._tok = `${input}.${b64u(sig)}`;
    this._exp = claims.exp;
    return this._tok;
  }

  url(pathOrUrl, query) {
    const u = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null) continue;
      u.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    return u.toString();
  }

  /** Low-level request. Retries on 429/5xx. Returns parsed JSON, or null for 204. */
  async request(method, pathOrUrl, { query, body, retries = 4 } = {}) {
    const url = this.url(pathOrUrl, query);
    for (let attempt = 0; ; attempt++) {
      if (this.verbose) console.error(`> ${method} ${url.replace(BASE, '')}${body ? ' ' + JSON.stringify(body) : ''}`);
      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${this.token()}`, ...(body && { 'Content-Type': 'application/json' }) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const wait = Number(res.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt;
        await sleep(wait);
        continue;
      }
      const text = await res.text();
      let json = null;
      if (text) {
        try { json = JSON.parse(text); } catch { /* non-JSON body */ }
      }
      if (!res.ok) throw new AscError(res.status, json?.errors ?? [], method, url);
      return json;
    }
  }

  get(path, query) { return this.request('GET', path, { query }); }
  post(path, body) { return this.request('POST', path, { body }); }
  patch(path, body) { return this.request('PATCH', path, { body }); }
  del(path, body) { return this.request('DELETE', path, { body }); }

  /** GET that tolerates 404 (returns null) — for optional singleton resources. */
  async getOptional(path, query) {
    try {
      return await this.get(path, query);
    } catch (e) {
      if (e instanceof AscError && e.status === 404) return null;
      throw e;
    }
  }

  /** Follow links.next until exhausted or `max` items collected. Returns { data, included }. */
  async list(path, query = {}, { max = Infinity } = {}) {
    const data = [];
    const included = [];
    let next = this.url(path, { limit: 200, ...query });
    while (next && data.length < max) {
      const page = await this.request('GET', next);
      data.push(...(page.data ?? []));
      included.push(...(page.included ?? []));
      next = page.links?.next;
    }
    return { data: data.slice(0, max), included };
  }
}

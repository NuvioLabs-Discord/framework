import https from 'node:https';
import { DiscordHttpError } from './errors.js';
import { normalizeBody, routeKey, sleep } from './util.js';

const API = 'https://discord.com/api/v10';

/**
 * REST client for Discord's JSON API. Requests are serialized per Discord
 * bucket and automatically wait on global and route rate limits.
 */
export class RestClient {
  constructor({ token, apiBase = API, userAgent = 'nuvio-labs/0.1.0', timeout = 30_000 } = {}) {
    if (!token) throw new TypeError('A bot token is required');
    this.token = token;
    this.apiBase = apiBase.replace(/\/$/, '');
    this.userAgent = userAgent;
    this.timeout = timeout;
    /** @type {Map<string, Promise<any>>} */
    this.queues = new Map();
    /** @type {Map<string, {bucketId?: string, resetAt?: number, remaining?: number}>} */
    this.routes = new Map();
    this.buckets = new Map();
    this.globalWait = Promise.resolve();
  }

  get(path, options) { return this.request('GET', path, options); }
  post(path, body, options = {}) { return this.request('POST', path, { ...options, body }); }
  put(path, body, options = {}) { return this.request('PUT', path, { ...options, body }); }
  patch(path, body, options = {}) { return this.request('PATCH', path, { ...options, body }); }
  delete(path, options) { return this.request('DELETE', path, options); }

  request(method, path, { body, query, headers = {}, retries = 3, signal, timeout = this.timeout } = {}) {
    const url = new URL(path, `${this.apiBase}/`);
    if (query) for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
      else url.searchParams.set(key, String(value));
    }
    const route = routeKey(method, url.pathname);
    const bucketId = this.routes.get(route)?.bucketId;
    const queueKeys = [route, ...(bucketId ? [`bucket:${bucketId}`] : [])];
    const previous = Promise.all(queueKeys.map(key => this.queues.get(key) || Promise.resolve()));
    const job = previous.then(() => this._request(method, url, body, headers, retries, signal, timeout, route));
    const queued = job.finally(() => {
      for (const key of queueKeys) if (this.queues.get(key) === queued) this.queues.delete(key);
    });
    for (const key of queueKeys) this.queues.set(key, queued);
    return job;
  }

  async _request(method, url, body, headers, retries, signal, timeout, route) {
    await this.globalWait;
    const state = this.routes.get(route);
    const bucket = state?.bucketId ? this.buckets.get(state.bucketId) : state;
    if (bucket?.resetAt > Date.now()) await sleep(bucket.resetAt - Date.now(), signal);
    const serialized = normalizeBody(body);
    const result = await this._raw(method, url, serialized, headers, signal, timeout);
    this._updateBucket(route, result.headers);
    if (result.status === 429) {
      const wait = Math.max(0, Number(result.json?.retry_after ?? result.headers['retry-after'] ?? 1) * 1000);
      if (result.json?.global) {
        this.globalWait = sleep(wait).finally(() => { this.globalWait = Promise.resolve(); });
      }
      if (retries > 0) {
        await sleep(wait, signal);
        return this._request(method, url, body, headers, retries - 1, signal, timeout, route);
      }
    }
    if (result.status < 200 || result.status >= 300) {
      throw new DiscordHttpError(`Discord REST request failed: ${method} ${url.pathname} (${result.status})`, {
        status: result.status, method, path: url.pathname, body: result.json ?? result.text, details: result.json,
        retryAfter: result.status === 429 ? Number(result.json?.retry_after ?? result.headers['retry-after']) : undefined,
      });
    }
    return (result.json ?? result.text) || null;
  }

  _updateBucket(route, headers) {
    const bucketId = headers['x-ratelimit-bucket'];
    const state = (bucketId && this.buckets.get(bucketId)) || this.routes.get(route) || {};
    if (bucketId) state.bucketId = bucketId;
    const remaining = Number(headers['x-ratelimit-remaining']);
    const resetAfter = Number(headers['x-ratelimit-reset-after']);
    if (Number.isFinite(remaining)) state.remaining = remaining;
    if (Number.isFinite(resetAfter) && (!Number.isFinite(remaining) || remaining <= 0)) state.resetAt = Date.now() + resetAfter * 1000;
    else if (Number.isFinite(remaining) && remaining > 0) state.resetAt = 0;
    this.routes.set(route, state);
    if (bucketId) this.buckets.set(bucketId, state);
  }

  _raw(method, url, body, headers, signal, timeout) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => { if (!settled) { settled = true; callback(value); } };
      const request = https.request(url, {
        method,
        signal,
        headers: {
          Authorization: `Bot ${this.token}`,
          Accept: 'application/json',
          'User-Agent': this.userAgent,
          ...(body !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
          ...headers,
        },
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON response */ }
          finish(resolve, { status: response.statusCode ?? 0, headers: response.headers, text, json });
        });
      });
      request.setTimeout(timeout, () => request.destroy(new Error('Discord REST request timed out')));
      request.on('error', error => finish(reject, error));
      if (body !== null) request.write(body);
      request.end();
    });
  }
}

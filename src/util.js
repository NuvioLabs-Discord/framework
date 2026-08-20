export function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('The operation was aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, Math.max(0, ms));
    const abort = () => { clearTimeout(timer); signal.removeEventListener?.('abort', abort); reject(signal.reason || new Error('The operation was aborted')); };
    const done = () => { signal?.removeEventListener?.('abort', abort); resolve(); };
    signal?.addEventListener?.('abort', abort, { once: true });
  });
}

export function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value));
}

export function routeKey(method, path) {
  return `${method.toUpperCase()} ${path.replace(/\/\d{15,20}(?=\/|$)/g, '/:id')}`;
}

export function normalizeBody(body) {
  if (body === undefined || body === null) return null;
  if (Buffer.isBuffer(body) || typeof body === 'string') return body;
  return JSON.stringify(body);
}

export function pick(obj, keys) {
  return Object.fromEntries(keys.filter(key => obj[key] !== undefined).map(key => [key, obj[key]]));
}

/** Resolve a promise with an optional timeout and AbortSignal. */
export function withTimeout(value, timeout, signal) {
  const promise = Promise.resolve(value);
  if (!(timeout > 0) && !signal) return promise;
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (callback, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(result);
    };
    const onAbort = () => finish(reject, signal.reason || new Error('The operation was aborted'));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (timeout > 0) timer = setTimeout(() => finish(reject, new Error(`Operation timed out after ${timeout}ms`)), timeout);
    promise.then(value => finish(resolve, value), error => finish(reject, error));
  });
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

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

/**
 * A deliberately small EventEmitter implementation so the framework has no
 * runtime dependencies. Listener failures are re-emitted as `error` events.
 */
export class EventEmitter {
  constructor() {
    /** @type {Map<string|symbol, Set<Function>>} */
    this.listeners = new Map();
  }

  /** @param {string|symbol} event @param {Function} listener */
  on(event, listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, set = new Set());
    set.add(listener);
    return this;
  }

  /** @param {string|symbol} event @param {Function} listener */
  once(event, listener) {
    const wrapped = (...args) => {
      this.off(event, wrapped);
      return listener(...args);
    };
    return this.on(event, wrapped);
  }

  /** @param {string|symbol} event @param {Function} listener */
  off(event, listener) {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener);
      if (!set.size) this.listeners.delete(event);
    }
    return this;
  }

  /** @param {string|symbol} event @param  {...any} args */
  emit(event, ...args) {
    const set = this.listeners.get(event);
    if (!set?.size) return false;
    for (const listener of [...set]) {
      try {
        const result = listener(...args);
        if (result?.then) result.catch(error => this.emit('error', error));
      } catch (error) {
        if (event !== 'error') this.emit('error', error);
        else queueMicrotask(() => { throw error; });
      }
    }
    return true;
  }

  /** @param {string|symbol} event */
  removeAllListeners(event) {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
    return this;
  }

  listenerCount(event) { return this.listeners.get(event)?.size ?? 0; }

  eventNames() { return [...this.listeners.keys()]; }

  listenersFor(event) { return [...(this.listeners.get(event) || [])]; }

  /** Wait for an event, optionally filtering it or cancelling it. */
  waitFor(event, { timeout = 0, signal, filter } = {}) {
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        this.off(event, listener);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      };
      const onAbort = () => { cleanup(); reject(signal.reason || new Error('The operation was aborted')); };
      const listener = (...args) => {
        try {
          if (filter && !filter(...args)) return;
          cleanup();
          resolve(args.length > 1 ? args : args[0]);
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      this.on(event, listener);
      if (signal?.aborted) return onAbort();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      if (timeout > 0) timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for event ${String(event)}`));
      }, timeout);
    });
  }

  async emitAsync(event, ...args) {
    const set = this.listeners.get(event);
    if (!set?.size) return false;
    for (const listener of [...set]) await listener(...args);
    return true;
  }
}

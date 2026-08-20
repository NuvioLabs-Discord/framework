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
}

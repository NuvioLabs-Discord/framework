/**
 * Small Map-compatible cache with optional TTL and size bounds.
 * It is intentionally generic so applications can cache their own data too.
 */
export class Cache extends Map {
  constructor({ maxSize = Infinity, ttl = 0, onEvict } = {}) {
    super();
    if (!(maxSize > 0)) throw new RangeError('maxSize must be greater than zero');
    if (ttl < 0) throw new RangeError('ttl cannot be negative');
    if (onEvict !== undefined && typeof onEvict !== 'function') throw new TypeError('onEvict must be a function');
    this.maxSize = maxSize;
    this.ttl = ttl;
    this.onEvict = onEvict;
    this.expirations = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  set(key, value) {
    if (super.has(key)) super.delete(key);
    super.set(key, value);
    if (this.ttl) this.expirations.set(key, Date.now() + this.ttl);
    else this.expirations.delete(key);
    while (this.size > this.maxSize) {
      const first = this.keys().next().value;
      this.delete(first);
    }
    return this;
  }

  get(key) {
    const expires = this.expirations.get(key);
    if (expires && expires <= Date.now()) {
      this.delete(key, 'ttl');
      this.misses++;
      return undefined;
    }
    const value = super.get(key);
    if (value === undefined) this.misses++;
    else {
      this.hits++;
      super.delete(key);
      super.set(key, value);
    }
    return value;
  }

  has(key) { return this.get(key) !== undefined; }

  delete(key, reason = 'delete') {
    this.expirations.delete(key);
    const value = super.get(key);
    const deleted = super.delete(key);
    if (deleted) this.onEvict?.(key, value, reason);
    return deleted;
  }

  clear(reason = 'clear') {
    if (this.onEvict) for (const [key, value] of this) this.onEvict(key, value, reason);
    this.expirations.clear();
    super.clear();
  }

  getOrSet(key, factory) {
    const existing = this.get(key);
    if (existing !== undefined) return Promise.resolve(existing);
    if (typeof factory !== 'function') throw new TypeError('factory must be a function');
    return Promise.resolve(factory()).then(value => { this.set(key, value); return value; });
  }

  get stats() {
    return { size: this.size, maxSize: this.maxSize, hits: this.hits, misses: this.misses,
      hitRate: this.hits + this.misses ? this.hits / (this.hits + this.misses) : 0 };
  }

  sweep() {
    const now = Date.now();
    for (const [key, expires] of this.expirations) if (expires <= now) this.delete(key);
    return this;
  }
}

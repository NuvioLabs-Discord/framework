/**
 * Small Map-compatible cache with optional TTL and size bounds.
 * It is intentionally generic so applications can cache their own data too.
 */
export class Cache extends Map {
  constructor({ maxSize = Infinity, ttl = 0 } = {}) {
    super();
    if (!(maxSize > 0)) throw new RangeError('maxSize must be greater than zero');
    if (ttl < 0) throw new RangeError('ttl cannot be negative');
    this.maxSize = maxSize;
    this.ttl = ttl;
    this.expirations = new Map();
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
      this.delete(key);
      return undefined;
    }
    const value = super.get(key);
    if (value !== undefined) {
      super.delete(key);
      super.set(key, value);
    }
    return value;
  }

  has(key) { return this.get(key) !== undefined; }

  delete(key) {
    this.expirations.delete(key);
    return super.delete(key);
  }

  clear() {
    this.expirations.clear();
    super.clear();
  }

  sweep() {
    const now = Date.now();
    for (const [key, expires] of this.expirations) if (expires <= now) this.delete(key);
    return this;
  }
}

import { EventEmitter } from './events.js';
import { PreconditionError } from './errors.js';

function commandData(definition) {
  const data = definition?.toJSON ? definition.toJSON() : definition;
  if (!data || typeof data !== 'object') throw new TypeError('A command definition must be an object or builder');
  return { ...data };
}

function named(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

/** Map-compatible command registry with aliases and execution metadata. */
export class CommandStore extends Map {
  constructor() {
    super();
    this.aliases = new Map();
  }

  register(definition, handler, options = {}) {
    if (typeof handler !== 'function') throw new TypeError('A command handler must be a function');
    const source = commandData(definition);
    const name = named(source.name, 'command name');
    const aliases = [...new Set([...(source.aliases || []), ...(options.aliases || [])])].map(alias => named(alias, 'command alias'));
    delete source.aliases;
    delete source.preconditions;
    delete source.args;
    if (this.has(name) || aliases.some(alias => this.has(alias))) throw new Error(`Command ${name} or one of its aliases is already registered`);
    const entry = {
      name,
      data: source,
      handler,
      aliases,
      args: options.args ?? definition?.args ?? [],
      preconditions: options.preconditions ?? definition?.preconditions ?? [],
      description: options.description,
    };
    super.set(name, entry);
    for (const alias of aliases) this.aliases.set(alias, name);
    return entry;
  }

  resolve(name) { return super.get(this.aliases.get(name) || name); }
  get(name) { return this.resolve(name); }
  has(name) { return Boolean(this.resolve(name)); }

  delete(name) {
    const primary = this.aliases.get(name) || name;
    const entry = super.get(primary);
    if (!entry) return false;
    for (const alias of entry.aliases) this.aliases.delete(alias);
    return super.delete(primary);
  }

  clear() {
    this.aliases.clear();
    super.clear();
  }

  list() {
    return [...super.values()].map(entry => ({ name: entry.name, aliases: [...entry.aliases], data: { ...entry.data } }));
  }

  toJSON() { return [...super.values()].map(entry => ({ ...entry.data })); }
}

/** Named precondition registry used by commands and plugins. */
export class PreconditionStore extends Map {
  register(name, check, onFailure) {
    name = named(name, 'precondition name');
    if (typeof check !== 'function') throw new TypeError('A precondition check must be a function');
    if (this.has(name)) throw new Error(`Precondition ${name} is already registered`);
    this.set(name, { name, check, onFailure });
    return this;
  }

  resolve(precondition) {
    if (typeof precondition === 'function') return { check: precondition };
    if (typeof precondition === 'string') return this.get(precondition);
    if (precondition?.check) return precondition;
    return undefined;
  }
}

export function definePrecondition(name, check, onFailure) {
  return { name: named(name, 'precondition name'), check, onFailure };
}

function tokensFrom(input) {
  if (Array.isArray(input)) return input.map(String);
  const source = String(input ?? '').trim();
  const tokens = [];
  const pattern = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s]+)/g;
  let match;
  while ((match = pattern.exec(source))) tokens.push((match[1] ?? match[2] ?? match[3]).replace(/\\([\\"'])/g, '$1'));
  return tokens;
}

function convert(value, type = 'string') {
  if (value === undefined) return undefined;
  if (typeof type === 'function') return type(value);
  switch (String(type).toLowerCase()) {
    case 'integer': case 'int': return Number.parseInt(value, 10);
    case 'number': case 'float': return Number(value);
    case 'boolean': case 'bool':
      if (['true', 'yes', '1', 'on'].includes(String(value).toLowerCase())) return true;
      if (['false', 'no', '0', 'off'].includes(String(value).toLowerCase())) return false;
      throw new TypeError(`Cannot parse ${value} as a boolean`);
    case 'json': return JSON.parse(value);
    default: return value;
  }
}

/** Parses quoted command text or typed Discord interaction options. */
export class ArgumentParser {
  tokenize(input) { return tokensFrom(input); }

  parse(input, definitions = []) {
    const tokens = tokensFrom(input);
    if (!definitions.length) return tokens;
    return Object.fromEntries(definitions.map((definition, index) => {
      const spec = typeof definition === 'string' ? { name: definition } : definition;
      return [named(spec.name, 'argument name'), convert(tokens[index], spec.type)];
    }));
  }

  parseInteraction(options = [], definitions = []) {
    const values = new Map();
    const visit = items => {
      for (const item of items || []) {
        if (item.options) visit(item.options);
        else values.set(item.name, item.value);
      }
    };
    visit(options);
    if (!definitions.length) return Object.fromEntries(values);
    return Object.fromEntries(definitions.map(definition => {
      const spec = typeof definition === 'string' ? { name: definition } : definition;
      return [named(spec.name, 'argument name'), convert(values.get(spec.name), spec.type)];
    }));
  }
}

export const parseArguments = (input, definitions) => new ArgumentParser().parse(input, definitions);

export function defineListener(event, handler, options = {}) {
  if (typeof handler !== 'function') throw new TypeError('A listener handler must be a function');
  return { event: named(event, 'listener event'), handler, ...options };
}

/** Lightweight interval/one-shot task scheduler for clients and plugins. */
export class TaskScheduler extends EventEmitter {
  constructor(owner) {
    super();
    this.owner = owner;
    this.tasks = new Map();
    this.started = false;
  }

  every(name, interval, handler, options = {}) {
    name = named(name, 'task name');
    if (!(interval > 0)) throw new RangeError('Task interval must be greater than zero');
    if (typeof handler !== 'function') throw new TypeError('A task handler must be a function');
    if (this.tasks.has(name)) throw new Error(`Task ${name} is already registered`);
    const task = { name, interval, handler, options, timer: null, running: false, runs: 0 };
    this.tasks.set(name, task);
    if (this.started) this._schedule(task);
    return this;
  }

  register(...args) { return this.every(...args); }

  once(name, delay, handler, options = {}) {
    return this.every(name, delay, handler, { ...options, once: true });
  }

  remove(name) {
    const task = this.tasks.get(name);
    if (!task) return false;
    clearInterval(task.timer);
    clearTimeout(task.timer);
    return this.tasks.delete(name);
  }

  list() { return [...this.tasks.values()].map(({ name, interval, runs, running, options }) => ({ name, interval, runs, running, options })); }

  start() {
    if (this.started) return this;
    this.started = true;
    for (const task of this.tasks.values()) this._schedule(task);
    return this;
  }

  stop() {
    this.started = false;
    for (const task of this.tasks.values()) {
      clearInterval(task.timer);
      clearTimeout(task.timer);
      task.timer = null;
    }
    return this;
  }

  async run(name) {
    const task = this.tasks.get(name);
    if (!task || task.running) return false;
    task.running = true;
    task.runs++;
    this.emit('taskStart', task);
    try {
      await task.handler(this.owner, task);
      this.emit('taskComplete', task);
    } catch (error) {
      this.emit('taskError', error, task);
      this.owner?.emit?.('error', error, { phase: 'task', task: name });
    } finally {
      task.running = false;
      if (task.options.once) this.remove(name);
    }
    return true;
  }

  _schedule(task) {
    const run = () => this.run(task.name);
    if (task.options.immediate) run();
    task.timer = setInterval(run, task.interval);
    task.timer.unref?.();
  }
}

/** Tracks named listeners and makes plugin cleanup deterministic. */
export class ListenerStore {
  constructor(owner) {
    this.owner = owner;
    this.entries = new Map();
    this.nextId = 0;
  }

  register(event, handler, { once = false, name } = {}) {
    if (typeof handler !== 'function') throw new TypeError('A listener handler must be a function');
    const id = name || `${String(event)}:${++this.nextId}`;
    if (this.entries.has(id)) throw new Error(`Listener ${id} is already registered`);
    (once ? this.owner.once : this.owner.on).call(this.owner, event, handler);
    this.entries.set(id, { id, event, handler, once });
    return () => this.remove(id);
  }

  remove(id) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.owner.off(entry.event, entry.handler);
    return this.entries.delete(id);
  }

  clear() { for (const id of [...this.entries.keys()]) this.remove(id); }
  list() { return [...this.entries.values()].map(entry => ({ ...entry })); }
}

export function assertPreconditions(preconditions, store, context) {
  return (async () => {
    for (const reference of preconditions || []) {
      const definition = store.resolve(reference);
      if (!definition) throw new PreconditionError(`Unknown precondition: ${reference}`);
      const result = await definition.check(context);
      if (!result) {
        const message = definition.onFailure ? await definition.onFailure(context) : 'You do not meet the requirements for this command.';
        throw new PreconditionError(typeof message === 'string' ? message : 'You do not meet the requirements for this command.', { response: { flags: 64 } });
      }
    }
  })();
}

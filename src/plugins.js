function normalizePlugin(plugin) {
  if (typeof plugin === 'function') {
    return { name: plugin.pluginName || plugin.name, setup: plugin };
  }
  if (!plugin || typeof plugin !== 'object') throw new TypeError('A plugin must be a function or plugin object');
  return plugin;
}

function validatePlugin(plugin) {
  if (typeof plugin.name !== 'string' || !plugin.name.trim()) {
    throw new TypeError('A plugin must have a non-empty name');
  }
  if (typeof plugin.setup !== 'function' && typeof plugin.install !== 'function') {
    throw new TypeError(`Plugin ${plugin.name} must define setup(context) or install(context)`);
  }
}

/**
 * Creates a plugin definition and validates its public shape.
 *
 * @param {{name: string, setup?: Function, install?: Function, onReady?: Function, dispose?: Function}} plugin
 */
export function definePlugin(plugin) {
  const normalized = normalizePlugin(plugin);
  validatePlugin(normalized);
  return normalized;
}

/** Manages plugin registration and lifecycle for one Client instance. */
export class PluginManager {
  constructor(client) {
    this.client = client;
    this.entries = [];
    this.initialized = false;
  }

  /**
   * Register a plugin. Plugins registered before login are initialized in
   * registration order once REST and Gateway clients exist.
   */
  use(plugin, options = {}) {
    const definition = definePlugin(plugin);
    if (this.entries.some(entry => entry.plugin.name === definition.name)) {
      throw new Error(`Plugin ${definition.name} is already registered`);
    }
    const entry = { plugin: definition, options, cleanups: [], initialized: false };
    this.entries.push(entry);
    if (this.initialized) {
      this._initialize(entry).catch(error => this.client.emit('error', error, definition));
    }
    return this.client;
  }

  has(name) { return this.entries.some(entry => entry.plugin.name === name); }
  list() { return this.entries.map(entry => entry.plugin.name); }

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    for (const entry of this.entries) await this._initialize(entry);
  }

  async _initialize(entry) {
    if (entry.initialized) return;
    const context = this._context(entry);
    const setup = entry.plugin.setup || entry.plugin.install;
    const cleanup = await setup(context, entry.options);
    if (typeof cleanup === 'function') entry.cleanups.push(cleanup);
    else if (typeof cleanup?.dispose === 'function') entry.cleanups.push(() => cleanup.dispose());
    entry.initialized = true;
    this.client.emit('pluginLoaded', entry.plugin.name, entry.options);
  }

  async ready(data) {
    for (const entry of this.entries) {
      if (entry.initialized && typeof entry.plugin.onReady === 'function') {
        await entry.plugin.onReady(this._context(entry), data);
      }
    }
  }

  async unuse(name) {
    const index = this.entries.findIndex(entry => entry.plugin.name === name);
    if (index === -1) return false;
    const [entry] = this.entries.splice(index, 1);
    await this._dispose(entry);
    return true;
  }

  async shutdown() {
    for (const entry of [...this.entries].reverse()) await this._dispose(entry);
    this.initialized = false;
  }

  async _dispose(entry) {
    if (!entry.initialized) return;
    const context = this._context(entry);
    for (const cleanup of entry.cleanups.splice(0).reverse()) await cleanup();
    if (typeof entry.plugin.dispose === 'function') await entry.plugin.dispose(context);
    entry.initialized = false;
    this.client.emit('pluginUnloaded', entry.plugin.name);
  }

  _context(entry) {
    const client = this.client;
    return {
      client,
      rest: client.rest,
      gateway: client.gateway,
      router: client.router,
      options: entry.options,
      logger: client.logger || console,
      cache: client.cache,
      events: client,
      emit: (...args) => client.emit(...args),
      on(event, listener) {
        client.on(event, listener);
        return () => client.off(event, listener);
      },
      command: (definition, handler) => client.command(definition, handler),
      component: (pattern, handler) => client.component(pattern, handler),
      modal: (pattern, handler) => client.modal(pattern, handler),
      autocomplete: (name, handler) => client.autocomplete(name, handler),
      middleware: handler => client.middleware(handler),
      addCleanup(cleanup) {
        if (typeof cleanup !== 'function') throw new TypeError('addCleanup requires a function');
        entry.cleanups.push(cleanup);
        return cleanup;
      },
    };
  }
}

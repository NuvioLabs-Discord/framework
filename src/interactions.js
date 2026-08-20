import { EventEmitter } from './events.js';
import { response } from './builders.js';
import { ArgumentParser, assertPreconditions } from './framework.js';
import { PreconditionError } from './errors.js';

function messagePayload(payload) {
  return typeof payload === 'string' ? { content: payload } : (payload ?? {});
}

export class InteractionContext {
  constructor(client, data) {
    this.client = client;
    Object.assign(this, data);
    this.acknowledged = false;
    this.receivedAt = Date.now();
    this.expiresAt = this.receivedAt + 15 * 60 * 1000;
  }

  get isCommand() { return this.type === 2; }
  get isComponent() { return this.type === 3; }
  get isAutocomplete() { return this.type === 4; }
  get isModalSubmit() { return this.type === 5; }
  get commandName() { return this.data?.name; }
  get customId() { return this.data?.custom_id; }
  get options() { return this.data?.options ?? []; }
  get actor() { return this.member?.user ?? this.user ?? this.author; }
  get guildId() { return this.guild_id ?? this.guild?.id; }
  get channelId() { return this.channel_id ?? this.channel?.id; }
  get memberPermissions() { return this.member?.permissions ?? this.permissions; }
  get subcommandName() { return this.options.find(option => option.type === 1)?.name; }
  get subcommandGroupName() { return this.options.find(option => option.type === 2)?.name; }
  get isAcknowledged() { return this.acknowledged; }
  get isExpired() { return Date.now() >= this.expiresAt; }
  get permissions() { return this.memberPermissions ? BigInt(this.memberPermissions) : 0n; }

  _callback(payload) {
    if (this.isExpired) throw new Error('This interaction token has expired');
    this.acknowledged = true;
    return this.client.rest.post(`/interactions/${this.id}/${this.token}/callback`, payload);
  }

  async reply(payload) {
    if (this.acknowledged) return this.editReply(payload?.type ? payload.data : payload);
    if (payload?.type) return this._callback(payload);
    return this._callback({ type: 4, data: messagePayload(payload) });
  }
  async defer(ephemeral = false) { return this.reply(response.defer(ephemeral)); }
  async respond(payload) { return this.reply(payload); }
  async deferUpdate() { return this.reply(response.deferUpdate()); }
  async update(payload, options = {}) { return this.reply(response.update(messagePayload(payload), options)); }
  async showModal(customId, title, components) { return this.reply(response.modal(customId, title, components)); }
  async autocomplete(choices) { return this.reply(response.autocomplete(choices)); }
  async editReply(payload) {
    return this.client.rest.patch(`/webhooks/${this.client.applicationId}/${this.token}/messages/@original`, messagePayload(payload));
  }
  async fetchReply() {
    return this.client.rest.get(`/webhooks/${this.client.applicationId}/${this.token}/messages/@original`);
  }
  async deleteReply() { return this.client.rest.delete(`/webhooks/${this.client.applicationId}/${this.token}/messages/@original`); }
  async followUp(payload, options = {}) {
    return this.client.rest.post(`/webhooks/${this.client.applicationId}/${this.token}`, { ...messagePayload(payload), ...options });
  }
  async editFollowUp(messageId, payload) {
    return this.client.rest.patch(`/webhooks/${this.client.applicationId}/${this.token}/messages/${messageId}`, messagePayload(payload));
  }
  async deleteFollowUp(messageId) { return this.client.rest.delete(`/webhooks/${this.client.applicationId}/${this.token}/messages/${messageId}`); }

  option(name, fallback) {
    const search = options => {
      for (const item of options) {
        if (item.name === name) return item.value;
        const nested = search(item.options ?? []);
        if (nested !== undefined) return nested;
      }
      return undefined;
    };
    const value = search(this.options);
    return value === undefined ? fallback : value;
  }

  optionsObject(options = this.options) {
    return Object.fromEntries(options.map(item => [item.name, item.options ? this.optionsObject(item.options) : item.value]));
  }

  getString(name, fallback) { return this.option(name, fallback); }
  getInteger(name, fallback) { return this.option(name, fallback); }
  getNumber(name, fallback) { return this.option(name, fallback); }
  getBoolean(name, fallback) { return this.option(name, fallback); }
  getUser(name, fallback) { return this.option(name, fallback); }
  getRole(name, fallback) { return this.option(name, fallback); }
  getChannel(name, fallback) { return this.option(name, fallback); }
  getMentionable(name, fallback) { return this.option(name, fallback); }
  getAttachment(name, fallback) { return this.option(name, fallback); }
}

export class InteractionRouter extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.commands = new Map();
    this.components = [];
    this.modals = [];
    this.autocomplete = new Map();
    this.commandMeta = new Map();
    this.middlewares = [];
    this.argumentParser = new ArgumentParser();
  }

  use(middleware) {
    if (typeof middleware !== 'function') throw new TypeError('interaction middleware must be a function');
    this.middlewares.push(middleware);
    return this;
  }
  removeMiddleware(middleware) { const index = this.middlewares.indexOf(middleware); return index < 0 ? false : (this.middlewares.splice(index, 1), true); }
  command(name, handler, options = {}) {
    const entry = { ...options, name, handler, aliases: options.aliases || [] };
    this.commands.set(name, handler);
    for (const alias of entry.aliases) this.commands.set(alias, handler);
    this.commandMeta.set(name, entry);
    for (const alias of entry.aliases) this.commandMeta.set(alias, entry);
    return this;
  }
  removeCommand(name) {
    const meta = this.commandMeta?.get(name);
    if (meta) for (const alias of [meta.name, ...(meta.aliases || [])]) { this.commands.delete(alias); this.commandMeta.delete(alias); }
    else this.commands.delete(name);
    return Boolean(meta || !this.commands.has(name));
  }
  component(pattern, handler) { this.components.push({ pattern, handler }); return this; }
  removeComponent(pattern, handler) { const index = this.components.findIndex(item => item.pattern === pattern && item.handler === handler); return index < 0 ? false : (this.components.splice(index, 1), true); }
  modal(pattern, handler) { this.modals.push({ pattern, handler }); return this; }
  removeModal(pattern, handler) { const index = this.modals.findIndex(item => item.pattern === pattern && item.handler === handler); return index < 0 ? false : (this.modals.splice(index, 1), true); }
  guard(pattern, handler) { return this.component(pattern, handler); }
  onAutocomplete(name, handler) { this.autocomplete.set(name, handler); return this; }
  removeAutocomplete(name) { return this.autocomplete.delete(name); }

  async handle(data) {
    const context = new InteractionContext(this.client, data);
    try {
      if (data.type === 2) {
        const name = data.data?.name;
        const meta = this.commandMeta.get(name);
        if (meta?.args?.length) context.arguments = this.argumentParser.parseInteraction(context.options, meta.args);
        await this._run(this.commands.get(name), context, name, meta);
      }
      else if (data.type === 4) await this._run(this.autocomplete.get(data.data?.name), context, data.data?.name);
      else if (data.type === 3) await this._match(this.components, data.data?.custom_id, context);
      else if (data.type === 5) await this._match(this.modals, data.data?.custom_id, context);
      this.emit('interaction', context);
    } catch (error) {
      this.emit('error', error, context);
      const failure = error instanceof PreconditionError
        ? { content: error.message, ...(error.response || {}) }
        : { content: 'Something went wrong while handling this interaction.', flags: 64 };
      if (!context.acknowledged && !context.isAutocomplete) await context.reply(failure).catch(() => {});
      else if (!context.acknowledged) await context.autocomplete([]).catch(() => {});
    }
    return context;
  }

  async _run(handler, context, name, meta = {}) {
    await assertPreconditions(meta.preconditions, this.client.preconditions, context);
    let index = -1;
    const dispatch = async current => {
      if (current <= index) throw new Error('next() called multiple times');
      index = current;
      const middleware = this.middlewares[current];
      if (middleware) return middleware(context, () => dispatch(current + 1));
      if (handler) await handler(context);
    };
    await dispatch(0);
    if (handler) this.emit('handled', name, context);
  }

  async _match(handlers, value, context) {
    for (const item of handlers) {
      let matched;
      if (Array.isArray(item.pattern)) matched = item.pattern.includes(value);
      else if (typeof item.pattern === 'string') matched = item.pattern === value;
      else if (item.pattern instanceof RegExp) { item.pattern.lastIndex = 0; matched = item.pattern.test(value); }
      else if (typeof item.pattern === 'function') matched = await item.pattern(value, context);
      if (matched) { await this._run(item.handler, context, value); return; }
    }
  }
}

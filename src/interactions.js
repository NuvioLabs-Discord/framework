import { EventEmitter } from './events.js';
import { response } from './builders.js';

function messagePayload(payload) {
  return typeof payload === 'string' ? { content: payload } : (payload ?? {});
}

export class InteractionContext {
  constructor(client, data) {
    this.client = client;
    Object.assign(this, data);
    this.acknowledged = false;
    this.receivedAt = Date.now();
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

  _callback(payload) {
    this.acknowledged = true;
    return this.client.rest.post(`/interactions/${this.id}/${this.token}/callback`, payload);
  }

  async reply(payload) {
    if (this.acknowledged) return this.editReply(payload?.type ? payload.data : payload);
    if (payload?.type) return this._callback(payload);
    return this._callback({ type: 4, data: messagePayload(payload) });
  }
  async defer(ephemeral = false) { return this.reply(response.defer(ephemeral)); }
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
}

export class InteractionRouter extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.commands = new Map();
    this.components = [];
    this.modals = [];
    this.autocomplete = new Map();
    this.middlewares = [];
  }

  use(middleware) {
    if (typeof middleware !== 'function') throw new TypeError('interaction middleware must be a function');
    this.middlewares.push(middleware);
    return this;
  }
  command(name, handler) { this.commands.set(name, handler); return this; }
  removeCommand(name) { return this.commands.delete(name); }
  component(pattern, handler) { this.components.push({ pattern, handler }); return this; }
  modal(pattern, handler) { this.modals.push({ pattern, handler }); return this; }
  onAutocomplete(name, handler) { this.autocomplete.set(name, handler); return this; }

  async handle(data) {
    const context = new InteractionContext(this.client, data);
    try {
      if (data.type === 2) await this._run(this.commands.get(data.data?.name), context, data.data?.name);
      else if (data.type === 4) await this._run(this.autocomplete.get(data.data?.name), context, data.data?.name);
      else if (data.type === 3) await this._match(this.components, data.data?.custom_id, context);
      else if (data.type === 5) await this._match(this.modals, data.data?.custom_id, context);
      this.emit('interaction', context);
    } catch (error) {
      this.emit('error', error, context);
      if (!context.acknowledged && !context.isAutocomplete) await context.reply({ content: 'Something went wrong while handling this interaction.', flags: 64 }).catch(() => {});
      else if (!context.acknowledged) await context.autocomplete([]).catch(() => {});
    }
    return context;
  }

  async _run(handler, context, name) {
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
      if (typeof item.pattern === 'string') matched = item.pattern === value;
      else if (item.pattern instanceof RegExp) { item.pattern.lastIndex = 0; matched = item.pattern.test(value); }
      else if (typeof item.pattern === 'function') matched = await item.pattern(value, context);
      if (matched) { await this._run(item.handler, context, value); return; }
    }
  }
}

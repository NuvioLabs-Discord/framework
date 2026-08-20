import { EventEmitter } from './events.js';
import { Gateway } from './gateway.js';
import { RestClient } from './rest.js';
import { InteractionRouter } from './interactions.js';
import { PluginManager } from './plugins.js';
import { Cache } from './cache.js';
import { UpdateManager } from './updater.js';
import { CommandStore, PreconditionStore, TaskScheduler, ListenerStore } from './framework.js';

/**
 * High-level Discord bot client.
 *
 * @example
 * const client = new Client({ intents: Intents.Guilds });
 * client.command(command('ping', 'Ping the bot'), ctx => ctx.reply('pong'));
 * await client.login(process.env.DISCORD_TOKEN);
 */
export class Client extends EventEmitter {
  constructor({ token, intents = 0, apiBase, gatewayUrl, applicationId, autoSyncCommands = false, properties, logger, cache = true, cacheSize = 1_000, updates = false, rest: restOptions = {}, gateway: gatewayOptions = {}, presence } = {}) {
    super();
    this.token = token;
    this.intents = intents;
    this.gatewayUrl = gatewayUrl;
    this.apiBase = apiBase;
    this.applicationId = applicationId;
    this.autoSyncCommands = autoSyncCommands;
    this.properties = properties;
    this.presence = presence;
    this.restOptions = restOptions;
    this.gatewayOptions = gatewayOptions;
    this.logger = logger || console;
    const updateOptions = updates === true ? {} : updates && typeof updates === 'object' && updates.enabled !== false ? { ...updates } : null;
    if (updateOptions) delete updateOptions.enabled;
    this.updates = updateOptions ? new UpdateManager(this, updateOptions) : null;
    this.commands = new CommandStore();
    this.commandStore = this.commands;
    this.preconditions = new PreconditionStore();
    this.tasks = new TaskScheduler(this);
    this.listenerStore = new ListenerStore(this);
    this.router = new InteractionRouter(this);
    this.plugins = new PluginManager(this);
    this.cache = cache === false ? null : {
      guilds: new Cache({ maxSize: cache?.guilds?.maxSize ?? cacheSize, ttl: cache?.guilds?.ttl ?? 0 }),
      channels: new Cache({ maxSize: cache?.channels?.maxSize ?? cacheSize, ttl: cache?.channels?.ttl ?? 0 }),
      users: new Cache({ maxSize: cache?.users?.maxSize ?? cacheSize, ttl: cache?.users?.ttl ?? 0 }),
    };
    this.readyState = false;
    this.startedAt = null;
    this.readyAt = null;
    this._cacheSweepTimer = null;
    this.router.on('error', (error, context) => this.emit('error', error, context));
    this.router.on('interaction', context => this.emit('interaction', context));
  }

  /** Register a command and its handler. */
  command(definition, handler, options = {}) {
    const entry = this.commands.register(definition, handler, options);
    this.router.command(entry.name, handler, entry);
    return this;
  }

  removeCommand(name) { this.commands.delete(name); this.router.removeCommand(name); return this; }
  clearCommands() { for (const name of this.commands.keys()) this.router.removeCommand(name); this.commands.clear(); return this; }
  component(pattern, handler) { this.router.component(pattern, handler); return this; }
  modal(pattern, handler) { this.router.modal(pattern, handler); return this; }
  autocomplete(name, handler) { this.router.onAutocomplete(name, handler); return this; }
  middleware(handler) { this.router.use(handler); return this; }
  precondition(name, check, onFailure) { this.preconditions.register(name, check, onFailure); return this; }
  task(name, interval, handler, options = {}) { this.tasks.every(name, interval, handler, options); return this; }
  listen(event, handler, options = {}) {
    if (event && typeof event === 'object') return this.listen(event.event, event.handler, event);
    this.listenerStore.register(event, handler, options);
    return this;
  }
  commandList() { return this.commands.list(); }
  use(plugin, options = {}) { return this.plugins.use(plugin, options); }
  unuse(name) { return this.plugins.unuse(name); }

  get isReady() { return this.readyState; }
  get uptime() { return this.startedAt ? Date.now() - this.startedAt : 0; }
  get latency() { return this.gateway?.latency ?? null; }

  health() {
    return { ready: this.readyState, connected: Boolean(this.gateway?.isConnected), uptime: this.uptime,
      latency: this.latency, userId: this.user?.id, guilds: this.cache?.guilds.size ?? 0 };
  }

  async login(token = this.token) {
    if (this.readyState) return this.user;
    if (!token) throw new TypeError('A Discord bot token is required');
    this.token = token;
    this.startedAt ||= Date.now();
    this.rest = new RestClient({ token, apiBase: this.apiBase, logger: this.logger, ...this.restOptions });
    const user = await this.rest.get('/users/@me');
    this.user = user;
    this.applicationId ||= user.id;
    let gatewayUrl = this.gatewayUrl;
    if (!gatewayUrl) gatewayUrl = (await this.rest.get('/gateway/bot')).url;
    this.gateway = new Gateway({ token, intents: this.intents, gatewayUrl, properties: this.properties, logger: this.logger, ...this.gatewayOptions });
    this._wireGateway();
    await this.plugins.initialize();
    const readyData = await new Promise((resolve, reject) => {
      const onReady = data => { cleanup(); resolve(data); };
      const onError = error => { cleanup(); reject(error); };
      const cleanup = () => { this.off('ready', onReady); this.off('error', onError); };
      this.once('ready', onReady);
      this.once('error', onError);
      this.gateway.connect().catch(onError);
    });
    this.readyState = true;
    this.readyAt = Date.now();
    this._startCacheSweep();
    if (this.presence) this.setPresence(this.presence);
    await this.plugins.ready(readyData);
    if (this.autoSyncCommands) await this.syncCommands();
    this.tasks.start();
    this.updates?.start();
    return this.user;
  }

  _wireGateway() {
    this.gateway.on('error', error => this.emit('error', error));
    this.gateway.on('connected', () => this.emit('gatewayConnected'));
    this.gateway.on('disconnected', code => this.emit('gatewayDisconnected', code));
    this.gateway.on('dispatch', (type, data) => {
      if (type === 'READY') {
        this.applicationId ||= data.application?.id ?? data.user?.id;
        this.user ||= data.user;
        this.readyState = true;
      }
      this._cacheDispatch(type, data);
      if (type === 'INTERACTION_CREATE') this.router.handle(data).catch(error => this.emit('error', error));
      this.emit(type, data);
      this.emit(type.toLowerCase(), data);
    });
  }

  _cacheDispatch(type, data) {
    if (!this.cache || !data) return;
    if (type === 'READY' && data.user?.id) this.cache.users.set(data.user.id, data.user);
    else if (type === 'GUILD_CREATE' && data.id) {
      this.cache.guilds.set(data.id, data);
      for (const channel of data.channels || []) if (channel.id) this.cache.channels.set(channel.id, channel);
      for (const member of data.members || []) if (member.user?.id) this.cache.users.set(member.user.id, member.user);
    } else if (type === 'GUILD_UPDATE' && data.id) this.cache.guilds.set(data.id, data);
    else if (type === 'GUILD_DELETE' && data.id) this.cache.guilds.delete(data.id);
    else if (['CHANNEL_CREATE', 'CHANNEL_UPDATE'].includes(type) && data.id) this.cache.channels.set(data.id, data);
    else if (type === 'CHANNEL_DELETE' && data.id) this.cache.channels.delete(data.id);
    else if (type === 'USER_UPDATE' && data.id) this.cache.users.set(data.id, data);
  }

  async syncCommands(guildId, { dryRun = false } = {}) {
    if (!this.applicationId) throw new Error('applicationId is not known yet');
    if (!this.rest) throw new Error('Client is not logged in');
    const body = [...this.commands.values()].map(command => command.data);
    const path = guildId ? `/applications/${this.applicationId}/guilds/${guildId}/commands` : `/applications/${this.applicationId}/commands`;
    return dryRun ? body : this.rest.put(path, body);
  }

  async fetchUser(userId) {
    if (!this.rest) throw new Error('Client is not logged in');
    const user = await this.rest.get(`/users/${userId}`);
    this.cache?.users.set(user.id, user);
    return user;
  }

  async fetchGuild(guildId) {
    if (!this.rest) throw new Error('Client is not logged in');
    const guild = await this.rest.get(`/guilds/${guildId}`);
    this.cache?.guilds.set(guild.id, guild);
    return guild;
  }

  async fetchChannel(channelId) {
    if (!this.rest) throw new Error('Client is not logged in');
    const channel = await this.rest.get(`/channels/${channelId}`);
    this.cache?.channels.set(channel.id, channel);
    return channel;
  }

  async fetchApplicationCommands(guildId) {
    if (!this.applicationId) throw new Error('applicationId is not known yet');
    if (!this.rest) throw new Error('Client is not logged in');
    const path = guildId ? `/applications/${this.applicationId}/guilds/${guildId}/commands` : `/applications/${this.applicationId}/commands`;
    return this.rest.get(path);
  }

  /** Send a raw Gateway presence update. */
  setPresence(presence) { this.presence = presence; this.gateway?.identifyPresence(presence); return this; }

  _startCacheSweep() {
    clearInterval(this._cacheSweepTimer);
    if (!this.cache) return;
    const hasTtl = Object.values(this.cache).some(value => value.ttl > 0);
    if (!hasTtl) return;
    this._cacheSweepTimer = setInterval(() => Object.values(this.cache).forEach(value => value.sweep()), 60_000);
    this._cacheSweepTimer.unref?.();
  }

  disconnect() {
    this.readyState = false;
    this.updates?.stop();
    this.tasks.stop();
    clearInterval(this._cacheSweepTimer);
    this._cacheSweepTimer = null;
    this.plugins.shutdown().catch(error => this.emit('error', error));
    this.gateway?.disconnect();
    return this;
  }
  async shutdown() {
    this.readyState = false;
    this.readyAt = null;
    this.updates?.stop();
    this.tasks.stop();
    clearInterval(this._cacheSweepTimer);
    this._cacheSweepTimer = null;
    await this.plugins.shutdown();
    this.gateway?.disconnect();
    this.cache?.guilds.clear();
    this.cache?.channels.clear();
    this.cache?.users.clear();
  }

  destroy() { return this.shutdown(); }
}

export const Intents = Object.freeze({
  Guilds: 1 << 0, GuildMembers: 1 << 1, GuildModeration: 1 << 2, GuildEmojisAndStickers: 1 << 3,
  GuildIntegrations: 1 << 4, GuildWebhooks: 1 << 5, GuildInvites: 1 << 6, GuildVoiceStates: 1 << 7,
  GuildPresences: 1 << 8, GuildMessages: 1 << 9, GuildMessageReactions: 1 << 10,
  GuildMessageTyping: 1 << 11, DirectMessages: 1 << 12, DirectMessageReactions: 1 << 13,
  DirectMessageTyping: 1 << 14, MessageContent: 1 << 15, GuildScheduledEvents: 1 << 16,
  AutoModerationConfiguration: 1 << 20, AutoModerationExecution: 1 << 21,
});

export const Events = Object.freeze({
  Ready: 'ready', InteractionCreate: 'INTERACTION_CREATE', MessageCreate: 'MESSAGE_CREATE',
  GuildCreate: 'GUILD_CREATE', Error: 'error', GatewayConnected: 'gatewayConnected',
  GatewayDisconnected: 'gatewayDisconnected', PluginLoaded: 'pluginLoaded', PluginUnloaded: 'pluginUnloaded',
  UpdateAvailable: 'updateAvailable', HotpatchFailed: 'hotpatchFailed', Hotpatched: 'hotpatched', Restarting: 'restarting',
});

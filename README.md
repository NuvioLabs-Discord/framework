# Nuvio Labs

Nuvio Labs is a **zero-runtime-dependency Discord framework for Node.js**. Version `0.2.0` combines a resilient Gateway client, bucket-aware REST client, interaction router, fluent builders, plugins, bounded caches, observability helpers, and opt-in updates in one small package.

It uses only Node.js built-ins (`net`, `tls`, `https`, `crypto`, and filesystem/process APIs for the optional updater).

> Discord still requires a bot token, an application, network access, and the appropriate intents enabled in the Developer Portal.

## Requirements

- Node.js 18 or newer
- A Discord application and bot token
- The `Guilds` intent for slash commands
- Any privileged intents enabled in the Discord Developer Portal

## Install

```sh
npm install nuvio-labs
```

## Quick start

```js
import {
  Client,
  Intents,
  command,
  embed,
} from 'nuvio-labs';

const client = new Client({
  intents: Intents.Guilds,
  autoSyncCommands: true,
  presence: {
    since: null,
    activities: [{ name: 'Nuvio Labs', type: 0 }],
    status: 'online',
    afk: false,
  },
});

client.command(
  command('ping', 'Check whether the bot is alive'),
  async ctx => {
    await ctx.reply({
      content: `Pong! Gateway latency: ${ctx.client.latency ?? 'pending'}ms`,
      embeds: [embed().title('Nuvio Labs').description('Ready for work.').color(0x5865f2)],
    });
  },
);

client.on('ready', ({ user }) => console.log(`Logged in as ${user.username}`));
client.on('error', error => console.error(error));

await client.login(process.env.DISCORD_TOKEN);
```

Keep the token outside your source code:

```sh
DISCORD_TOKEN=your-bot-token node bot.js
```

Global command synchronization can take time to appear in Discord. During development, use `await client.syncCommands(GUILD_ID)` for fast guild updates.

## Commands and interactions

Commands support nested subcommands, typed options, choices, autocomplete, permissions, localization, contexts, and integration metadata:

```js
const moderate = command('moderate', 'Moderate a member')
  .subcommand('warn', 'Warn a member', sub => sub
    .user('member', 'Member to warn', option => option.required())
    .string('reason', 'Reason', option => option.length(1, 200)))
  .defaultMemberPermissions('8192');

client.command(moderate, ctx => {
  const member = ctx.getUser('member');
  const reason = ctx.getString('reason', 'No reason supplied');
  return ctx.reply(`Warned ${member} for: ${reason}`);
});

client.component(/^confirm:/, async ctx => ctx.update('Confirmed'));
client.modal('feedback', ctx => ctx.reply('Thanks for the feedback!'));
client.autocomplete('search', ctx => ctx.autocomplete([{ name: 'Nuvio', value: 'nuvio' }]));
```

`InteractionContext` provides `reply`, `defer`, `deferUpdate`, `update`, `showModal`, `autocomplete`, `editReply`, `fetchReply`, `deleteReply`, `followUp`, and follow-up editing/deletion. It also exposes `commandName`, `customId`, `guildId`, `channelId`, `actor`, `permissions`, `optionsObject()`, typed option getters, acknowledgement state, and token expiry state.

Component helpers include `button`, `select`, `userSelect`, `roleSelect`, `mentionableSelect`, `channelSelect`, `textInput`, and `row`. `response` contains ready-to-send Discord callback payloads.

## Builders

- `CommandBuilder` and `OptionBuilder` for nested commands and typed options.
- `EmbedBuilder` / `embed()` for titles, descriptions, colors, timestamps, authors, footers, media, and up to 25 fields.
- `Permissions` BigInt constants and `permissionBits(...names)` for safe permission composition.
- `response`, button/select helpers, modal text inputs, and action rows.

Builders return fresh JSON-compatible payloads from `toJSON()` and can be mixed with plain objects where appropriate.

## Reliability and operations

### REST

`RestClient` serializes requests by Discord route and bucket, waits for global and route limits, honors abort signals and timeouts, retries 429 and transient 5xx responses with backoff, and exposes request metrics and rate-limit state:

```js
const client = new Client({
  rest: {
    timeout: 15_000,
    retries: 4,
    retryDelay: 300,
    retryOn: [429, 500, 502, 503, 504],
  },
});

console.log(client.rest?.stats);
console.log(client.rest?.getRateLimitState('/users/@me'));
```

The REST client also provides `get`, `post`, `put`, `patch`, `delete`, query serialization, custom headers, and `DiscordHttpError` details including status, method, path, response body, and retry timing.

### Gateway

The Gateway handles WebSocket framing, identify/resume, sequence tracking, heartbeat acknowledgement and latency, reconnect backoff with jitter, invalid sessions, presence, voice state updates, and guild member requests. Listen to `raw`, `heartbeat`, `gatewayConnected`, `gatewayDisconnected`, and dispatch events, or use `gateway.isConnected`, `gateway.isResuming`, and `gateway.latency` directly.

### Health and lifecycle

```js
client.on('gatewayDisconnected', code => console.warn('Gateway closed:', code));

setInterval(() => console.log(client.health()), 30_000);

await client.shutdown(); // also available as client.destroy()
```

`client.health()` reports readiness, connection state, uptime, latency, user ID, and cached guild count. `client.fetchUser`, `client.fetchGuild`, and `client.fetchChannel` populate the corresponding caches.

## Caching

The built-in `Cache` is Map-compatible and supports LRU-style access ordering, TTL expiration, size limits, eviction hooks, async `getOrSet`, `sweep()`, and hit/miss statistics:

```js
import { Cache } from 'nuvio-labs';

const cache = new Cache({ maxSize: 500, ttl: 60_000 });
const value = await cache.getOrSet('config', loadConfig);
console.log(cache.stats);
```

Client entity caches are available as `client.cache.guilds`, `client.cache.channels`, and `client.cache.users`. Pass `cache: false` to disable them, or configure `cacheSize`, per-cache `maxSize`, and TTL values.

## Plugins and middleware

Plugins can register commands, components, middleware, event listeners, and cleanup logic. Setup runs after REST and Gateway clients are created; `onReady` and disposal hooks are supported.

```js
const auditPlugin = {
  name: 'audit',
  setup({ on, logger, addCleanup }) {
    const listener = data => logger.info('Command interaction', data.data?.name);
    on('interaction', listener);
    addCleanup(() => logger.info('Audit plugin stopped'));
  },
};

client.use(auditPlugin);
client.middleware(async (ctx, next) => {
  const started = Date.now();
  await next();
  console.log(`${ctx.commandName} completed in ${Date.now() - started}ms`);
});
```

Plugins are named, initialized in registration order, disposed in reverse order, and can be dynamically removed with `await client.unuse(name)`.

## Event utilities

The dependency-free `EventEmitter` includes `on`, `once`, `off`, `waitFor`, `emitAsync`, `eventNames`, `listenersFor`, and listener counts. For example:

```js
const ready = await client.waitFor('ready', { timeout: 30_000 });
```

## Automatic updates

Updates are disabled by default. Enable them explicitly with `updates: true` or an options object. The manager checks the npm registry, can install stable releases with lifecycle scripts disabled, attempts a hotpatch, and falls back to a process restart when configured.

```js
const client = new Client({
  updates: {
    interval: 60 * 60 * 1000,
    hotpatch: true,
    restart: true,
  },
});

client.on('updateAvailable', update => console.log('Updating', update.latestVersion));
client.on('hotpatched', update => console.log('Hotpatched', update.latestVersion));
client.on('restarting', update => console.log('Restarting', update.latestVersion));
```

Because installation and process replacement are powerful operations, enable this only where automatic package changes are acceptable. A custom `hotpatch` function can return `true` to handle an update in application code. Set `restart: false` to prevent process replacement, or `install: false` when installation is managed externally.

## Public modules

- `Client`, `Intents`, and `Events`
- `Gateway`, `GatewayOpcode`, and the dependency-free `WebSocket`
- `RestClient`, `DiscordError`, `DiscordHttpError`, and `GatewayError`
- `InteractionContext` and `InteractionRouter`
- `Cache`, `EventEmitter`, `PluginManager`, and `UpdateManager`
- Command, embed, permission, response, and component builders
- Utility helpers including `sleep`, `withTimeout`, `clamp`, `pick`, and `routeKey`

## Development

```sh
npm run check
```

There are no runtime dependencies and no build step. `npm run check` validates the package entry point and imports the framework to catch export and module wiring errors.

## License

Apache-2.0

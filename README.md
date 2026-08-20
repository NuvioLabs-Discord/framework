# Nuvio Labs

Nuvio Labs is a Discord bot framework for Node.js with **zero runtime dependencies**. It uses only Node's built-in `net`, `tls`, `https`, and `crypto` modules.

The package is published as `nuvio-labs`.

> Discord still requires a bot token and network access. “Zero dependencies” means this package does not install or import third-party packages.

## Requirements

- Node.js 18 or newer
- A Discord application and bot token
- The `Guilds` intent for slash commands
- Any privileged intents enabled in the Discord Developer Portal

## Quick start

Create a bot file:

```js
import { Client, Intents, command } from 'nuvio-labs';

const client = new Client({
  intents: Intents.Guilds,
  autoSyncCommands: true,
  updates: {
    enabled: true,
    interval: 60 * 60 * 1000,
  },
});

client.command(
  command('ping', 'Check whether the bot is alive'),
  ctx => ctx.reply('Pong!'),
);

client.on('ready', ({ user }) => console.log(`Logged in as ${user.username}`));
client.on('error', error => console.error(error));

await client.login(process.env.DISCORD_TOKEN);
```

Run it with the token kept outside your source code:

```sh
DISCORD_TOKEN=your-bot-token node bot.js
```

Do not commit your token. Global command synchronization can take time to appear in Discord; use `await client.syncCommands(GUILD_ID)` for faster development updates.

## Documentation

- [Getting started](docs/getting-started.md) — create an application, invite the bot, and run your first command.
- [Commands and interactions](docs/interactions.md) — slash commands, options, buttons, select menus, modals, and autocomplete.
- [Plugins](docs/plugins.md) — package reusable bot features with setup and cleanup lifecycle hooks.
- [API reference](docs/api.md) — exported classes, helpers, events, and configuration.
- [Architecture and limits](docs/architecture.md) — internals, supported Gateway behavior, and operational notes.

## Included modules

- `Client`: high-level lifecycle, event dispatch, command registration/removal, middleware, command synchronization, presence, bounded entity caches, plugins, and shutdown.
- `Gateway`: WebSocket connection, identify/resume, sequence tracking, heartbeat, reconnect, and dispatch events.
- `RestClient`: JSON requests, Discord bucket-aware serialization, global and route rate-limit waits, abort signals, timeouts, and 429 retries.
- `InteractionRouter`: slash commands, autocomplete, buttons/select menus, and modal handlers.
- Builders: nested `command`/subcommand builders, typed options, permissions/localization metadata, `response`, button/select/modal components, and `row` helpers.
- `PluginManager`: named plugins with async setup, ready hooks, cleanup, and safe event subscriptions.
- `UpdateManager`: optional npm update checks with an in-process hotpatch attempt and process restart fallback.

## Development

```sh
npm run check
```

There are no package dependencies and no build step. Run `npm run check` for the package's syntax validation. See [`example/bot.js`](example/bot.js) for a runnable example.

## Automatic updates

Updates are disabled by default. Enable them on a logged-in bot with `updates: true` or an options object. The manager checks the npm registry, installs stable releases with lifecycle scripts disabled, attempts to hotpatch loaded framework prototypes, and restarts the bot process when the hotpatch is unavailable or unsuccessful. Update checks only run while the client is logged in.

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

Because installation and process replacement are powerful operations, only enable this for deployments where automatic package changes are acceptable. A custom `hotpatch` function may return `true` to handle an update in application code; returning `false` uses the restart fallback. Set `restart: false` to prevent process replacement, or `install: false` when installation is managed externally.

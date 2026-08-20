import https from 'node:https';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_INTERVAL = 6 * 60 * 60 * 1000;

function parseVersion(value) {
  const match = String(value || '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] };
}

/** Compare two semver-like package versions without a runtime dependency. */
export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  if (a.prerelease !== b.prerelease) return a.prerelease > b.prerelease ? 1 : -1;
  return 0;
}

export function isNewerVersion(current, latest) {
  return compareVersions(latest, current) > 0;
}

function packageEndpoint(registry, packageName) {
  const encodedName = packageName.startsWith('@')
    ? packageName.replace('/', '%2F')
    : encodeURIComponent(packageName);
  return new URL(encodedName, `${registry.replace(/\/$/, '')}/`).href;
}

function requestJson(url, timeout) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { Accept: 'application/json', 'User-Agent': `${packageJson.name}/${packageJson.version}` },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
          reject(new Error(`Package registry returned HTTP ${response.statusCode ?? 0}`));
          return;
        }
        try { resolve(JSON.parse(text)); } catch (error) { reject(new Error('Package registry returned invalid JSON', { cause: error })); }
      });
    });
    request.setTimeout(timeout, () => request.destroy(new Error('Package registry request timed out')));
    request.on('error', reject);
  });
}

/** Fetch the stable npm dist-tag for a package. */
export async function fetchLatestVersion(packageName, { registry = DEFAULT_REGISTRY, timeout = 10_000 } = {}) {
  const metadata = await requestJson(packageEndpoint(registry, packageName), timeout);
  const version = metadata?.['dist-tags']?.latest;
  if (!version || !parseVersion(version)) throw new Error(`Package registry did not return a valid latest version for ${packageName}`);
  return version;
}

function npmInvocation() {
  if (process.env.npm_execpath) return { command: process.execPath, args: [process.env.npm_execpath] };
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [] };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: options.stdio || 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Command ${command} exited with ${signal || code}`));
    });
  });
}

async function installPackage(packageName, version) {
  const npm = npmInvocation();
  await run(npm.command, [
    ...npm.args,
    'install', `${packageName}@${version}`,
    '--no-save', '--ignore-scripts', '--package-lock=false',
  ], { cwd: process.cwd() });
}

function patchPrototype(instance, constructor) {
  if (!instance || !constructor?.prototype) return false;
  Object.setPrototypeOf(instance, constructor.prototype);
  return true;
}

/**
 * Manages updates for a logged-in Client. Updates are deliberately opt-in:
 * package installation and process replacement are powerful operations.
 */
export class UpdateManager {
  constructor(client, {
    packageName = packageJson.name,
    currentVersion = packageJson.version,
    registry = DEFAULT_REGISTRY,
    interval = DEFAULT_INTERVAL,
    checkOnStart = true,
    hotpatch = true,
    restart = true,
    install = true,
    timeout = 10_000,
    fetchLatest = fetchLatestVersion,
    installPackage: installOverride,
    restartProcess: restartOverride,
  } = {}) {
    if (!client) throw new TypeError('UpdateManager requires a Client');
    if (!(interval > 0)) throw new RangeError('Update interval must be greater than zero');
    this.client = client;
    this.packageName = packageName;
    this.currentVersion = currentVersion;
    this.registry = registry;
    this.interval = interval;
    this.checkOnStart = checkOnStart;
    this.hotpatch = hotpatch;
    this.restartEnabled = restart;
    this.installEnabled = install;
    this.timeout = timeout;
    this.fetchLatest = fetchLatest;
    this.installOverride = installOverride;
    this.restartOverride = restartOverride;
    this.running = false;
    this.updating = false;
  }

  start() {
    if (this.running) return this;
    this.running = true;
    if (this.checkOnStart) this._scheduleCheck(0);
    this.timer = setInterval(() => this._scheduleCheck(0), this.interval);
    this.timer.unref?.();
    return this;
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
    return this;
  }

  _scheduleCheck(delay) {
    const timer = setTimeout(() => {
      this.check().catch(error => this._report(error, 'check'));
      timer.unref?.();
    }, delay);
    timer.unref?.();
  }

  async check() {
    if (!this.running || this.updating) return null;
    const latest = await this.fetchLatest(this.packageName, { registry: this.registry, timeout: this.timeout });
    if (!isNewerVersion(this.currentVersion, latest)) return null;
    const update = { packageName: this.packageName, currentVersion: this.currentVersion, latestVersion: latest };
    this.client.emit('updateAvailable', update);
    return this.apply(latest);
  }

  async apply(version) {
    if (this.updating) return null;
    this.updating = true;
    const update = { packageName: this.packageName, currentVersion: this.currentVersion, latestVersion: version };
    try {
      if (this.installEnabled) {
        if (typeof this.installOverride === 'function') await this.installOverride(update);
        else await installPackage(this.packageName, version);
      }

      let hotpatched = false;
      if (this.hotpatch !== false) {
        try {
          if (typeof this.hotpatch === 'function') {
            hotpatched = (await this.hotpatch({ client: this.client, ...update })) === true;
          } else {
            hotpatched = await this._hotpatchInstalledPackage(version);
          }
        } catch (error) {
          this.client.emit('hotpatchFailed', error, update);
        }
      }
      if (hotpatched) {
        this.currentVersion = version;
        this.client.emit('hotpatched', update);
        return { ...update, mode: 'hotpatch' };
      }

      if (!this.restartEnabled) throw new Error(`Package ${this.packageName} was updated but could not be hotpatched; restart is disabled`);
      this.client.emit('restarting', update);
      await this.restart(update);
      return { ...update, mode: 'restart' };
    } finally {
      this.updating = false;
    }
  }

  async _hotpatchInstalledPackage(version) {
    const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    if (compareVersions(manifest.version, version) !== 0) return false;
    const temporaryRoot = await mkdtemp(join(tmpdir(), `${packageJson.name}-hotpatch-`));
    try {
      await cp(join(PACKAGE_ROOT, 'src'), join(temporaryRoot, 'src'), { recursive: true });
      await cp(join(PACKAGE_ROOT, 'package.json'), join(temporaryRoot, 'package.json'));
      const fresh = await import(`${pathToFileURL(join(temporaryRoot, 'src/index.js')).href}?hotpatch=${Date.now()}`);
      const client = this.client;
      const instances = [
        [client, 'Client'],
        [client.router, 'InteractionRouter'],
        [client.plugins, 'PluginManager'],
        [client.rest, 'RestClient'],
        [client.gateway, 'Gateway'],
        [client.gateway?.ws, 'WebSocket'],
        [client.updates, 'UpdateManager'],
        [client.cache?.guilds, 'Cache'],
        [client.cache?.channels, 'Cache'],
        [client.cache?.users, 'Cache'],
      ];
      let patched = 0;
      for (const [instance, name] of instances) if (patchPrototype(instance, fresh[name])) patched++;
      return patched > 0;
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async restart(update) {
    this.stop();
    if (typeof this.restartOverride === 'function') return this.restartOverride(update);
    if (!process.argv[1]) throw new Error('Cannot restart because the bot has no entry script');
    await this.client.shutdown();
    const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      cwd: process.cwd(), env: process.env, stdio: 'inherit', windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
    process.exit(0);
  }

  _report(error, phase) {
    this.client.emit('error', error, { phase, packageName: this.packageName });
  }
}

export const packageVersion = packageJson.version;

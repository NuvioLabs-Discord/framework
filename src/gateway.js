import { EventEmitter } from './events.js';
import { GatewayError } from './errors.js';
import { WebSocket } from './ws.js';
import { sleep } from './util.js';

export const GatewayOpcode = Object.freeze({
  DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, PRESENCE_UPDATE: 3, VOICE_STATE_UPDATE: 4,
  RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11,
  REQUEST_GUILD_MEMBERS: 8,
});

const TERMINAL_CLOSES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const INVALID_SESSION_CLOSES = new Set([4007, 4009]);

/** Maintains a Discord Gateway session and exposes raw dispatch events. */
export class Gateway extends EventEmitter {
  constructor({ token, intents = 0, properties = {}, gatewayUrl = 'wss://gateway.discord.gg/?v=10&encoding=json', maxReconnectAttempts = Infinity, reconnectJitter = 250, heartbeatJitter = 0, logger } = {}) {
    super();
    if (!token) throw new TypeError('A bot token is required');
    this.token = token;
    this.intents = intents;
    this.properties = { os: process.platform, browser: 'nuvio-labs', device: 'nuvio-labs', ...properties };
    this.gatewayUrl = gatewayUrl;
    this.maxReconnectAttempts = maxReconnectAttempts;
    this.reconnectJitter = reconnectJitter;
    this.heartbeatJitter = heartbeatJitter;
    this.logger = logger;
    this.sequence = null;
    this.sessionId = null;
    this.resumeUrl = null;
    this.reconnectAttempts = 0;
    this.stopping = false;
    this.heartbeatAcked = true;
    this.latency = null;
    this.lastHeartbeatAt = null;
    this.lastHeartbeatAckAt = null;
  }

  get isConnected() { return Boolean(this.ws?.connected); }
  get isResuming() { return Boolean(this.sessionId && this.resumeUrl); }

  async connect() {
    this.stopping = false;
    this.reconnectAttempts = 0;
    return this._open();
  }

  async _open() {
    if (this.stopping) return;
    const url = this.sessionId && this.resumeUrl ? this.resumeUrl : this.gatewayUrl;
    this.ws = new WebSocket(url);
    this.ws.on('open', () => this.emit('connected'));
    this.ws.on('message', message => this._message(message));
    this.ws.on('error', error => this.emit('error', error));
    this.ws.once('close', info => this._closed(info));
  }

  _message(message) {
    let packet;
    try { packet = JSON.parse(message); } catch (error) { return this.emit('error', new GatewayError('Invalid Gateway JSON', { cause: error })); }
    this.emit('raw', packet);
    if (packet.s !== null && packet.s !== undefined) this.sequence = packet.s;
    if (packet.op === GatewayOpcode.HELLO) {
      this.heartbeatInterval = packet.d?.heartbeat_interval;
      if (!this.heartbeatInterval) return this.emit('error', new GatewayError('Gateway HELLO did not include heartbeat_interval'));
      this._startHeartbeat();
      if (this.sessionId && this.resumeUrl) this._send(GatewayOpcode.RESUME, { token: this.token, session_id: this.sessionId, seq: this.sequence });
      else this._send(GatewayOpcode.IDENTIFY, { token: this.token, intents: this.intents, properties: this.properties });
    } else if (packet.op === GatewayOpcode.HEARTBEAT) this._heartbeat();
    else if (packet.op === GatewayOpcode.HEARTBEAT_ACK) {
      this.heartbeatAcked = true;
      this.lastHeartbeatAckAt = Date.now();
      this.latency = this.lastHeartbeatAt ? this.lastHeartbeatAckAt - this.lastHeartbeatAt : undefined;
      this.emit('heartbeat', { acknowledged: true, latency: this.latency });
    } else if (packet.op === GatewayOpcode.RECONNECT) this._reconnect();
    else if (packet.op === GatewayOpcode.INVALID_SESSION) {
      if (!packet.d) { this.sessionId = null; this.resumeUrl = null; this.sequence = null; }
      const timer = setTimeout(() => this._reconnect(), packet.d ? 0 : 5000);
      timer.unref?.();
    } else if (packet.op === GatewayOpcode.DISPATCH) this._dispatch(packet.t, packet.d);
  }

  _dispatch(type, data) {
    if (type === 'READY') {
      this.sessionId = data.session_id;
      this.resumeUrl = data.resume_gateway_url;
      this.reconnectAttempts = 0;
    } else if (type === 'RESUMED') this.reconnectAttempts = 0;
    this.emit('dispatch', type, data);
    this.emit(type, data);
  }

  _send(op, data) {
    if (this.ws?.connected) this.ws.send(JSON.stringify({ op, d: data }));
  }

  send(op, data) { this._send(op, data); return this; }
  _heartbeat() {
    if (!this.heartbeatAcked) {
      this.emit('error', new GatewayError('Gateway heartbeat was not acknowledged', { reconnect: true }));
      this.ws?.close(4000, 'heartbeat timeout');
      return;
    }
    this.heartbeatAcked = false;
    this.lastHeartbeatAt = Date.now();
    this._send(GatewayOpcode.HEARTBEAT, this.sequence);
  }
  _startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.heartbeatStartTimer);
    this.heartbeatAcked = true;
    const begin = () => {
      this._heartbeat();
      this.heartbeatTimer = setInterval(() => this._heartbeat(), this.heartbeatInterval);
      this.heartbeatTimer.unref?.();
    };
    const delay = this.heartbeatJitter ? Math.floor(Math.random() * this.heartbeatJitter) : 0;
    if (delay) {
      this.heartbeatStartTimer = setTimeout(begin, delay);
      this.heartbeatStartTimer.unref?.();
    } else begin();
  }

  async _reconnect() { this.ws?.close(1000, 'reconnect'); }

  async _closed({ code = 1006 } = {}) {
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.heartbeatStartTimer);
    if (this.stopping) return;
    this.emit('disconnected', code);
    if (INVALID_SESSION_CLOSES.has(code)) {
      this.sessionId = null; this.resumeUrl = null; this.sequence = null;
    }
    if (TERMINAL_CLOSES.has(code)) return this.emit('error', new GatewayError(`Gateway closed permanently (${code})`, { closeCode: code, reconnect: false }));
    if (++this.reconnectAttempts > this.maxReconnectAttempts) return this.emit('error', new GatewayError('Gateway reconnect limit reached', { closeCode: code, reconnect: false }));
    const backoff = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempts - 1, 5));
    const jitter = this.reconnectJitter ? Math.floor(Math.random() * this.reconnectJitter) : 0;
    await sleep(backoff + jitter);
    this._open();
  }

  identifyPresence(presence) { this._send(GatewayOpcode.PRESENCE_UPDATE, presence); return this; }
  requestGuildMembers(data) { this._send(GatewayOpcode.REQUEST_GUILD_MEMBERS, data); return this; }
  updateVoiceState(data) { this._send(GatewayOpcode.VOICE_STATE_UPDATE, data); return this; }

  disconnect(code = 1000, reason = 'shutdown') {
    this.stopping = true;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.heartbeatStartTimer);
    this.ws?.close(code, reason);
  }
}

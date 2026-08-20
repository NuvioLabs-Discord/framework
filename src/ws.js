import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { EventEmitter } from './events.js';
import { DiscordError } from './errors.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function parseUrl(value) {
  const url = new URL(value);
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new TypeError('Only ws:// and wss:// URLs are supported');
  return url;
}

/** A small RFC 6455 client supporting Discord's text gateway protocol. */
export class WebSocket extends EventEmitter {
  constructor(address, { handshakeTimeout = 10_000, maxFrameSize = 8 * 1024 * 1024 } = {}) {
    super();
    this.url = parseUrl(address);
    this.handshakeTimeout = handshakeTimeout;
    this.maxFrameSize = maxFrameSize;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.connected = false;
    this.closed = false;
    this._connect();
  }

  _connect() {
    const secure = this.url.protocol === 'wss:';
    const port = Number(this.url.port) || (secure ? 443 : 80);
    const options = { host: this.url.hostname, port, ...(secure ? { servername: this.url.hostname } : {}) };
    this.socket = secure ? tls.connect(options) : net.connect(options);
    this.socket.setTimeout(this.handshakeTimeout, () => this._fail(new Error('WebSocket handshake timed out')));
    this.socket.on('error', error => { if (!this.closed) this._fail(error); });
    if (secure) this.socket.once('secureConnect', () => this._handshake());
    else this.socket.once('connect', () => this._handshake());
    this.socket.on('data', chunk => this._read(chunk));
    this.socket.on('close', () => this._close(false));
  }

  _handshake() {
    if (this.handshakeSent) return;
    this.handshakeSent = true;
    this.key = crypto.randomBytes(16).toString('base64');
    const path = `${this.url.pathname || '/'}${this.url.search}`;
    this.socket.write(`GET ${path} HTTP/1.1\r\nHost: ${this.url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${this.key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  }

  _read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.connected) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      const headers = this.buffer.subarray(0, end).toString();
      const accept = headers.match(/Sec-WebSocket-Accept:\s*([^\r\n]+)/i)?.[1]?.trim();
      if (!/^HTTP\/1\.1 101 /i.test(headers) || accept !== crypto.createHash('sha1').update(this.key + GUID).digest('base64')) {
        return this._fail(new DiscordError('Invalid WebSocket upgrade response'));
      }
      this.connected = true;
      this.socket.setTimeout(0);
      this.buffer = this.buffer.subarray(end + 4);
      this.emit('open');
    }
    this._frames();
  }

  _frames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0], second = this.buffer[1];
      const fin = Boolean(first & 0x80), masked = Boolean(second & 0x80);
      let opcode = first & 0x0f;
      let length = second & 0x7f, offset = 2;
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return this._fail(new Error('WebSocket frame is too large'));
        length = Number(big); offset = 10;
      }
      if (length > this.maxFrameSize) return this._fail(new Error('WebSocket frame exceeds maxFrameSize'));
      if (masked) { if (this.buffer.length < offset + 4) return; offset += 4; }
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = this.buffer.subarray(offset - 4, offset);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode >= 0x8) {
        if (!fin || length > 125) return this._fail(new Error('Invalid WebSocket control frame'));
        if (opcode === 0x8) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
          this._sendFrame(0x8, payload);
          this._close(false, code);
          return;
        }
        if (opcode === 0x9) this._sendFrame(0xA, payload);
        else if (opcode === 0xA) this.emit('pong', payload);
        continue;
      }
      if (opcode === 0x0) {
        if (!this.fragmentOpcode) return this._fail(new Error('Unexpected WebSocket continuation frame'));
        this.fragments.push(payload);
        if (!fin) continue;
        opcode = this.fragmentOpcode;
        payload = Buffer.concat(this.fragments);
        this.fragments = [];
        this.fragmentOpcode = null;
      } else if (!fin) {
        if (this.fragmentOpcode) return this._fail(new Error('Nested WebSocket fragmented message'));
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        continue;
      }
      if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
      else if (opcode === 0x2) this.emit('binary', payload);
    }
  }

  send(data) {
    if (!this.connected || this.closed) throw new Error('WebSocket is not open');
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    this._sendFrame(0x1, payload);
    return this;
  }

  ping(data = '') {
    if (!this.connected || this.closed) throw new Error('WebSocket is not open');
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    if (payload.length > 125) throw new RangeError('WebSocket ping payload cannot exceed 125 bytes');
    this._sendFrame(0x9, payload);
    return this;
  }

  _sendFrame(opcode, payload) {
    if (!this.socket || this.socket.destroyed) return;
    const length = payload.length;
    let header;
    if (length < 126) header = Buffer.from([0x80 | opcode, 0x80 | length]);
    else if (length <= 0xffff) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(length), 2); }
    const mask = crypto.randomBytes(4), encoded = Buffer.from(payload);
    for (let i = 0; i < encoded.length; i++) encoded[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, encoded]));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBuffer = Buffer.from(reason).subarray(0, 123);
    const codeBuffer = Buffer.alloc(2);
    codeBuffer.writeUInt16BE(code);
    this._sendFrame(0x8, Buffer.concat([codeBuffer, reasonBuffer]));
    this.socket?.end();
    this._close(true, code);
  }

  _fail(error) { this.emit('error', error); this._close(false); }
  _close(wasClean, code = 1006) {
    if (this.closed) return;
    this.closed = true; this.connected = false;
    this.socket?.destroy();
    this.emit('close', { code, wasClean });
  }
}

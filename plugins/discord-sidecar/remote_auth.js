'use strict';

const { EventEmitter } = require('events');
const {
  constants: cryptoConstants,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
} = require('crypto');
const WebSocket = require('ws');

const GATEWAY_URL = 'wss://remote-auth-gateway.discord.gg/?v=2';
const ORIGIN = 'https://discord.com';
const LOGIN_URL = 'https://discord.com/api/v9/users/@me/remote-auth/login';
const QR_PREFIX = 'https://discord.com/ra/';

/** Recent Discord desktop client identity — reduces false-positive captcha on ticket POST. */
const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9210 Chrome/134.0.0.0 Electron/35.3.0 Safari/537.36';
const DESKTOP_UA_SHORT = 'Discord/1.0.9210 Chrome/134.0.0.0 Electron/35.3.0';

const SUPER_PROPERTIES = {
  os: 'Linux',
  browser: 'Discord Client',
  release_channel: 'stable',
  client_version: '1.0.9210',
  os_version: '6.x',
  os_arch: 'x64',
  app_arch: 'x64',
  system_locale: 'en-US',
  browser_user_agent: DESKTOP_UA,
  browser_version: '134.0.0.0',
  client_build_number: 366629,
  native_build_number: 64292,
  client_event_source: null,
  design_id: 0,
};

function timezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch (_) {
    return 'UTC';
  }
}

function discordHeaders() {
  return {
    'User-Agent': DESKTOP_UA_SHORT,
    'Content-Type': 'application/json',
    'X-Super-Properties': Buffer.from(JSON.stringify(SUPER_PROPERTIES)).toString('base64'),
    'X-Discord-Locale': 'en-US',
    'X-Discord-Timezone': timezone(),
    'Sec-Ch-Ua': '"Chromium";v="134", "Not:A-Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Linux"',
  };
}

function encodePublicKey(publicKey) {
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

function decryptPayload(privateKey, encryptedBase64) {
  return privateDecrypt(
    {
      key: privateKey,
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(encryptedBase64, 'base64')
  );
}

function base64UrlNoPadding(buf) {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function computeNonceProof(privateKey, encryptedNonce) {
  const nonce = decryptPayload(privateKey, encryptedNonce);
  return base64UrlNoPadding(createHash('sha256').update(nonce).digest());
}

function parseUserPayload(payload) {
  const [id = '', discriminator = '0', avatar = '', username = ''] = String(payload).split(':');
  return {
    id,
    username,
    discriminator,
    avatar: !avatar || avatar === '0' ? null : avatar,
  };
}

/**
 * Discord remote-auth v2 session. Emits:
 *   qr(url) | scanned(user) | token(token) | error(err) | expired()
 */
class RemoteAuthSession extends EventEmitter {
  constructor() {
    super();
    this._ws = null;
    this._heartbeat = null;
    this._timeout = null;
    this._keys = null;
    this._exchangeStarted = false;
    this._stopped = false;
    this._autoRotate = true;
  }

  start() {
    this.stop({ silent: true });
    this._stopped = false;
    this._exchangeStarted = false;
    this._keys = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicExponent: 0x10001,
    });

    const ws = new WebSocket(GATEWAY_URL, {
      headers: { Origin: ORIGIN },
    });
    this._ws = ws;

    ws.on('open', () => {
      this.emit('status', 'connected');
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch (_) {
        return;
      }
      try {
        this._onMessage(msg);
      } catch (e) {
        this._fail(e);
      }
    });

    ws.on('close', (code) => {
      this._clearTimers();
      if (this._stopped || this._exchangeStarted) return;
      if (code === 4003 || code === 1000) {
        this.emit('expired');
        if (this._autoRotate) {
          setTimeout(() => {
            if (!this._stopped) this.start();
          }, 250);
        }
        return;
      }
      this._fail(new Error(`Remote auth closed (code ${code})`));
    });

    ws.on('error', (err) => {
      if (this._stopped || this._exchangeStarted) return;
      this._fail(err instanceof Error ? err : new Error(String(err)));
    });
  }

  stop({ silent = false } = {}) {
    this._stopped = true;
    this._clearTimers();
    const ws = this._ws;
    this._ws = null;
    if (ws) {
      try {
        ws.removeAllListeners();
        ws.close();
      } catch (_) {}
    }
    if (!silent) this.emit('status', 'stopped');
  }

  _clearTimers() {
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
    if (this._timeout) {
      clearTimeout(this._timeout);
      this._timeout = null;
    }
  }

  _send(payload) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify(payload));
  }

  _fail(err) {
    if (this._stopped) return;
    this.stop({ silent: true });
    this.emit('error', err instanceof Error ? err : new Error(String(err)));
  }

  _onMessage(msg) {
    switch (msg.op) {
      case 'hello': {
        const interval = Number(msg.heartbeat_interval) || 41250;
        const timeoutMs = Number(msg.timeout_ms) || 120000;
        this._heartbeat = setInterval(() => this._send({ op: 'heartbeat' }), interval);
        if (typeof this._heartbeat.unref === 'function') this._heartbeat.unref();
        this._timeout = setTimeout(() => {
          this.emit('expired');
          if (this._autoRotate && !this._stopped) this.start();
        }, timeoutMs);
        if (typeof this._timeout.unref === 'function') this._timeout.unref();
        this._send({
          op: 'init',
          encoded_public_key: encodePublicKey(this._keys.publicKey),
        });
        this.emit('status', 'waiting');
        break;
      }
      case 'nonce_proof': {
        const proof = computeNonceProof(this._keys.privateKey, msg.encrypted_nonce);
        this._send({ op: 'nonce_proof', proof });
        break;
      }
      case 'pending_remote_init': {
        const url = `${QR_PREFIX}${msg.fingerprint}`;
        this.emit('qr', url);
        break;
      }
      case 'pending_ticket': {
        const raw = decryptPayload(
          this._keys.privateKey,
          msg.encrypted_user_payload
        ).toString('utf8');
        const user = parseUserPayload(raw);
        this.emit('scanned', user);
        break;
      }
      case 'pending_login': {
        if (this._exchangeStarted) break;
        this._exchangeStarted = true;
        this._clearTimers();
        this._exchangeTicket(msg.ticket).catch((e) => this._fail(e));
        break;
      }
      case 'cancel': {
        this._fail(new Error('Login cancelled on phone'));
        break;
      }
      default:
        break;
    }
  }

  async _exchangeTicket(ticket) {
    const res = await fetch(LOGIN_URL, {
      method: 'POST',
      headers: discordHeaders(),
      body: JSON.stringify({ ticket }),
    });

    let body = {};
    try {
      body = await res.json();
    } catch (_) {}

    if (res.status === 400 && body && body.captcha_sitekey) {
      throw new Error(
        'Discord requested a captcha for this login. Try again later — captcha solving is not supported.'
      );
    }
    if (!res.ok) {
      throw new Error(`Ticket exchange failed (HTTP ${res.status})`);
    }
    if (!body.encrypted_token) {
      throw new Error('Ticket exchange returned no token');
    }
    const token = decryptPayload(this._keys.privateKey, body.encrypted_token).toString(
      'utf8'
    );
    this.stop({ silent: true });
    this.emit('token', token);
  }
}

module.exports = {
  RemoteAuthSession,
  discordHeaders,
  DESKTOP_UA,
  DESKTOP_UA_SHORT,
};

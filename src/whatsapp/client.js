'use strict';
const fs = require('fs/promises');
const { EventEmitter } = require('events');
const QRCode = require('qrcode');
const baileys = require('@whiskeysockets/baileys');
const { sleep, randInt } = require('../utils/time');

const makeWASocket = baileys.default || baileys.makeWASocket;
const {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  proto,
} = baileys;

/** Salinan pesan keluar untuk retry receipt (HP pengirim/penerima minta kirim ulang saat gagal dekripsi). */
const MSG_KEY = (id) => `wa:msg:${id}`;
const MSG_TTL_SEC = 3 * 24 * 3600;

/** Kode disconnect yang tidak boleh di-reconnect otomatis (hindari loop). */
const HALT_CODES = new Set([
  DisconnectReason.forbidden, // 403 — kemungkinan dibatasi/ban
  DisconnectReason.connectionReplaced, // 440 — sesi dibuka di tempat lain
  DisconnectReason.multideviceMismatch, // 411
]);

/**
 * Event: 'state' (snapshot), 'open', 'close' (code), 'logged_out', 'halted'
 * status: disconnected | connecting | qr | connected | reconnecting | logged_out | halted
 */
class WhatsAppClient extends EventEmitter {
  constructor({ authDir, maxReconnectAttempts, redis }, logger) {
    super();
    this.redis = redis;
    this.authDir = authDir;
    this.maxReconnect = maxReconnectAttempts;
    this.log = logger.child({ module: 'whatsapp' });
    this.baileysLogger = logger.child({ module: 'baileys' }, { level: process.env.BAILEYS_LOG_LEVEL || 'silent' });
    this.sock = null;
    this.creds = null;
    this.gen = 0; // generasi socket; event dari socket lama diabaikan
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.state = { status: 'disconnected', me: null, name: null, qr: null, alert: null, updatedAt: new Date().toISOString() };
  }

  _set(patch) {
    this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() };
    this.emit('state', this.state);
  }

  isConnected() {
    return this.state.status === 'connected' && !!this.sock;
  }

  waitForOpen(timeoutMs) {
    if (this.isConnected()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onOpen = () => { clearTimeout(t); resolve(true); };
      const t = setTimeout(() => { this.off('open', onOpen); resolve(false); }, timeoutMs);
      this.once('open', onOpen);
    });
  }

  async start() {
    await this._connect();
  }

  async _connect() {
    clearTimeout(this.reconnectTimer);
    const gen = ++this.gen;
    this._set({ status: this.reconnectAttempts ? 'reconnecting' : 'connecting', qr: null });

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({}));
    if (gen !== this.gen) return; // sudah di-reset selagi menunggu

    this.creds = state.creds;
    const sock = makeWASocket({
      version,
      logger: this.baileysLogger,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, this.baileysLogger) },
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      // Tanpa ini, HP pengirim sendiri menampilkan "Menunggu pesan ini" karena
      // Baileys tidak bisa memenuhi permintaan kirim ulang (retry receipt).
      getMessage: (key) => this._loadMessage(key.id),
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    // pushName sering baru datang setelah koneksi "open"
    sock.ev.on('creds.update', ({ me }) => {
      if (gen === this.gen && me?.name && me.name !== this.state.name) this._set({ name: me.name });
    });
    sock.ev.on('connection.update', (update) => {
      if (gen !== this.gen) return;
      this._onUpdate(update, sock).catch((err) => this.log.error({ err }, 'connection.update handler error'));
    });
  }

  async _onUpdate({ connection, lastDisconnect, qr }, sock) {
    if (qr) {
      const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      this._set({ status: 'qr', qr: dataUrl, alert: null });
    }

    if (connection === 'open') {
      this.reconnectAttempts = 0;
      const me = String(sock.user?.id || '').split(/[:@]/)[0] || null;
      const name = sock.user?.name || this.creds?.me?.name || null;
      this._set({ status: 'connected', me, name, qr: null, alert: null });
      this.log.info({ me, name }, 'WhatsApp terhubung');
      this.emit('open');
      return;
    }

    if (connection !== 'close') return;

    const code = lastDisconnect?.error?.output?.statusCode;
    this.sock = null;
    this.emit('close', code);
    this.log.warn({ code }, 'Koneksi WhatsApp tertutup');

    if (code === DisconnectReason.loggedOut) {
      this._set({
        status: 'logged_out', me: null, name: null, qr: null,
        alert: 'Sesi WhatsApp dikeluarkan oleh server atau dari HP. Antrean dihentikan. Pilih "Reset sesi" untuk scan QR baru.',
      });
      this.emit('logged_out');
      return;
    }

    if (code === DisconnectReason.restartRequired) {
      return this._connect(); // normal setelah scan QR
    }

    if (HALT_CODES.has(code)) {
      this._set({
        status: 'halted',
        alert: `WhatsApp menolak koneksi (kode ${code}). Antrean dihentikan; jangan reconnect berulang. Periksa HP pengirim dulu.`,
      });
      this.emit('halted');
      return;
    }

    // Belum pernah login: QR kedaluwarsa itu wajar, tampilkan QR baru tanpa menghitung percobaan.
    if (!this.creds?.registered) {
      this.reconnectTimer = setTimeout(() => this._connect().catch((err) => this.log.error({ err })), 3000);
      return;
    }

    this.reconnectAttempts++;
    if (this.reconnectAttempts > this.maxReconnect) {
      this._set({
        status: 'halted',
        alert: `Gagal reconnect ${this.maxReconnect}× berturut-turut (kode terakhir ${code ?? '-'}). Antrean dihentikan. Periksa jaringan server lalu pilih "Hubungkan ulang".`,
      });
      this.emit('halted');
      return;
    }
    const delay = Math.min(60000, 2000 * 2 ** (this.reconnectAttempts - 1)) + randInt(0, 1000);
    this._set({
      status: 'reconnecting',
      alert: `Koneksi terputus (kode ${code ?? '-'}). Percobaan ${this.reconnectAttempts}/${this.maxReconnect} dalam ${Math.round(delay / 1000)} detik.`,
    });
    this.reconnectTimer = setTimeout(() => this._connect().catch((err) => this.log.error({ err })), delay);
  }

  /** Reconnect manual dari dashboard (setelah status halted). */
  async reconnect() {
    this.reconnectAttempts = 0;
    this._end();
    this._set({ alert: null });
    await this._connect();
  }

  /** Logout dari perangkat tertaut lalu tampilkan QR baru. */
  async logout() {
    const sock = this.sock;
    this.gen++; // abaikan event close dari logout ini
    if (sock) await sock.logout().catch((err) => this.log.warn({ err }, 'logout error (diabaikan)'));
    await this.resetSession();
  }

  /** Hapus kredensial lokal dan mulai sesi baru (QR). */
  async resetSession() {
    this._end();
    await fs.rm(this.authDir, { recursive: true, force: true });
    this.reconnectAttempts = 0;
    this._set({ status: 'disconnected', me: null, name: null, qr: null, alert: null });
    await this._connect();
  }

  _end() {
    this.gen++;
    clearTimeout(this.reconnectTimer);
    try { this.sock?.end(undefined); } catch { /* sudah tertutup */ }
    this.sock = null;
  }

  async stop() {
    this._end();
  }

  /** @returns {Promise<string|null>} JID bila nomor terdaftar di WhatsApp */
  async checkNumber(phone) {
    if (!this.sock) throw new Error('Socket WhatsApp tidak aktif');
    const [result] = (await this.sock.onWhatsApp(`${phone}@s.whatsapp.net`)) || [];
    return result?.exists ? result.jid : null;
  }

  /** Simulasi "mengetik..." 3–6 detik, jeda 1–2 detik, lalu kirim. */
  async sendWithTyping(jid, text, s) {
    const sock = this.sock;
    if (!sock) throw new Error('Socket WhatsApp tidak aktif');
    await sock.presenceSubscribe(jid).catch(() => {});
    await sock.sendPresenceUpdate('composing', jid);
    await sleep(randInt(s.typingMinMs, s.typingMaxMs));
    await sock.sendPresenceUpdate('paused', jid);
    await sleep(randInt(s.pauseMinMs, s.pauseMaxMs));
    if (this.sock !== sock) throw new Error('Koneksi WhatsApp berganti saat akan mengirim');
    const sent = await sock.sendMessage(jid, { text });
    await this._storeMessage(sent);
    return sent;
  }

  async _storeMessage(sent) {
    if (!this.redis || !sent?.key?.id || !sent.message) return;
    try {
      const bin = proto.Message.encode(sent.message).finish();
      await this.redis.set(MSG_KEY(sent.key.id), Buffer.from(bin).toString('base64'), 'EX', MSG_TTL_SEC);
    } catch (err) {
      this.log.warn({ err, id: sent.key.id }, 'Gagal menyimpan salinan pesan untuk retry');
    }
  }

  async _loadMessage(id) {
    if (!this.redis || !id) return undefined;
    try {
      const b64 = await this.redis.get(MSG_KEY(id));
      if (!b64) return undefined;
      this.log.info({ id }, 'Permintaan kirim ulang (retry) dilayani');
      return proto.Message.decode(Buffer.from(b64, 'base64'));
    } catch (err) {
      this.log.warn({ err, id }, 'Gagal memuat salinan pesan untuk retry');
      return undefined;
    }
  }
}

module.exports = { WhatsAppClient };

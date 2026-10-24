'use strict';
const { STATUS } = require('../config');
const { normalizePhone } = require('../utils/phone');
const { eqStatus } = require('../utils/text');
const { activity } = require('../activity');

/**
 * Detection layer + job creator.
 * Sumber pemicu: polling berkala, dan (opsional) webhook Apps Script yang
 * hanya "membangunkan" scan — isi webhook tidak dipercaya, sheet tetap sumber kebenaran.
 */
class Producer {
  constructor({ sheets, sources, queue, intervalMs }, logger) {
    this.sheets = sheets;
    this.sources = sources;
    this.queue = queue;
    this.intervalMs = intervalMs;
    this.log = logger.child({ module: 'producer' });
    this.running = false;
    this.pending = false;
    this.lastScanAt = null;
  }

  start() {
    this.timer = setInterval(() => this.scan('poll'), this.intervalMs);
    this.scan('startup');
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.debounce);
  }

  /** Dipanggil webhook; beberapa edit beruntun digabung jadi satu scan. */
  trigger(reason = 'webhook') {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.scan(reason), 1000);
  }

  async scan(reason) {
    if (this.running) { this.pending = true; return; }
    this.running = true;
    try {
      const active = await this.sources.active();
      const rows = await this.sheets.readAll(active.map((s) => s.title));
      this.lastScanAt = new Date().toISOString();
      const targets = rows.filter((r) => eqStatus(r.status, STATUS.TRIGGER));
      if (!targets.length) return;
      const sheetIds = new Map(active.map((s) => [s.title, s.sheetId]));

      // Nomor yang masih "Antre" di sheet mana pun dianggap sudah dipakai (cegah pesan ganda lintas sheet).
      const queuedPhones = new Set(
        rows.filter((r) => eqStatus(r.status, STATUS.QUEUED)).map((r) => normalizePhone(r.phoneRaw)).filter(Boolean),
      );
      const valid = [];
      const invalid = [];
      const duplicate = [];
      const seen = new Set();
      for (const r of targets) {
        const phone = normalizePhone(r.phoneRaw);
        if (!phone || !r.name) invalid.push(r);
        else if (seen.has(phone) || queuedPhones.has(phone)) duplicate.push(r);
        else { seen.add(phone); valid.push({ ...r, phone }); }
      }

      if (invalid.length) {
        await this.sheets.markMany(invalid, STATUS.FAILED, 'Nomor tidak valid atau nama kosong');
        activity('warn', `${invalid.length} baris ditandai Gagal: nomor tidak valid / nama kosong`);
      }
      if (duplicate.length) {
        await this.sheets.markMany(duplicate, STATUS.FAILED, 'Nomor sama dengan baris lain (bisa di sheet lain) yang sedang/akan dikirim');
        activity('warn', `${duplicate.length} baris ditandai Gagal: nomor ganda`);
      }
      if (!valid.length) return;

      // Tandai "Antre" DULU agar siklus polling berikutnya tidak menduplikasi.
      await this.sheets.markMany(valid, STATUS.QUEUED, '');

      let added = 0;
      for (const r of valid) {
        try {
          await this.queue.add(
            'send-tracer',
            { sheet: r.sheet, rowNumber: r.rowNumber, name: r.name, major: r.major, phone: r.phone, enqueuedAt: Date.now() },
            // BullMQ melarang ":" di jobId, jadi pakai sheetId numerik, bukan nama sheet
            { jobId: `s${sheetIds.get(r.sheet)}-row${r.rowNumber}-${r.phone}-${Date.now()}` },
          );
          added++;
        } catch (err) {
          this.log.error({ err, sheet: r.sheet, row: r.rowNumber }, 'Gagal menambah job; status dikembalikan');
          await this.sheets
            .update(r.sheet, r.rowNumber, { status: STATUS.TRIGGER, detail: 'Gagal masuk antrean, akan dicoba lagi' })
            .catch(() => {});
        }
      }
      this.log.info({ reason, added }, 'Job baru masuk antrean');
      activity('info', `${added} alumni masuk antrean (${reason})`);
    } catch (err) {
      this.log.error({ err }, 'Scan spreadsheet gagal');
      activity('error', `Scan spreadsheet gagal: ${err.message}`);
    } finally {
      this.running = false;
      if (this.pending) { this.pending = false; setImmediate(() => this.scan('pending')); }
    }
  }
}

module.exports = { Producer };

'use strict';
const { activity } = require('../activity');

const KEY = 'wa:active_sheets';
const LIST_TTL_MS = 60000;

/**
 * Pilihan sheet aktif (sumber data) yang diatur dari dashboard.
 * Disimpan di Redis agar bertahan setelah restart; default = GOOGLE_SHEET_NAME.
 */
class SheetSources {
  constructor({ redis, sheets, defaultSheet }, logger) {
    this.redis = redis;
    this.sheets = sheets;
    this.defaultSheet = defaultSheet;
    this.log = logger.child({ module: 'sources' });
    this.selected = [defaultSheet];
    this.cache = null;
    this.cachedAt = 0;
    this.warnedMissing = new Set();
  }

  async init() {
    const raw = await this.redis.get(KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) this.selected = parsed.map(String);
    } catch {
      this.log.warn('Pilihan sheet di Redis rusak; memakai default');
    }
  }

  /** Daftar sheet di spreadsheet (di-cache 60 detik agar polling tidak boros kuota). */
  async list(force = false) {
    if (!force && this.cache && Date.now() - this.cachedAt < LIST_TTL_MS) return this.cache;
    try {
      this.cache = await this.sheets.listSheets();
      this.cachedAt = Date.now();
    } catch (err) {
      if (!this.cache) throw err;
      this.log.warn({ err }, 'Gagal memuat daftar sheet; memakai cache lama');
    }
    return this.cache;
  }

  async describe(force = false) {
    const list = await this.list(force);
    const titles = new Set(list.map((s) => s.title));
    return {
      sheets: list.map((s) => ({ ...s, active: this.selected.includes(s.title) })),
      missing: this.selected.filter((t) => !titles.has(t)),
    };
  }

  /** Sheet aktif yang masih ada dan formatnya cocok. */
  async active() {
    const list = await this.list();
    const byTitle = new Map(list.map((s) => [s.title, s]));
    const result = [];
    for (const title of this.selected) {
      const s = byTitle.get(title);
      if (s?.compatible) {
        this.warnedMissing.delete(title);
        result.push(s);
      } else if (!this.warnedMissing.has(title)) {
        this.warnedMissing.add(title);
        activity('warn', s
          ? `Sheet "${title}" dilewati: format header tidak cocok`
          : `Sheet "${title}" tidak ditemukan (dihapus/diganti nama?); dilewati`);
      }
    }
    return result;
  }

  async set(titles) {
    if (!Array.isArray(titles)) throw new Error('Format pilihan sheet tidak valid');
    const list = await this.list(true);
    const byTitle = new Map(list.map((s) => [s.title, s]));
    const clean = [...new Set(titles.map(String))];
    for (const t of clean) {
      if (!byTitle.has(t)) throw new Error(`Sheet "${t}" tidak ada di spreadsheet`);
      if (!byTitle.get(t).compatible) throw new Error(`Format sheet "${t}" tidak cocok (header B harus "Nama", E harus "Status")`);
    }
    this.selected = clean;
    this.warnedMissing.clear();
    await this.redis.set(KEY, JSON.stringify(clean));
    activity('info', clean.length
      ? `Sumber data diubah: ${clean.join(', ')}`
      : 'Semua sheet dinonaktifkan; tidak ada yang dipindai');
  }
}

module.exports = { SheetSources };

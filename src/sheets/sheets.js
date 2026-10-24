'use strict';
const { google } = require('googleapis');
const { STATUS } = require('../config');
const { normalizePhone } = require('../utils/phone');
const { eqStatus } = require('../utils/text');
const { sleep } = require('../utils/time');

/**
 * Skema tiap sheet: A Timestamp | B Nama | C Jurusan | D No WA | E Status | F Waktu Terkirim | [G Keterangan]
 * Semua method menerima nama sheet; satu spreadsheet bisa berisi banyak sheet alumni.
 */
class SheetsClient {
  constructor({ keyFile, spreadsheetId, sheetName, firstDataRow, detailColumn }, logger) {
    const auth = new google.auth.GoogleAuth({
      keyFile,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.api = google.sheets({ version: 'v4', auth });
    this.spreadsheetId = spreadsheetId;
    this.defaultSheet = sheetName; // untuk job lama yang belum membawa nama sheet
    this.firstRow = firstDataRow;
    this.detailColumn = detailColumn || '';
    this.lastCol = this.detailColumn || 'F';
    this.log = logger.child({ module: 'sheets' });
  }

  a1(sheet, ref) {
    return `'${String(sheet).replace(/'/g, "''")}'!${ref}`;
  }

  async _retry(label, fn) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const code = err?.code ?? err?.response?.status;
        const retryable = typeof code !== 'number' || code === 429 || code >= 500;
        if (!retryable || attempt >= 4) throw err;
        const wait = 2000 * 2 ** (attempt - 1);
        this.log.warn({ code, attempt, wait }, `${label} gagal, mencoba lagi`);
        await sleep(wait);
      }
    }
  }

  _toRow(values = [], sheet, rowNumber) {
    const v = (i) => (values[i] ?? '');
    return {
      sheet,
      rowNumber,
      name: String(v(1)).trim(),
      major: String(v(2)).trim(),
      phoneRaw: v(3),
      status: String(v(4)).trim(),
    };
  }

  /**
   * Daftar sheet beserta kecocokan format (dicek dari baris header).
   * @returns {Promise<Array<{title: string, sheetId: number, hidden: boolean, compatible: boolean}>>}
   */
  async listSheets() {
    const meta = await this._retry('listSheets', () =>
      this.api.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
        fields: 'sheets.properties(sheetId,title,index,hidden,sheetType)',
      }),
    );
    const tabs = (meta.data.sheets || [])
      .map((s) => s.properties)
      .filter((p) => !p.sheetType || p.sheetType === 'GRID')
      .sort((a, b) => a.index - b.index);
    if (!tabs.length) return [];

    let headers = [];
    if (this.firstRow > 1) {
      const headerRow = this.firstRow - 1;
      const res = await this._retry('readHeaders', () =>
        this.api.spreadsheets.values.batchGet({
          spreadsheetId: this.spreadsheetId,
          ranges: tabs.map((t) => this.a1(t.title, `A${headerRow}:${this.lastCol}${headerRow}`)),
        }),
      );
      headers = (res.data.valueRanges || []).map((vr) => vr.values?.[0] || []);
    }
    return tabs.map((t, i) => ({
      title: t.title,
      sheetId: t.sheetId,
      hidden: !!t.hidden,
      compatible: this.firstRow <= 1 || isCompatibleHeader(headers[i] || []),
    }));
  }

  /** Baca seluruh baris dari beberapa sheet sekaligus (satu request). */
  async readAll(sheetNames) {
    if (!sheetNames.length) return [];
    const res = await this._retry('readAll', () =>
      this.api.spreadsheets.values.batchGet({
        spreadsheetId: this.spreadsheetId,
        ranges: sheetNames.map((s) => this.a1(s, `A${this.firstRow}:${this.lastCol}`)),
        // UNFORMATTED agar nomor HP bertipe angka tidak berubah jadi 6.28E+12
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'FORMATTED_STRING',
      }),
    );
    const ranges = res.data.valueRanges || [];
    return sheetNames.flatMap((sheet, i) =>
      (ranges[i]?.values || []).map((r, j) => this._toRow(r, sheet, this.firstRow + j)),
    );
  }

  async readRow(sheet, rowNumber) {
    const res = await this._retry('readRow', () =>
      this.api.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: this.a1(sheet, `A${rowNumber}:${this.lastCol}${rowNumber}`),
        valueRenderOption: 'UNFORMATTED_VALUE',
      }),
    );
    return this._toRow(res.data.values?.[0], sheet, rowNumber);
  }

  _statusRanges(sheet, rowNumber, { status, sentAt, detail }) {
    const data = [];
    if (status !== undefined) {
      // Tanpa kolom keterangan, alasan ditulis di kolom E: "Gagal (alasan)"
      const value = !this.detailColumn && detail ? `${status} (${detail})` : status;
      data.push({ range: this.a1(sheet, `E${rowNumber}`), values: [[value]] });
    }
    if (sentAt !== undefined) data.push({ range: this.a1(sheet, `F${rowNumber}`), values: [[sentAt]] });
    if (detail !== undefined && this.detailColumn) {
      data.push({ range: this.a1(sheet, `${this.detailColumn}${rowNumber}`), values: [[detail]] });
    }
    return data;
  }

  async _batch(data) {
    if (!data.length) return;
    await this._retry('batchUpdate', () =>
      this.api.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { valueInputOption: 'RAW', data },
      }),
    );
  }

  async update(sheet, rowNumber, fields) {
    await this._batch(this._statusRanges(sheet, rowNumber, fields));
  }

  /** @param {Array<{sheet: string, rowNumber: number}>} rows */
  async markMany(rows, status, detail) {
    await this._batch(rows.flatMap((r) => this._statusRanges(r.sheet, r.rowNumber, { status, detail })));
  }

  /**
   * Cari baris milik job. Baris bisa bergeser bila ada yang menyisipkan/
   * mengurutkan data setelah job dibuat, jadi nomor HP dicocokkan ulang.
   * @returns {{row?: object, cancelled?: boolean}}
   */
  async locate({ sheet, rowNumber, phone, name }) {
    sheet = sheet || this.defaultSheet;
    const direct = await this.readRow(sheet, rowNumber);
    if (normalizePhone(direct.phoneRaw) === phone) {
      return eqStatus(direct.status, STATUS.QUEUED) ? { row: direct } : { cancelled: true, row: direct };
    }
    const all = await this.readAll([sheet]);
    const match =
      all.find((r) => normalizePhone(r.phoneRaw) === phone && eqStatus(r.status, STATUS.QUEUED) && r.name === name) ||
      all.find((r) => normalizePhone(r.phoneRaw) === phone && eqStatus(r.status, STATUS.QUEUED));
    return match ? { row: match } : {};
  }
}

/** Header minimal: kolom B berisi "Nama" dan kolom E berisi "Status". */
function isCompatibleHeader(h) {
  return /nama/i.test(String(h[1] || '')) && /status/i.test(String(h[4] || ''));
}

module.exports = { SheetsClient };

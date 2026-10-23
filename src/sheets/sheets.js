'use strict';
const { google } = require('googleapis');
const { STATUS } = require('../config');
const { normalizePhone } = require('../utils/phone');
const { eqStatus } = require('../utils/text');
const { sleep } = require('../utils/time');

/**
 * Skema: A Timestamp | B Nama | C Jurusan | D No WA | E Status | F Waktu Terkirim | [G Keterangan]
 */
class SheetsClient {
  constructor({ keyFile, spreadsheetId, sheetName, firstDataRow, detailColumn }, logger) {
    const auth = new google.auth.GoogleAuth({
      keyFile,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.api = google.sheets({ version: 'v4', auth });
    this.spreadsheetId = spreadsheetId;
    this.sheetName = sheetName;
    this.firstRow = firstDataRow;
    this.detailColumn = detailColumn || '';
    this.lastCol = this.detailColumn || 'F';
    this.log = logger.child({ module: 'sheets' });
  }

  a1(ref) {
    return `'${this.sheetName.replace(/'/g, "''")}'!${ref}`;
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

  _toRow(values = [], rowNumber) {
    const v = (i) => (values[i] ?? '');
    return {
      rowNumber,
      name: String(v(1)).trim(),
      major: String(v(2)).trim(),
      phoneRaw: v(3),
      status: String(v(4)).trim(),
    };
  }

  async readAll() {
    const res = await this._retry('readAll', () =>
      this.api.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: this.a1(`A${this.firstRow}:${this.lastCol}`),
        // UNFORMATTED agar nomor HP bertipe angka tidak berubah jadi 6.28E+12
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'FORMATTED_STRING',
      }),
    );
    return (res.data.values || []).map((r, i) => this._toRow(r, this.firstRow + i));
  }

  async readRow(rowNumber) {
    const res = await this._retry('readRow', () =>
      this.api.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: this.a1(`A${rowNumber}:${this.lastCol}${rowNumber}`),
        valueRenderOption: 'UNFORMATTED_VALUE',
      }),
    );
    return this._toRow(res.data.values?.[0], rowNumber);
  }

  _statusRanges(rowNumber, { status, sentAt, detail }) {
    const data = [];
    if (status !== undefined) {
      // Tanpa kolom keterangan, alasan ditulis di kolom E: "Gagal (alasan)"
      const value = !this.detailColumn && detail ? `${status} (${detail})` : status;
      data.push({ range: this.a1(`E${rowNumber}`), values: [[value]] });
    }
    if (sentAt !== undefined) data.push({ range: this.a1(`F${rowNumber}`), values: [[sentAt]] });
    if (detail !== undefined && this.detailColumn) {
      data.push({ range: this.a1(`${this.detailColumn}${rowNumber}`), values: [[detail]] });
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

  async update(rowNumber, fields) {
    await this._batch(this._statusRanges(rowNumber, fields));
  }

  async markMany(rowNumbers, status, detail) {
    await this._batch(rowNumbers.flatMap((n) => this._statusRanges(n, { status, detail })));
  }

  /**
   * Cari baris milik job. Baris bisa bergeser bila ada yang menyisipkan/
   * mengurutkan data setelah job dibuat, jadi nomor HP dicocokkan ulang.
   * @returns {{row?: object, cancelled?: boolean}}
   */
  async locate({ rowNumber, phone, name }) {
    const direct = await this.readRow(rowNumber);
    if (normalizePhone(direct.phoneRaw) === phone) {
      return eqStatus(direct.status, STATUS.QUEUED) ? { row: direct } : { cancelled: true, row: direct };
    }
    const all = await this.readAll();
    const match =
      all.find((r) => normalizePhone(r.phoneRaw) === phone && eqStatus(r.status, STATUS.QUEUED) && r.name === name) ||
      all.find((r) => normalizePhone(r.phoneRaw) === phone && eqStatus(r.status, STATUS.QUEUED));
    return match ? { row: match } : {};
  }
}

module.exports = { SheetsClient };

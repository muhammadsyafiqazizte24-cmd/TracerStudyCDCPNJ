'use strict';
require('dotenv').config();
const path = require('path');

function str(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}
function int(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`ENV ${name} harus berupa angka (sekarang: "${v}")`);
  return n;
}
function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`ENV ${name} wajib diisi (lihat .env.example)`);
  return v;
}

/** Nilai dropdown kolom E. Harus sama persis dengan Data Validation di Sheets. */
const STATUS = Object.freeze({
  DRAFT: 'Draft',
  TRIGGER: 'Kirim Tracer',
  QUEUED: 'Antre',
  SENT: 'Terkirim',
  FAILED: 'Gagal',
});

const config = {
  port: int('PORT', 3000),
  dashboard: {
    user: str('DASHBOARD_USER', 'admin'),
    password: required('DASHBOARD_PASSWORD'),
  },
  webhookSecret: str('WEBHOOK_SECRET', ''),

  redisUrl: str('REDIS_URL', 'redis://127.0.0.1:6379'),
  queueName: str('QUEUE_NAME', 'tracer-wa'),
  jobAttempts: int('JOB_ATTEMPTS', 3),

  wa: {
    authDir: path.resolve(str('WA_AUTH_DIR', './auth_info_baileys')),
    maxReconnectAttempts: int('MAX_RECONNECT_ATTEMPTS', 8),
  },

  sheets: {
    keyFile: path.resolve(required('GOOGLE_APPLICATION_CREDENTIALS')),
    spreadsheetId: required('GOOGLE_SPREADSHEET_ID'),
    sheetName: str('GOOGLE_SHEET_NAME', 'Sheet1'),
    firstDataRow: int('SHEET_FIRST_DATA_ROW', 2),
    detailColumn: str('SHEET_DETAIL_COLUMN', 'G').toUpperCase(),
  },
  pollIntervalMs: int('POLL_INTERVAL_MS', 10000),

  message: {
    templateFile: path.resolve(str('MESSAGE_TEMPLATE_FILE', './templates/tracer.txt')),
    surveyUrl: required('SURVEY_URL'),
    signature: str('SENDER_SIGNATURE', 'Tim Tracer Study'),
  },

  safety: {
    concurrency: 1, // sengaja tidak bisa diubah lewat ENV
    jitterMinMs: int('JITTER_MIN_MS', 30000),
    jitterMaxMs: int('JITTER_MAX_MS', 65000),
    typingMinMs: 3000,
    typingMaxMs: 6000,
    pauseMinMs: 1000,
    pauseMaxMs: 2000,
    dailyQuota: int('DAILY_QUOTA', 120),
    sendWindowStart: int('SEND_WINDOW_START', 8),
    sendWindowEnd: int('SEND_WINDOW_END', 20),
    timezone: str('TIMEZONE', 'Asia/Jakarta'),
  },
};

// ── Validasi aturan anti-ban ─────────────────────────────────────
const s = config.safety;
if (s.jitterMinMs < 30000) throw new Error('JITTER_MIN_MS minimal 30000 (aturan anti-ban PRD)');
if (s.jitterMaxMs < s.jitterMinMs) throw new Error('JITTER_MAX_MS harus >= JITTER_MIN_MS');
if (s.dailyQuota < 1 || s.dailyQuota > 150) throw new Error('DAILY_QUOTA harus 1–150');
if (!(s.sendWindowStart >= 0 && s.sendWindowEnd <= 24 && s.sendWindowStart < s.sendWindowEnd)) {
  throw new Error('SEND_WINDOW_START/END tidak valid (0 ≤ start < end ≤ 24)');
}
if (config.sheets.detailColumn && !/^[A-Z]{1,2}$/.test(config.sheets.detailColumn)) {
  throw new Error('SHEET_DETAIL_COLUMN harus huruf kolom, mis. G');
}
if (['A', 'B', 'C', 'D', 'E', 'F'].includes(config.sheets.detailColumn)) {
  throw new Error('SHEET_DETAIL_COLUMN tidak boleh menimpa kolom A–F');
}

module.exports = { config, STATUS };

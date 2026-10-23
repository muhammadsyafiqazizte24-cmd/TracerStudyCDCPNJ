'use strict';
const { Worker, DelayedError } = require('bullmq');
const { STATUS } = require('../config');
const quota = require('../quota');
const { buildTracerMessage } = require('../template');
const { activity } = require('../activity');
const { sleep, randInt, formatLocal, msUntilSendWindow } = require('../utils/time');

const LAST_ACTION_KEY = 'wa:last_action_at';
const sentKey = (jobId) => `wa:sent:${jobId}`;

/** Error yang tidak perlu di-retry (job ditutup sebagai Gagal). */
class PermanentError extends Error {}

function createWorker({ config, connection, redis, wa, sheets }, logger) {
  const log = logger.child({ module: 'worker' });
  const S = config.safety;

  async function postpone(job, token, ms, reason) {
    const until = new Date(Date.now() + ms);
    log.info({ jobId: job.id, until: until.toISOString(), reason }, 'Job ditunda');
    await job.updateData({ ...job.data, note: reason });
    await job.moveToDelayed(until.getTime(), token);
    throw new DelayedError(); // tidak dihitung sebagai attempt
  }

  async function safeSheetUpdate(rowNumber, fields) {
    try {
      await sheets.update(rowNumber, fields);
    } catch (err) {
      // Jangan pernah throw di sini: gagal update sheet tidak boleh memicu kirim ulang.
      log.error({ err, rowNumber, fields }, 'Update spreadsheet gagal');
      activity('error', `Pesan baris ${rowNumber} sudah diproses tetapi update sheet gagal: ${err.message}`);
    }
  }

  async function markSent(job, rowNumber) {
    await safeSheetUpdate(rowNumber, { status: STATUS.SENT, sentAt: formatLocal(new Date(), S.timezone), detail: '' });
  }

  async function ensureConnected(job, token) {
    if (wa.isConnected()) return;
    const ok = await wa.waitForOpen(60000);
    if (!ok) await postpone(job, token, 120000, 'WhatsApp belum terhubung');
  }

  async function processor(job, token) {
    const { phone, name } = job.data;

    // 0. Idempotensi: pesan sudah terkirim tetapi job belum sempat selesai (crash/restart)
    if (await redis.exists(sentKey(job.id))) {
      const { row } = await sheets.locate(job.data);
      if (row) await markSent(job, row.rowNumber);
      return { skipped: 'already-sent' };
    }

    // 1. Jam kirim & kuota rolling 24 jam
    const windowWait = msUntilSendWindow(new Date(), S);
    if (windowWait > 0) await postpone(job, token, windowWait, 'Di luar jam kirim');
    const quotaWait = await quota.msUntilSlot(redis, S.dailyQuota);
    if (quotaWait > 0) {
      activity('warn', `Kuota ${S.dailyQuota} pesan/24 jam tercapai. Antrean lanjut ${formatLocal(new Date(Date.now() + quotaWait), S.timezone)}`);
      await postpone(job, token, quotaWait, 'Kuota harian tercapai');
    }

    // 2. Koneksi harus "open"
    await ensureConnected(job, token);

    // 3. Random jitter 30–65 detik sejak aksi keluar terakhir
    const gap = randInt(S.jitterMinMs, S.jitterMaxMs);
    const last = Number((await redis.get(LAST_ACTION_KEY)) || 0);
    const wait = last + gap - Date.now();
    if (wait > 0) {
      log.debug({ jobId: job.id, wait }, 'Jitter');
      await sleep(wait);
    }
    await ensureConnected(job, token); // bisa putus selama jeda

    // 4. Baris masih "Antre"? (petugas bisa membatalkan dengan mengubah status)
    const { row, cancelled } = await sheets.locate(job.data);
    if (!row) {
      activity('warn', `Baris untuk ${name} tidak ditemukan lagi di sheet; job dilewati`);
      return { skipped: 'row-not-found' };
    }
    if (cancelled) {
      activity('info', `Pengiriman ke ${name} dibatalkan (status sheet: ${row.status || 'kosong'})`);
      return { skipped: 'cancelled' };
    }

    // 5. Validasi nomor terdaftar di WhatsApp
    const jid = await wa.checkNumber(phone);
    await redis.set(LAST_ACTION_KEY, Date.now());
    if (!jid) throw new PermanentError('Tidak Terdaftar di WA');

    // 6. Presence "mengetik..." lalu kirim
    const text = buildTracerMessage(job.data, config.message, S.timezone);
    await wa.sendWithTyping(jid, text, S);

    const now = Date.now();
    await redis.set(sentKey(job.id), now, 'EX', 7 * 24 * 3600);
    await redis.set(LAST_ACTION_KEY, now);
    await quota.record(redis, job.id);

    // 7. Callback ke spreadsheet
    await markSent(job, row.rowNumber);
    activity('success', `Terkirim ke ${name} (baris ${row.rowNumber})`);
    return { sentAt: now };
  }

  const worker = new Worker(
    config.queueName,
    async (job, token) => {
      try {
        return await processor(job, token);
      } catch (err) {
        if (err instanceof DelayedError) throw err;
        if (err instanceof PermanentError) {
          // Tutup job tanpa retry
          const { row } = await sheets.locate(job.data).catch(() => ({}));
          await safeSheetUpdate(row?.rowNumber ?? job.data.rowNumber, { status: STATUS.FAILED, sentAt: '', detail: err.message });
          activity('warn', `Gagal ke ${job.data.name}: ${err.message}`);
          return { failed: err.message };
        }
        throw err; // retry sesuai attempts/backoff
      }
    },
    {
      connection,
      concurrency: S.concurrency, // = 1, wajib
      lockDuration: 120000,
      maxStalledCount: 1,
    },
  );

  worker.on('failed', async (job, err) => {
    if (!job || err?.name === 'DelayedError') return;
    const final = job.attemptsMade >= (job.opts.attempts || 1);
    log.error({ jobId: job.id, attempt: job.attemptsMade, err: err?.message }, 'Job gagal');
    if (!final) {
      activity('warn', `Kirim ke ${job.data.name} gagal (percobaan ${job.attemptsMade}), dicoba lagi: ${err?.message}`);
      return;
    }
    const { row } = await sheets.locate(job.data).catch(() => ({}));
    await safeSheetUpdate(row?.rowNumber ?? job.data.rowNumber, {
      status: STATUS.FAILED, sentAt: '', detail: String(err?.message || 'Error tidak diketahui').slice(0, 200),
    });
    activity('error', `Gagal permanen ke ${job.data.name}: ${err?.message}`);
  });

  worker.on('error', (err) => log.error({ err }, 'Worker error'));
  return worker;
}

module.exports = { createWorker };

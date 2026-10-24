'use strict';
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  const isNoisySignalError = args.some((arg) =>
    typeof arg === 'string' &&
    (arg.includes('Failed to decrypt message') || arg.includes('Session error:Error: Bad MAC')),
  );
  if (!isNoisySignalError) originalConsoleError(...args);
};

const { config } = require('./config');
const logger = require('./logger');
const quota = require('./quota');
const { activity } = require('./activity');
const { createRedis, createQueue } = require('./queue/queue');
const { createWorker } = require('./queue/worker');
const { Producer } = require('./queue/producer');
const { SheetsClient } = require('./sheets/sheets');
const { SheetSources } = require('./sheets/sources');
const { WhatsAppClient } = require('./whatsapp/client');
const { createServer } = require('./web/server');
const { msUntilSendWindow } = require('./utils/time');

const MANUAL_PAUSE_KEY = 'wa:manual_pause';

async function main() {
  const redis = createRedis(config.redisUrl);
  const queue = createQueue(config, createRedis(config.redisUrl));
  const sheets = new SheetsClient(config.sheets, logger);
  const wa = new WhatsAppClient({ ...config.wa, redis }, logger);
  const sources = new SheetSources({ redis, sheets, defaultSheet: config.sheets.sheetName }, logger);
  await sources.init();

  // Tahan antrean sampai WhatsApp benar-benar "open".
  await queue.pause();
  let manualPause = (await redis.get(MANUAL_PAUSE_KEY)) === '1';
  let haltedReason = null;

  const controls = {
    async pause() {
      manualPause = true;
      await redis.set(MANUAL_PAUSE_KEY, '1');
      await queue.pause();
      activity('info', 'Antrean dijeda manual dari dashboard');
    },
    async resume() {
      manualPause = false;
      await redis.del(MANUAL_PAUSE_KEY);
      if (wa.isConnected()) {
        await queue.resume();
        activity('info', 'Antrean dilanjutkan');
      } else {
        activity('warn', 'Antrean akan berjalan otomatis setelah WhatsApp terhubung');
      }
    },
  };

  wa.on('open', async () => {
    haltedReason = null;
    if (!manualPause) await queue.resume().catch((err) => logger.error({ err }));
    activity('success', `WhatsApp terhubung sebagai ${wa.state.name || `+${wa.state.me}`}${manualPause ? ' (antrean masih dijeda manual)' : ''}`);
  });
  wa.on('close', () => queue.pause().catch((err) => logger.error({ err })));
  wa.on('logged_out', () => {
    haltedReason = 'logged_out';
    logger.error('⚠️  WhatsApp LOGGED OUT — seluruh antrean dihentikan');
    activity('error', 'WhatsApp logout oleh server. Seluruh antrean dihentikan.');
  });
  wa.on('halted', () => {
    haltedReason = 'halted';
    logger.error({ alert: wa.state.alert }, '⚠️  Reconnect dihentikan — antrean berhenti');
    activity('error', wa.state.alert);
  });

  const worker = createWorker({ config, connection: createRedis(config.redisUrl), redis, wa, sheets }, logger);
  const producer = new Producer({ sheets, sources, queue, intervalMs: config.pollIntervalMs }, logger);

  const getStats = async () => {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'paused');
    return {
      queue: { ...counts, paused: await queue.isPaused(), manualPause, haltedReason },
      quota: { used: await quota.usage(redis), limit: config.safety.dailyQuota },
      window: {
        start: config.safety.sendWindowStart,
        end: config.safety.sendWindowEnd,
        open: msUntilSendWindow(new Date(), { ...config.safety }) === 0,
        timezone: config.safety.timezone,
      },
      lastScanAt: producer.lastScanAt,
      pollIntervalMs: config.pollIntervalMs,
    };
  };

  const app = createServer({ config, wa, producer, sources, controls, getStats }, logger);
  const server = app.listen(config.port, () => logger.info(`Dashboard: http://localhost:${config.port}`));

  await wa.start();
  producer.start();

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Mematikan service...');
    producer.stop();
    server.close();
    await worker.close().catch(() => {});
    await wa.stop();
    await queue.close().catch(() => {});
    await redis.quit().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'Gagal start');
  process.exit(1);
});

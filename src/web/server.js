'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { bus, recentActivity } = require('../activity');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function basicAuth(user, password) {
  return (req, res, next) => {
    const [scheme, b64] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && b64) {
      const [u, ...rest] = Buffer.from(b64, 'base64').toString('utf8').split(':');
      if (safeEqual(u, user) && safeEqual(rest.join(':'), password)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Tracer WA", charset="UTF-8"').status(401).send('Login diperlukan');
  };
}

/** Header kustom memaksa preflight CORS, jadi situs lain tidak bisa menekan tombol via CSRF. */
function requireDashboardHeader(req, res, next) {
  if (req.get('X-Dashboard') === '1') return next();
  res.status(403).json({ error: 'Header X-Dashboard wajib' });
}

function createServer({ config, wa, producer, sources, controls, getStats }, logger) {
  const log = logger.child({ module: 'web' });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true, wa: wa.state.status }));

  // Webhook Apps Script: hanya memicu scan, tidak memakai isi payload.
  app.post('/webhook/sheet', (req, res) => {
    if (!config.webhookSecret || !safeEqual(req.get('X-Webhook-Secret') || '', config.webhookSecret)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    producer.trigger('webhook');
    res.json({ ok: true });
  });

  const auth = basicAuth(config.dashboard.user, config.dashboard.password);
  app.use(auth);
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  // ── Server-Sent Events: status WA, QR, statistik, aktivitas ──
  const clients = new Set();
  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event, data) => { for (const res of clients) send(res, event, data); };

  app.get('/events', async (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    clients.add(res);
    send(res, 'info', { sheetUrl: `https://docs.google.com/spreadsheets/d/${config.sheets.spreadsheetId}/edit` });
    send(res, 'wa', wa.state);
    send(res, 'activity-list', recentActivity());
    send(res, 'stats', await getStats().catch(() => null));
    req.on('close', () => clients.delete(res));
  });

  wa.on('state', (s) => broadcast('wa', s));
  bus.on('activity', (a) => broadcast('activity', a));
  setInterval(async () => {
    if (clients.size) broadcast('stats', await getStats().catch(() => null));
  }, 5000).unref();
  setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

  // ── Aksi dashboard ──
  const action = (fn) => async (_req, res) => {
    try {
      await fn();
      res.json({ ok: true });
    } catch (err) {
      log.error({ err }, 'Aksi dashboard gagal');
      res.status(500).json({ error: err.message });
    }
  };
  app.get('/api/status', async (_req, res) => res.json({ wa: wa.state, stats: await getStats() }));
  app.post('/api/logout', requireDashboardHeader, action(() => wa.logout()));
  app.post('/api/reset-session', requireDashboardHeader, action(() => wa.resetSession()));
  app.post('/api/reconnect', requireDashboardHeader, action(() => wa.reconnect()));
  app.post('/api/queue/pause', requireDashboardHeader, action(() => controls.pause()));
  app.post('/api/queue/resume', requireDashboardHeader, action(() => controls.resume()));
  app.post('/api/scan', requireDashboardHeader, action(() => producer.scan('manual')));

  // ── Sumber data: pilihan sheet aktif ──
  app.get('/api/sheets', async (req, res) => {
    try {
      res.json(await sources.describe(req.query.refresh === '1'));
    } catch (err) {
      log.error({ err }, 'Gagal memuat daftar sheet');
      res.status(502).json({ error: `Gagal memuat daftar sheet: ${err.message}` });
    }
  });
  app.post('/api/sheets', requireDashboardHeader, async (req, res) => {
    try {
      await sources.set(req.body?.sheets);
      producer.trigger('ganti sheet');
      res.json(await sources.describe());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return app;
}

module.exports = { createServer };

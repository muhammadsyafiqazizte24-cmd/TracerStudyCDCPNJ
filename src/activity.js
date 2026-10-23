'use strict';
/**
 * Bus aktivitas in-memory untuk dashboard (ring buffer 100 entri terakhir).
 * Log lengkap tetap ditulis ke terminal lewat pino.
 */
const { EventEmitter } = require('events');

const bus = new EventEmitter();
const recent = [];

function activity(level, message, meta = {}) {
  const entry = { at: new Date().toISOString(), level, message, ...meta };
  recent.unshift(entry);
  if (recent.length > 100) recent.pop();
  bus.emit('activity', entry);
  return entry;
}

module.exports = { bus, activity, recentActivity: () => recent.slice(0, 50) };

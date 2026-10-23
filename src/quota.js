'use strict';
const { randInt } = require('./utils/time');

/** Kuota rolling 24 jam memakai sorted set Redis (score = timestamp kirim). */
const KEY = 'wa:sent_log';
const DAY = 24 * 60 * 60 * 1000;

async function usage(redis) {
  await redis.zremrangebyscore(KEY, 0, Date.now() - DAY);
  return redis.zcard(KEY);
}

/** 0 bila masih ada slot; selain itu ms sampai slot tertua kedaluwarsa (+1–5 menit acak). */
async function msUntilSlot(redis, limit) {
  const used = await usage(redis);
  if (used < limit) return 0;
  const idx = used - limit; // entri yang harus kedaluwarsa agar used < limit
  const [, score] = await redis.zrange(KEY, idx, idx, 'WITHSCORES');
  return Math.max(0, Number(score) + DAY - Date.now()) + randInt(60000, 300000);
}

async function record(redis, id) {
  const now = Date.now();
  await redis.zadd(KEY, now, `${now}:${id}`);
}

module.exports = { usage, msUntilSlot, record };

'use strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    year: get('year'), month: get('month'), day: get('day'),
    hour: Number(get('hour')), minute: Number(get('minute')), second: get('second'),
  };
}

/** "23/10/2026 14:05:09" pada zona waktu lokal. */
function formatLocal(date, timeZone) {
  const p = localParts(date, timeZone);
  const hh = String(p.hour).padStart(2, '0');
  const mm = String(p.minute).padStart(2, '0');
  return `${p.day}/${p.month}/${p.year} ${hh}:${mm}:${p.second}`;
}

/** 0 jika sekarang di dalam jam kirim; selain itu ms sampai jam kirim berikutnya (+0–10 menit acak). */
function msUntilSendWindow(date, { sendWindowStart, sendWindowEnd, timezone }) {
  if (sendWindowStart === 0 && sendWindowEnd === 24) return 0;
  const p = localParts(date, timezone);
  const nowMin = p.hour * 60 + p.minute;
  const start = sendWindowStart * 60;
  const end = sendWindowEnd * 60;
  if (nowMin >= start && nowMin < end) return 0;
  const waitMin = (start - nowMin + 1440) % 1440;
  return waitMin * 60000 + randInt(0, 10) * 60000;
}

function greetingFor(date, timeZone) {
  const h = localParts(date, timeZone).hour;
  if (h < 11) return 'Selamat pagi';
  if (h < 15) return 'Selamat siang';
  if (h < 18) return 'Selamat sore';
  return 'Selamat malam';
}

module.exports = { sleep, randInt, formatLocal, msUntilSendWindow, greetingFor };

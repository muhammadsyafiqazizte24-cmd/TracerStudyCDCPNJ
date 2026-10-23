'use strict';

/**
 * Normalisasi nomor ke format E.164 tanpa "+" (contoh: 6281234567890).
 * Menerima: 0812..., 812..., 62812..., +62 812-..., 620812..., serta nomor
 * internasional lain bila diawali "+".
 * Mengembalikan null bila tidak valid — termasuk angka berformat ilmiah
 * (6.28E+12) karena digitnya sudah hilang dan berisiko salah kirim.
 */
function normalizePhone(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s || /e[+-]?\d+$/i.test(s)) return null;

  const hadPlus = s.startsWith('+');
  let d = s.replace(/\D/g, '');
  if (!d) return null;

  if (d.startsWith('00')) d = d.slice(2);
  if (!hadPlus) {
    if (d.startsWith('0')) d = '62' + d.slice(1);
    else if (d.startsWith('8')) d = '62' + d;
  }
  if (d.startsWith('620')) d = '62' + d.slice(3);

  if (d.startsWith('62')) return /^628\d{7,11}$/.test(d) ? d : null;
  return hadPlus && /^[1-9]\d{7,14}$/.test(d) ? d : null;
}

module.exports = { normalizePhone };

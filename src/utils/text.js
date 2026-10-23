'use strict';

/** Title Case untuk nama yang diketik ALL CAPS / huruf kecil semua. */
function titleCase(name) {
  const s = String(name || '').trim().replace(/\s+/g, ' ');
  if (!s) return s;
  const mixed = s !== s.toUpperCase() && s !== s.toLowerCase();
  if (mixed) return s; // hormati penulisan asli bila sudah campuran
  return s.toLowerCase().replace(/(^|[\s'\-.])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}

const eqStatus = (a, b) => String(a || '').trim().toLowerCase() === String(b).toLowerCase();

module.exports = { titleCase, eqStatus };

'use strict';
const fs = require('fs');
const { greetingFor } = require('./utils/time');
const { titleCase } = require('./utils/text');

/**
 * Spintax: {a|b|c} dipilih acak, mendukung nesting.
 * Variabel {Nama} {Jurusan} {Link} {Salam} {Pengirim} diamankan dulu menjadi
 * token, baru spintax diputar, lalu token diisi nilai. Jadi isi data alumni
 * (mis. nama yang mengandung "|" atau "{") tidak pernah ikut diputar.
 */
const TOKEN = '\u0000';

function spin(text) {
  const innermost = /\{([^{}]*\|[^{}]*)\}/;
  let out = text;
  for (let guard = 0; innermost.test(out) && guard < 1000; guard++) {
    out = out.replace(innermost, (_, body) => {
      const options = body.split('|');
      return options[Math.floor(Math.random() * options.length)];
    });
  }
  return out;
}

function render(template, vars) {
  let t = template.replace(/\{\s*([A-Za-z_]\w*)\s*\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? `${TOKEN}${key}${TOKEN}` : m,
  );
  t = spin(t);
  t = t.replace(new RegExp(`${TOKEN}([A-Za-z_]\\w*)${TOKEN}`, 'g'), (_, key) => String(vars[key] ?? ''));
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Template dibaca ulang tiap pesan, jadi bisa diedit tanpa restart. */
function buildTracerMessage({ name, major }, { templateFile, surveyUrl, signature }, timezone) {
  const template = fs.readFileSync(templateFile, 'utf8');
  return render(template, {
    Nama: titleCase(name),
    Jurusan: String(major || '').trim(),
    Link: surveyUrl,
    Salam: greetingFor(new Date(), timezone),
    Pengirim: signature,
  });
}

module.exports = { spin, render, buildTracerMessage };

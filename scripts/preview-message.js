'use strict';
// Pratinjau variasi pesan tanpa mengirim: npm run preview -- "BUDI SANTOSO" "Teknik Informatika" 5
process.env.DASHBOARD_PASSWORD ||= 'preview';
process.env.GOOGLE_APPLICATION_CREDENTIALS ||= 'x';
process.env.GOOGLE_SPREADSHEET_ID ||= 'x';
process.env.SURVEY_URL ||= 'https://contoh.ac.id/tracer';
const { config } = require('../src/config');
const { buildTracerMessage } = require('../src/template');

const [name = 'BUDI SANTOSO', major = 'Teknik Informatika', n = '3'] = process.argv.slice(2);
for (let i = 0; i < Number(n); i++) {
  console.log(`──── Variasi ${i + 1} ────`);
  console.log(buildTracerMessage({ name, major }, config.message, config.safety.timezone), '\n');
}

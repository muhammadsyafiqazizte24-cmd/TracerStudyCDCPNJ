/**
 * Webhook opsional: mempercepat deteksi tanpa menunggu siklus polling.
 * Backend tetap membaca ulang sheet, jadi payload ini hanya "ketukan pintu".
 *
 * Pasang: Extensions → Apps Script → tempel file ini → isi CONFIG →
 * Triggers (ikon jam) → Add Trigger → fungsi: handleEdit, event: On edit.
 * (Harus installable trigger; simple onEdit() tidak boleh memanggil UrlFetchApp.)
 */
const CONFIG = {
  WEBHOOK_URL: 'https://wa.contoh.ac.id/webhook/sheet',
  WEBHOOK_SECRET: 'samakan-dengan-WEBHOOK_SECRET-di-.env',
  SHEET_NAME: 'Sheet1',
  STATUS_COLUMN: 5, // E
  TRIGGER_VALUE: 'Kirim Tracer',
};

function handleEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  if (sheet.getName() !== CONFIG.SHEET_NAME) return;

  const col = e.range.getColumn();
  const lastCol = col + e.range.getNumColumns() - 1;
  if (CONFIG.STATUS_COLUMN < col || CONFIG.STATUS_COLUMN > lastCol) return;

  // Edit satu sel: cek nilainya. Edit banyak sel (paste/drag): langsung ketuk.
  if (e.range.getNumRows() === 1 && e.range.getNumColumns() === 1 && e.value !== CONFIG.TRIGGER_VALUE) return;

  UrlFetchApp.fetch(CONFIG.WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Webhook-Secret': CONFIG.WEBHOOK_SECRET },
    payload: JSON.stringify({ row: e.range.getRow() }),
    muteHttpExceptions: true,
  });
}

# Tracer WA Dispatch

Engine pengiriman WhatsApp Tracer Study: **Google Sheets → BullMQ (Redis) → Baileys**, plus dashboard web untuk scan QR dan memantau antrean.

## Alur singkat

1. Petugas memilih **Kirim Tracer** di kolom E.
2. Producer (polling tiap `POLL_INTERVAL_MS`, atau seketika via webhook Apps Script) memvalidasi nomor ke E.164, mengubah status jadi **Antre**, lalu memasukkan job ke queue.
3. Worker (concurrency 1) memproses satu per satu: cek jam kirim → cek kuota 24 jam → pastikan koneksi `open` → jeda acak 30–65 detik → cek baris masih **Antre** → `onWhatsApp` → "mengetik…" 3–6 detik → jeda 1–2 detik → `sendMessage`.
4. Hasil ditulis balik: **Terkirim** + waktu di kolom F, atau **Gagal** + alasan di kolom G.

## Persiapan Google Sheets

| Kolom | Isi |
|---|---|
| A | Timestamp |
| B | Nama Lengkap |
| C | Jurusan |
| D | Nomor WhatsApp (08xx / 628xx / +kode negara) |
| E | Status — Data Validation: `Draft, Kirim Tracer, Antre, Terkirim, Gagal` |
| F | Waktu Terkirim |
| G | Keterangan (baru, diisi otomatis alasan gagal) |

Kolom G dipakai agar nilai kolom E tetap persis salah satu opsi dropdown. Jika tidak mau kolom G, kosongkan `SHEET_DETAIL_COLUMN` — alasan akan ditulis di E sebagai `Gagal (Tidak Terdaftar di WA)`, dan Data Validation kolom E perlu diset ke "Show warning", bukan "Reject input".

Format kolom D sebagai **Plain text** agar angka 0 di depan tidak hilang (engine tetap bisa menangani `8123…` tanpa 0, tetapi menolak notasi ilmiah `6.28E+12` karena digitnya sudah rusak).

**Service Account:** buat di Google Cloud Console, aktifkan Google Sheets API, unduh JSON ke `credentials/service-account.json`, lalu **share spreadsheet ke email service account sebagai Editor**.

## Menjalankan

```bash
cp .env.example .env        # isi DASHBOARD_PASSWORD, GOOGLE_SPREADSHEET_ID, SURVEY_URL, dst.
npm install
npm run preview -- "BUDI SANTOSO" "Teknik Informatika" 5   # cek variasi pesan, tanpa kirim
npm start                    # butuh Redis berjalan
```

Buka `http://localhost:3000`, login dengan `DASHBOARD_USER`/`DASHBOARD_PASSWORD`, lalu scan QR dari HP pengirim (WhatsApp → Perangkat tertaut).

**Docker:** `docker compose up -d --build`. **PM2:** `pm2 start ecosystem.config.cjs`. Apa pun caranya, **jalankan hanya satu instance** — dua proses dengan sesi yang sama akan saling menendang.

Dashboard memberi akses penuh ke akun WhatsApp (siapa pun yang melihat QR bisa menautkan nomor), jadi taruh di belakang reverse proxy HTTPS dan gunakan password kuat. Port di docker-compose sengaja hanya bind ke `127.0.0.1`.

## Webhook Apps Script (opsional)

Salin `apps-script/webhook.gs` ke Apps Script spreadsheet, isi `WEBHOOK_URL` dan `WEBHOOK_SECRET`, lalu pasang **installable trigger** `handleEdit` (On edit). Webhook hanya memicu scan; sheet tetap sumber kebenaran, jadi polling tetap berjalan sebagai cadangan.

## Template pesan

Edit `templates/tracer.txt` (dibaca ulang tiap pesan, tidak perlu restart). Variabel: `{Nama}` `{Jurusan}` `{Link}` `{Salam}` `{Pengirim}`. Spintax `{a|b|c}` bisa bertingkat. `{Salam}` otomatis Selamat pagi/siang/sore/malam sesuai jam WIB — menggantikan "Selamat pagi/siang" di PRD yang akan terkirim apa adanya.

## Perilaku penting

| Situasi | Perilaku |
|---|---|
| Nomor tidak valid / nama kosong | Langsung **Gagal** saat scan, tidak masuk queue |
| Nomor sama dua kali di satu batch | Baris kedua **Gagal** (nomor ganda) |
| Tidak terdaftar di WA | **Gagal**, keterangan "Tidak Terdaftar di WA", tanpa retry |
| Error jaringan saat kirim | Retry `JOB_ATTEMPTS` kali (backoff eksponensial), lalu **Gagal** |
| Status diubah dari Antre (mis. ke Draft) sebelum giliran | Job dilewati = cara membatalkan |
| Baris bergeser karena sisip/urut | Baris dicari ulang lewat nomor HP |
| Kuota 24 jam penuh / di luar jam kirim | Job ditunda (tidak dihitung sebagai attempt) |
| Koneksi close | `queue.pause()`, reconnect backoff, `queue.resume()` saat open |
| Logged out / kode 403 / 440 / reconnect gagal berulang | Antrean berhenti total, alert di terminal + dashboard |
| Crash setelah pesan terkirim | Penanda di Redis mencegah kirim ulang saat job diulang |
| Update sheet gagal setelah kirim | Dicatat sebagai error, **tidak** memicu kirim ulang |

## Tambahan di luar PRD

Jam kirim (`SEND_WINDOW_START/END`, default 08–20 WIB), kolom Keterangan, deteksi nomor ganda, pembatalan via status, tombol jeda/lanjut antrean, dan pencarian ulang baris. Kuota dihitung **rolling 24 jam**, bukan reset tengah malam.

## Struktur

```
src/
  index.js              wiring & lifecycle
  config.js             ENV + validasi aturan anti-ban
  whatsapp/client.js    Baileys: sesi, QR, reconnect, kirim + presence
  sheets/sheets.js      Google Sheets API (service account)
  queue/producer.js     deteksi baris "Kirim Tracer" → job
  queue/worker.js       consumer: jitter, kuota, validasi, kirim, callback
  template.js           spintax + variabel
  quota.js              kuota rolling 24 jam (Redis ZSET)
  web/server.js         Express, Basic Auth, SSE, endpoint aksi & webhook
public/index.html       dashboard
apps-script/webhook.gs  trigger opsional dari Sheets
```

Ditulis untuk `@whiskeysockets/baileys` 6.7.x (CommonJS). Baileys 7 bersifat ESM-only dan punya perubahan API, jadi jangan upgrade major tanpa penyesuaian.

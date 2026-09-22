# achclip — Backend YouTube Downloader

Project ini sekarang punya server sendiri (bukan HTML statis lagi). Server pakai
`yt-dlp` untuk ambil video YouTube secara reliable, lalu mengirim video itu balik
ke HP kamu supaya proses selanjutnya (upload ke Gemini, render clip) tetap jalan
seperti biasa.

## Cara Deploy ke Railway (dari HP, lewat browser)

1. **Upload ke GitHub**
   - Buat repo baru (atau update repo `achclip` yang lama).
   - Upload semua file di folder ini: `Dockerfile`, `package.json`, `server.js`,
     dan folder `public/` (isinya `index.html`).

2. **Deploy di Railway**
   - Buka Railway → New Project → Deploy from GitHub repo → pilih repo tadi.
   - Railway otomatis mendeteksi `Dockerfile` dan build servernya (ada `ffmpeg`
     + `yt-dlp` di dalamnya, proses build sekitar 2-4 menit).
   - Setelah deploy selesai, buka tab **Settings → Networking → Generate Domain**
     kalau domain publik belum otomatis muncul.

3. **(Sangat disarankan) Deploy PO Token Provider**
   YouTube kadang menolak yt-dlp dengan error "Sign in to confirm you're not a
   bot". Supaya lebih tahan lama, deploy service tambahan ini di project
   Railway yang sama:
   - New Service → Deploy from Docker Image → masukkan image:
     `brainicism/bgutil-ytdlp-pot-provider`
   - Setelah service ini hidup, buka Settings-nya, catat **domain internal**
     Railway-nya (format: `http://<nama-service>.railway.internal:4416`).
   - Kembali ke service `achclip` (backend utama), buka tab **Variables**,
     tambahkan:
     ```
     POT_PROVIDER_URL=http://<nama-service>.railway.internal:4416
     ```
   - Redeploy service `achclip` supaya variable-nya kepakai.

   Kalau kamu masih punya service PO token provider dari project lama
   (`clipai-newup`) yang masih hidup, tinggal pakai ulang domain internalnya —
   tidak perlu deploy baru.

4. **Selesai** — buka domain publik `achclip`-mu, isi API Key Gemini seperti
   biasa, lalu coba paste link YouTube. Video sekarang diunduh oleh server
   (bukan browser HP), jadi jauh lebih stabil dibanding sebelumnya.

## Bagaimana alurnya sekarang

1. HP kamu kirim link YouTube ke server (`POST /api/youtube/start`).
2. Server jalanin `yt-dlp` buat download video (maks 720p, maks 25 menit).
3. HP polling status tiap 2 detik (`GET /api/youtube/status/:id`) — progress
   unduhan & thumbnail otomatis muncul.
4. Setelah selesai, HP ambil file videonya dari server sendiri
   (`GET /api/youtube/file/:id`) — ini cepat & stabil karena satu jaringan,
   bukan proxy publik yang suka down.
5. Dari sini alurnya sama seperti upload video lokal: video di-upload ke
   Gemini Files API dari browser, lalu proses AI & render clip jalan seperti
   biasa.

## Catatan

- Video di server otomatis dihapus setelah terkirim ke HP (atau maksimal
  45 menit kalau gagal/tidak diambil), jadi disk server tidak penuh.
- Kalau video sumbernya private/unlisted, pastikan link-nya bisa diakses
  tanpa login (yt-dlp jalan tanpa cookies di setup ini).

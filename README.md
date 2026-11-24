<p align="center">
  <a href="https://github.com/evlskyy/spas1-hybrid">
    <img src="./assets/spas1-mark.png" alt="Logo SPAS1" width="112">
  </a>
</p>

<h1 align="center">SPAS1 Hybrid</h1>

<p align="center">
  Jalur pengembangan terpisah dari SPAS1 v2 untuk aplikasi operasional multi-SPPG.
</p>

<p align="center">
  <a href="https://github.com/evlskyy/spas1-hybrid"><img src="https://img.shields.io/badge/Repository-spas1--hybrid-2563eb?style=for-the-badge" alt="Repository SPAS1 Hybrid"></a>
</p>

<p align="center">
  <a href="https://github.com/evlskyy/spas1-hybrid/stargazers"><img src="https://img.shields.io/github/stars/evlskyy/spas1-hybrid?style=social" alt="GitHub stars"></a>
  <a href="https://github.com/evlskyy/spas1-hybrid/network/members"><img src="https://img.shields.io/github/forks/evlskyy/spas1-hybrid?style=social" alt="GitHub forks"></a>
</p>

<p align="center">
  <strong>Cloudflare Pages</strong> · <strong>Supabase</strong> · <strong>HTML, CSS &amp; JavaScript</strong>
</p>

---

SPAS1 menyatukan alur menu dan gizi, stok logistik, absensi relawan, persiapan, distribusi, serta administrasi dalam satu aplikasi web. Frontend statis berjalan di Cloudflare Pages, sementara autentikasi dan data operasional menggunakan Supabase.

> Repo ini dikembangkan terpisah dari `spas1-v2`. Fitur isolasi multi-SPPG, migrasi database, dan deployment hybrid.

## Fitur utama

- Perencanaan menu harian dan Bank Menu.
- Registrasi relawan, persetujuan admin, login, dan pencatatan absensi.
- Pengelolaan logistik dapur dan stok.
- Modul persiapan, distribusi, anggaran, HACCP, serta poster AKG.
- Pengelolaan konten publik dan media situs.
- Tutorial penggunaan yang diperbarui untuk layar ponsel, tampilan modul yang diselaraskan, serta halaman pemeliharaan.

## Arsitektur

Frontend merupakan situs statis yang disajikan melalui Cloudflare Pages. Supabase menyediakan autentikasi, database, penyimpanan, dan Edge Function untuk registrasi relawan. Backend Apps Script dan Spreadsheet versi sebelumnya tidak digunakan.

## Deployment dan konfigurasi

- Nama project Cloudflare Pages yang direncanakan: `spas1-hybrid`.
- Domain baru belum ditentukan. Domain `spas1.my.id` tetap untuk aplikasi lama.
- Referensi project Supabase diatur di `index.html`; publishable key memang bersifat publik.
- Edge Function registrasi relawan memerlukan secret `TURNSTILE_SECRET_KEY` di Supabase. Jangan masukkan secret ini ke kode frontend atau commit ke Git.
- Origin browser yang diizinkan diatur dengan `APP_ALLOWED_ORIGINS`; nilai bawaan hanya `https://spas1-hybrid.pages.dev`. Origin localhost HTTP(S) juga diizinkan untuk pengembangan lokal, tetapi aksi terautentikasi tetap memerlukan sesi yang valid.
- Skema database dan Row Level Security (RLS) dijelaskan di `supabase_migration.sql`. Tinjau perubahan dan cadangkan data sebelum menerapkannya ke project lain.

### Status Multi-SPPG

- Draf isolasi tenant ada di `supabase_multisppg_migration.sql`. Fungsi stok pada `supabase_migration.sql` bergantung pada helper yang dibuat oleh migrasi tersebut, jadi kedua migrasi harus dirilis sebagai satu perubahan terkoordinasi setelah semua tes dan backend siap.
- `supabase_stock_conversion_migration.sql` juga memerlukan helper tenant tersebut; jangan jalankan sendiri pada database lama.
- `supabase/staging_schema_baseline.sql` adalah snapshot skema `public` tanpa baris data, disiapkan untuk project uji `SPAS1-Hybrid`. Jangan jalankan file ini pada `SPAS1-Database` atau project produksi.
- Bootstrap staging `SPAS1-Hybrid` sudah selesai: baseline, migrasi tenant, operasional, stok, dan AboutSky telah diterapkan; tiga Edge Functions juga telah dideploy. `supabase/staging_verify.sql` memeriksa tabel tenant, RLS, helper, dan bucket secara read-only.
- Konfigurasi frontend staging kini menunjuk ke project baru. Turnstile dan Auth sudah disetel untuk Pages staging; alur onboarding multi-SPPG baru tetap harus diuji sebelum rilis. Project Supabase lama dan domain `spas1.my.id` tidak diubah.
- Untuk uji staging, urutannya: baseline, `supabase_multisppg_migration.sql`, `supabase_migration.sql`, `supabase_stock_conversion_migration.sql`, `supabase/aboutsky_migration.sql`, lalu `supabase/tenant_empty_defaults_migration.sql`. Migrasi terakhir memeriksa membership, data operasional, dan file Storage tenant lama; migrasi berhenti tanpa menghapus tenant lama jika masih ada yang harus dipindahkan. Jangan jalankan `supabase_bank_menu_sppg_import.sql` sebagai bagian bootstrap karena file tersebut mengimpor data.
- Gunakan `spas1-hybrid.pages.dev` untuk deployment dan uji staging. Set `MAINTENANCE_MODE=false` pada environment Cloudflare Pages ketika siap diuji. Jangan alihkan domain produksi sebelum semua pengujian staging lulus.

### AboutSky

Halaman Tentang Saya [iamSkyy](https://www.instagram.com/iamskyy/)


### Stok dan pemakaian dapur

- SUPER ADMIN mencatat pembelian dan pengeluaran gudang pada tab `Stok & Nota`, termasuk hari kerja, jumlah barang, snapshot stok, foto bukti bertanda waktu, dan lokasi. Modul logistik hanya menampilkan pembelian pada Senin–Jumat di minggu yang dipilih.
- Koki mencatat pemakaian harian dari setiap pengeluaran gudang. Sisa barang disimpan sebagai stok dapur dan tidak menambah stok gudang. Terapkan `supabase_migration.sql` terbaru sebelum menggunakan alur ini; migrasi tersebut membuat tabel pergerakan stok, pemakaian harian dapur, dan fungsi database terkait.
- `Pemakaian Koki` menyediakan folder simulasi berbasis Supabase untuk catatan satuan campuran (misalnya 1 dus = 12 bungkus), pemakaian dua satuan, perhitungan sisa ekuivalen, pengubahan nama folder, simpan/draf, penambahan bahan, dan penghapusan entri keliru. Setelah disimpan, formulir dikosongkan dan detail folder tujuan dibuka. Folder dapat digunakan lintas perangkat oleh pengguna yang sudah login.
- Draf demo yang hanya tersimpan di browser tetap tersedia dan dapat disalin ke Supabase melalui **Impor Draf Lokal Lama**. Pengembalian simulasi dicatat di tabel khusus demo stok dan tidak menambah stok gudang aktif. Alur `Stok & Nota` mencatat pergerakan stok nyata; batalkan pergerakan nyata melalui audit stok agar jejak audit tetap tersimpan. Terapkan `supabase_migration.sql` terbaru sebelum memakai folder simulasi cloud.

### Akuntan dan laporan

- Menu Akuntan menyediakan **Audit & Riwayat Transaksi Stok**, **Stok & Nota**, **Folder LPDH & LPJ**, **LPDH Harian**, dan **LPJ**.
- Audit stok membandingkan jumlah masuk/keluar aktif berdasarkan satuan, tidak menghitung transaksi yang dibatalkan, dan menyediakan cetak A4 landscape berlatar putih tanpa overlay aplikasi. LPJ dicetak dalam beberapa halaman A4 landscape.
- LPDH Harian mencatat porsi penerima manfaat, belanja per kategori, bukti nota privat, saldo awal/top-up/akhir, serta nama penanggung jawab dan akuntan untuk cetak. Ekspor Excel, CSV, PDF, dan cetak tersedia. Terapkan `supabase_migration.sql` terbaru untuk membuat tabel laporan khusus admin, bucket nota privat, dan kolom nama tanda tangan.
- LPJ mendukung pengisian dan penyuntingan delapan lembar kerja, nama pribadi bawaan `Anonymous`, penyimpanan Supabase per tanggal, serta ekspor Excel/PDF dan cetak.
- **Folder LPDH & LPJ** mengelompokkan laporan berdasarkan tanggal menggunakan tabel Supabase yang sudah ada. Setiap folder membuka laporan LPDH/LPJ yang tersedia; bukti nota LPDH tetap berada di bucket privat. Penyimpanan laporan memperbarui arsip tanpa memerlukan tabel folder atau migrasi baru.
- LPDH dan LPJ mendukung gambar tanda tangan untuk cetak dan ekspor Excel/PDF. Tanda tangan ini bersifat visual, bukan tanda tangan elektronik berbasis sertifikat. Terapkan `supabase_migration.sql` terbaru untuk penyimpanan tanda tangan LPDH dan tabel LPJ khusus admin.

### Modul dan administrasi

- Pendaftaran SPPG memverifikasi Turnstile, langsung membuat tenant kosong, lalu mengirim undangan admin pertama. Public signup Supabase tetap nonaktif; SMTP dan URL redirect undangan harus dikonfigurasi agar admin dapat membuat password. Relawan memilih SPPG aktif pada formulir dan akun menunggu persetujuan admin SPPG tersebut. Migrasi tenant-empty-defaults harus diterapkan sebelum alur ini dirilis.
- Sidebar SUPER ADMIN mengelompokkan **Konten & Tautan Situs**, **Laporan**, **Relawan**, dan **Registrasi** di bawah **SUPER AKSES**, di atas menu **Akuntan**. Tab **Permohonan SPPG** hanya untuk akun dengan klaim admin platform dan dipakai untuk meninjau permohonan lama. Tata letak cetak absensi dan relawan menggunakan halaman landscape dengan warna yang aman untuk dicetak.
- Setelah login SUPER ADMIN pertama kali di suatu browser, layar **Welcome to SUPER SPAS1** menanyakan peran seperti Kepala SPPG, Ahli Gizi, Akuntan, Aslap, Head Chef, dan Admin. Setelah itu animasi robot chibi neon dengan logo S SPAS1 menyapa pengguna. Jawaban hanya untuk hiburan, tidak mengubah hak akses dan tidak disimpan; penanda sekali tampil disimpan di local storage browser dan akan muncul lagi jika data browser dihapus.
- **SUPER GIZI** menyediakan kalkulator AKG per porsi. Masukkan berat bahan per porsi dan nilai zat gizi terverifikasi per 100 g; kalkulator menghitung energi, protein, lemak, karbohidrat, serat, vitamin A/C, kalsium, dan zat besi serta kontribusi kategori dan persentase terhadap target yang dapat diubah.
- Dasbor SUPER GIZI menampilkan diagram donat kontribusi energi, kartu makronutrien, progres target zat gizi, dan tiga kontribusi tertinggi. Cetak/PDF memakai tata letak ringkas berlatar putih. Target energi 2.150 kkal hanya contoh ilustratif, bukan target universal; operator harus menyediakan data komposisi bahan sendiri karena aplikasi tidak menyertakan database gizi.
- Data kalkulator disimpan di local storage browser/perangkat, bukan Supabase, sehingga hanya tersedia pada browser tersebut. Ekspor CSV dan cetak/PDF tersedia; tidak diperlukan migrasi database.
- **READ INFO PROJECT** memuat **Tutorial Penggunaan Aplikasi** berisi panduan halaman publik, absensi relawan, Bank Menu, logistik, persiapan/distribusi, SUPER ADMIN, Akuntan, ekspor, serta kendala akses dan data.
- Perubahan field pendaftaran relawan, ID/draf absensi, dan kontrol edit/hapus administrator memerlukan migrasi SQL yang sesuai serta Edge Function `volunteer-registration` versi terbaru sebelum frontend diperbarui. Profil relawan dinonaktifkan, bukan dihapus, agar riwayat absensi tetap terjaga.

### Mode pemeliharaan

Middleware Cloudflare Pages di `functions/_middleware.js` membaca variabel lingkungan `MAINTENANCE_MODE`. Saat pemeliharaan aktif, middleware menyajikan [`maintenance.html`](./maintenance.html) dengan HTTP 503 pada project Pages ini. Halaman menggunakan logo SPAS1 dan ilustrasi anak berlisensi yang disediakan di folder `assets/`.

Atur `MAINTENANCE_MODE` menjadi `false` pada environment produksi project Cloudflare Pages untuk menonaktifkan pemeliharaan. Atur menjadi `true` atau hapus variabel tersebut untuk mengaktifkannya. Deploy project setelah mengubah variabel agar pengaturan baru berlaku.

## Lisensi

Repository ini bukan open source. Penggunaan, penyalinan, modifikasi, atau distribusi kode memerlukan izin tertulis terlebih dahulu. Lihat [`LICENSE.md`](./LICENSE.md) atau hubungi [iamsky](mailto:hallosky@spas1.my.id) untuk meminta izin.

## Pengembang

- Penulis: **iamsky**
- Peran: Programmer; Full Stack Developer Android & iOS
- Foto profil: [Skyy (iamsky)](assets/skyyabout.jpeg)
- Repository: [evlskyy/spas1-hybrid](https://github.com/evlskyy/spas1-hybrid)
- GitHub: [evlskyy](https://github.com/evlskyy)
- Email: [hallosky@spas1.my.id](mailto:hallosky@spas1.my.id)
- Instagram: [@evlskyy](https://instagram.com/evlskyy)
- Trakteer: [Dukung project ini](https://teer.id/evlskyy)

© 2026 SPAS1 Project. Crafted.Sky with ❤️

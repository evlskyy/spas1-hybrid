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
- Pendaftaran SPPG dengan pilihan wilayah berantai Provinsi → Kabupaten/Kota → Kecamatan.
- Pengelolaan logistik dapur dan stok.
- Modul persiapan, distribusi, anggaran, HACCP, serta poster AKG.
- Pengelolaan konten publik dan media situs.
- Tutorial penggunaan yang diperbarui untuk layar ponsel, tampilan modul yang diselaraskan, serta halaman pemeliharaan.
- SUPER ADMIN dapat mengubah tampilan seluruh aplikasi melalui **Pengaturan → Tampilan & Font**: Candy Modern, Classic Linux, Classic Windows, Retro Browser, font Mac OS atau Linux standar. Pilihan dapat dipratinjau dahulu, lalu disimpan dengan tombol **Terapkan**. Mode terang/gelap dapat ditoggle terpisah dari preset dan akan diingat saat halaman dibuka ulang. Preferensi disimpan lokal di browser dan tidak mengubah tampilan pengguna lain.
- Mode tema tidak diterapkan ke hasil cetak: halaman cetak menggunakan kertas putih, teks standar, dan kartu About Skyy tidak ikut tercetak dari SUPER ADMIN.
- Kartu, border, latar, dan keterbacaan teks mengikuti preset di seluruh modul; halaman 404 responsif di ponsel. Kamera Absensi menampilkan dan menyimpan foto tanpa mirror, hanya tersedia melalui HTTPS/localhost dengan izin kamera browser.

## Arsitektur

Frontend merupakan situs statis yang disajikan melalui Cloudflare Pages. Supabase menyediakan autentikasi, database, penyimpanan, dan Edge Function untuk registrasi relawan. Backend Apps Script dan Spreadsheet versi sebelumnya tidak digunakan.

### PWA dan penggunaan offline

Setelah perubahan PWA dipublikasikan di host HTTPS, pengguna dapat memasang SPAS1 Hybrid dari browser. Di Android, gunakan menu browser **Install app** atau **Add to Home screen**. Di iPhone/iPad, buka menu **Bagikan** di Safari lalu pilih **Add to Home Screen**. PWA ini adalah aplikasi web yang dapat dipasang, bukan APK/IPA native.

Service worker hanya menyimpan halaman informasi offline, manifest, dan ikon. Halaman aplikasi, sesi login, data Supabase, dan API tidak disimpan untuk penggunaan offline; koneksi internet tetap diperlukan untuk membuka modul dan menyinkronkan data.

Untuk menguji endpoint `/api/media` secara lokal, jalankan `npx wrangler pages dev dist --ip 127.0.0.1 --port 8788` dari folder proyek, lalu buka `http://127.0.0.1:8788`. VS Code Live Server hanya menyajikan file statis dan tidak menjalankan Cloudflare Pages Functions.

## Deployment dan konfigurasi

- Nama project Cloudflare Pages yang direncanakan: `spas1-hybrid`.
- Domain baru belum ditentukan. Domain `spas1.my.id` tetap untuk aplikasi lama.
- Referensi project Supabase diatur di `index.html`; publishable key memang bersifat publik.
- File Storage aplikasi diakses melalui proxy same-origin `/api/media`; bucket dan path dibatasi, autentikasi pengguna diteruskan ke Supabase, dan RLS tetap mengatur akses. Domain Supabase masih digunakan langsung untuk autentikasi dan database.
- Edge Function registrasi relawan memerlukan secret `TURNSTILE_SECRET_KEY` di Supabase. Jangan masukkan secret ini ke kode frontend atau commit ke Git.
- Origin browser yang diizinkan diatur dengan `APP_ALLOWED_ORIGINS`; nilai bawaan hanya `https://spas1-hybrid.pages.dev`. Origin localhost HTTP(S) juga diizinkan untuk pengembangan lokal, tetapi aksi terautentikasi tetap memerlukan sesi yang valid.
- Skema database dan Row Level Security (RLS) dijelaskan di `supabase_migration.sql`. Tinjau perubahan dan cadangkan data sebelum menerapkannya ke project lain.
- Akun login modul per relawan dikelola di SUPER AKSES → **Akun & Akses Modul**. Terapkan `supabase/module_account_access_migration.sql` setelah migrasi tenant dan skema operasional, lalu deploy Edge Function `module-account-admin`. Akun memakai username/password tersendiri dari SUPER ADMIN; relawan login dengan username singkat yang dipilih (misalnya `iamsky`), sedangkan akhiran `@module.spas1.local` hanya digunakan secara internal oleh Supabase Auth. SUPER ADMIN dapat memakai tombol **Masuk sebagai SUPER ADMIN** pada layar login modul atau membuka semua modul dengan sesi aktif, tanpa akun modul tambahan. Password diproses oleh Supabase Auth dan tidak disimpan dalam teks biasa.
- Login SUPER ADMIN mendukung username terpisah dari email pemulihan. Terapkan `supabase/admin_account_usernames_migration.sql`, lalu deploy `admin-account-auth`. Migrasi mengisi username awal dari bagian sebelum `@` dan tidak mengubah email Auth. Untuk mengganti username, admin masuk memakai email pemulihan yang sekarang dan password lama, lalu mengatur username baru di SUPER AKSES → **Pemulihan Akun**. Setelah itu username baru dan password yang sama dapat dipakai. Email tetap tidak berubah. Tautan lupa password dikirim ke email Auth terverifikasi; alamat internal `@admin.spas1.local` tidak dapat menerima email.

### Status Multi-SPPG

- Draf isolasi tenant ada di `supabase_multisppg_migration.sql`. Fungsi stok pada `supabase_migration.sql` bergantung pada helper yang dibuat oleh migrasi tersebut, jadi kedua migrasi harus dirilis sebagai satu perubahan terkoordinasi setelah semua tes dan backend siap.
- `supabase_stock_conversion_migration.sql` juga memerlukan helper tenant tersebut; jangan jalankan sendiri pada database lama.
- `supabase/staging_schema_baseline.sql` adalah snapshot skema `public` tanpa baris data, disiapkan untuk project uji `SPAS1-Hybrid`. Jangan jalankan file ini pada `SPAS1-Database` atau project produksi.
- Bootstrap staging `SPAS1-Hybrid` sudah selesai: baseline, migrasi tenant, operasional, stok, dan AboutSky telah diterapkan; tiga Edge Functions juga telah dideploy. `supabase/staging_verify.sql` memeriksa tabel tenant, RLS, helper, dan bucket secara read-only.
- `functions/api/regions.js` menyediakan proxy same-origin terbatas ke `wilayah.id` untuk pilihan wilayah pada pendaftaran SPPG. Kode dan nama wilayah disimpan terpisah dari direktori SPPG publik; RLS membatasi tabel wilayah ke admin SPPG terkait dan admin platform. Sebelum merilis form dan Edge Function yang diperbarui, tinjau dan terapkan `supabase/sppg_region_migration.sql` hanya ke project `SPAS1-Hybrid`, lalu jalankan `supabase/staging_verify.sql` untuk memeriksa kolom dan kebijakan akses.
- `supabase/sppg_onboarding_permissions_migration.sql` memberi hak CRUD hanya kepada `service_role` pada tabel yang dipakai Edge Function onboarding. Terapkan hanya ke project `SPAS1-Hybrid` bila log Edge Function menunjukkan `permission denied` pada tabel onboarding.
- Konfigurasi frontend staging kini menunjuk ke project baru. Turnstile dan Auth sudah disetel untuk Pages staging; alur onboarding multi-SPPG baru tetap harus diuji sebelum rilis. Project Supabase lama dan domain `spas1.my.id` tidak diubah.
- Untuk uji staging, urutannya: baseline, `supabase_multisppg_migration.sql`, `supabase_migration.sql`, `supabase_stock_conversion_migration.sql`, `supabase/aboutsky_migration.sql`, `supabase/tenant_empty_defaults_migration.sql`, lalu `supabase/module_account_access_migration.sql`. Migrasi tenant-empty-defaults memeriksa membership, data operasional, dan file Storage tenant lama; migrasi berhenti tanpa menghapus tenant lama jika masih ada yang harus dipindahkan. Jangan jalankan `supabase_bank_menu_sppg_import.sql` sebagai bagian bootstrap karena file tersebut mengimpor data.
- Deploy fungsi dengan `supabase functions deploy module-account-admin` dan pastikan `APP_ALLOWED_ORIGINS` memuat origin aplikasi. Migrasi akses modul menolak login lama ber-role `module` yang belum dipetakan ke akun individual; buat akun staf melalui SUPER AKSES setelah fungsi dan migrasi aktif.
- Untuk mengaktifkan pemisahan username SUPER ADMIN, jalankan `supabase/admin_account_usernames_migration.sql` setelah skema/Auth admin tersedia, kemudian deploy `supabase functions deploy admin-account-auth`. Pastikan `APP_ALLOWED_ORIGINS` menyertakan origin Pages yang dipakai. Percobaan password dibatasi per identitas selama 15 menit. Jika email Auth lama berakhiran `@admin.spas1.local`, operator harus memverifikasi pemilik melalui kanal tepercaya sebelum mengubah email pemulihan; jangan menandai email baru terverifikasi tanpa konfirmasi pemilik.
- Gunakan `spas1-hybrid.pages.dev` untuk deployment dan uji staging. Set `MAINTENANCE_MODE=false` pada environment Cloudflare Pages ketika siap diuji. Jangan alihkan domain produksi sebelum semua pengujian staging lulus.

### AboutSky

Halaman Tentang Saya [iamSkyy](https://www.instagram.com/iamskyy/)


### Stok dan pemakaian dapur

- SUPER ADMIN atau staf yang diberi hak **Modul Stok** dapat mencatat pembelian dan pengeluaran gudang pada tab `Stok & Nota`, termasuk hari kerja, jumlah barang, snapshot stok, foto bukti bertanda waktu, dan lokasi. Modul logistik hanya menampilkan pembelian pada Senin–Jumat di minggu yang dipilih.
- Nota pembelian menyediakan nomor PO otomatis, katalog pemasok per SPPG, rincian subtotal/total, pencarian barcode, dan pemindai kamera jika browser mendukung `BarcodeDetector`. Barcode yang belum dikenal tetap dapat dimasukkan dengan mengisi rincian barang secara manual; scanner USB/manual juga bisa dipakai. **Data Transaksi Pembelian** mengelompokkan nota berdasarkan tanggal nota. Edit dan pembatalan mempertahankan jejak audit serta mengoreksi stok melalui transaksi pembalik, bukan menghapus riwayat.
- **Simpan & Cetak** menghasilkan invoice pembelian atau bukti keluar gudang dengan rincian barang, tanggal, pemasok/tujuan, lokasi, status, dan tanda tangan. Dari dialog cetak browser pilih printer atau **Save as PDF**. Nota pembelian dapat dicetak ulang dari arsip transaksi; bukti keluar gudang dapat dicetak ulang dari audit stok.
- Sebelum fitur ini dipakai, tinjau lalu terapkan `supabase/purchase_order_management_migration.sql` setelah `supabase_multisppg_migration.sql`, `supabase_migration.sql`, dan `supabase/module_account_access_migration.sql`. Migrasi menambah katalog pemasok, kolom barcode, nomor PO, dan RPC pembelian/edit yang memakai hak akses Modul Stok. Setelah migrasi berhasil, deploy frontend. Jangan jalankan file ini sebelum seluruh migrasi prasyarat selesai.
- Koki mencatat pemakaian harian dari setiap pengeluaran gudang. Sisa barang disimpan sebagai stok dapur dan tidak menambah stok gudang. Terapkan `supabase_migration.sql` terbaru sebelum menggunakan alur ini; migrasi tersebut membuat tabel pergerakan stok, pemakaian harian dapur, dan fungsi database terkait.
- `Pemakaian Koki` menyediakan folder simulasi berbasis Supabase untuk catatan satuan campuran (misalnya 1 dus = 12 bungkus), pemakaian dua satuan, perhitungan sisa ekuivalen, pengubahan nama folder, simpan/draf, penambahan bahan, dan penghapusan entri keliru. Setelah disimpan, formulir dikosongkan dan detail folder tujuan dibuka. Folder dapat digunakan lintas perangkat oleh pengguna yang sudah login.
- Draf demo yang hanya tersimpan di browser tetap tersedia dan dapat disalin ke Supabase melalui **Impor Draf Lokal Lama**. Pengembalian simulasi dicatat di tabel khusus demo stok dan tidak menambah stok gudang aktif. Alur `Stok & Nota` mencatat pergerakan stok nyata; batalkan pergerakan nyata melalui audit stok agar jejak audit tetap tersimpan. Terapkan `supabase_migration.sql` terbaru sebelum memakai folder simulasi cloud.

### Akuntan dan laporan

- Menu Akuntan menyediakan **Audit & Riwayat Transaksi Stok**, **Stok & Nota**, **Stok Opname**, **Transaksi Keuangan**, **Folder LPDH & LPJ**, **LPDH Harian**, dan **LPJ**. Menu ini berada di portal SUPER ADMIN; belum ada login Akuntan terpisah.
- **Stok Opname** menyimpan hitung fisik sebagai draft atau pengajuan. Persetujuan SUPER ADMIN menerapkan selisih stok secara atomik dan mencatat penyesuaian di audit stok; jika stok berubah sejak opname dibuat, persetujuan ditolak agar hitung ulang dilakukan.
- **Transaksi Keuangan** mencatat saldo awal, pemasukan, dan pengeluaran beserta kategori, uraian, metode/sumber, referensi, dan foto bukti di bucket privat. Transaksi masuk ke saldo hanya setelah disetujui; saldo dihitung dari saldo awal + pemasukan − pengeluaran dan pengeluaran tidak dapat disetujui jika saldo kurang. Perubahan, persetujuan, penolakan, dan penghapusan dapat ditinjau di riwayat audit; ekspor XLSX serta cetak/Save as PDF tersedia.
- Sebelum memakai kedua fitur, tinjau lalu jalankan `supabase/accounting_inventory_finance_migration.sql` setelah migrasi tenant, `supabase_migration.sql`, dan `supabase/module_account_access_migration.sql`. Migrasi menambah tabel tenant-scoped, RLS, RPC persetujuan, serta audit keuangan. Setelah berhasil, deploy frontend. Kredensial dan arsip AboutSky tidak terpengaruh.
- Audit stok membandingkan jumlah masuk/keluar aktif berdasarkan satuan, tidak menghitung transaksi yang dibatalkan, dan menyediakan cetak A4 landscape berlatar putih tanpa overlay aplikasi. LPJ dicetak dalam beberapa halaman A4 landscape.
- LPDH Harian mencatat porsi penerima manfaat, belanja per kategori, bukti nota privat, saldo awal/top-up/akhir, serta nama penanggung jawab dan akuntan untuk cetak. Ekspor Excel, CSV, PDF, dan cetak tersedia. Terapkan `supabase_migration.sql` terbaru untuk membuat tabel laporan khusus admin, bucket nota privat, dan kolom nama tanda tangan.
- LPJ mendukung pengisian dan penyuntingan delapan lembar kerja, nama pribadi bawaan `Anonymous`, penyimpanan Supabase per tanggal, serta ekspor Excel/PDF dan cetak.
- **Folder LPDH & LPJ** mengelompokkan laporan berdasarkan tanggal menggunakan tabel Supabase yang sudah ada. Setiap folder membuka laporan LPDH/LPJ yang tersedia; bukti nota LPDH tetap berada di bucket privat. Penyimpanan laporan memperbarui arsip tanpa memerlukan tabel folder atau migrasi baru.
- LPDH dan LPJ mendukung gambar tanda tangan untuk cetak dan ekspor Excel/PDF. Tanda tangan ini bersifat visual, bukan tanda tangan elektronik berbasis sertifikat. Terapkan `supabase_migration.sql` terbaru untuk penyimpanan tanda tangan LPDH dan tabel LPJ khusus admin.

### Modul dan administrasi

- Pendaftaran SPPG memverifikasi Turnstile, langsung membuat tenant kosong, lalu mengirim undangan admin pertama. Public signup Supabase tetap nonaktif; SMTP dan URL redirect undangan harus dikonfigurasi agar admin dapat membuat password. Relawan memilih SPPG aktif pada formulir dan akun menunggu persetujuan admin SPPG tersebut. Migrasi tenant-empty-defaults harus diterapkan sebelum alur ini dirilis.
- Sidebar SUPER ADMIN mengelompokkan **Laporan**, **Relawan**, **Akun & Akses Modul**, dan **Registrasi** di bawah **SUPER AKSES**, di atas menu **Akuntan**. Di **Akun & Akses Modul**, setiap relawan memiliki akun login terpisah dari SUPER ADMIN dan SUPER ADMIN dapat membatasi akses ke Modul Stok, Bank Menu, atau Persiapan & Distribusi. Hak akses dicek oleh Edge Function dan RLS, bukan hanya dengan menyembunyikan tampilan. Tab **Permohonan SPPG** hanya untuk akun dengan klaim admin platform dan dipakai untuk meninjau permohonan lama. Tata letak cetak absensi dan relawan menggunakan halaman landscape dengan warna yang aman untuk dicetak.
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

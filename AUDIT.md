# Audit Keamanan AgentEscrow — 16 Nov 2026

> **Addendum — 16 Nov 2026 (v2 deployed):** the two contract fixes described
> in this report as "implemented in working tree (belum deploy)" were deployed
> as AgentEscrow v2 at `0x54e833291455D68e944D178FBbbF3F7Ebb359046`
> (Aevum testnet 44005, block 3308598, source commit `926dcfb`), and the four
> frontend/config fixes were committed in the same commit. The live deployment
> is v2; v1 (`0x655a895477fBb38fB4A7c279cad04A4e218F284b`, block 3302809) is
> superseded. The findings below describe the v1 code as audited.


Auditor: subagent (metodologi `immunefi-auditor`: scope dulu, local-only PoC,
triase severity Immunefi). Semua pembuktian lokal (Foundry, tanpa fork live);
tidak ada transaksi dikirim, tidak ada dana dipindah, tidak ada keystore disentuh.

## Target yang diaudit

| | |
|---|---|
| Repo | https://github.com/catalysdrop/agent-escrow |
| Kontrak | `contracts/src/AgentEscrow.sol` (commit 6463f73, seperti yang ter-deploy) |
| Kontrak live | `0x655a895477fBb38fB4A7c279cad04A4e218F284b` (Aevum testnet 44005, blok 3302809) |
| Frontend | `web/src/app/escrow/page.tsx` dkk. (commit d8b1bb3) |
| Demo live | https://agent-escrow.netlify.app (Production main@d5ef3e8, publik) |
| Token | tUSD8 `0x456569838f1d43009A91ebA4263147Afd7233483` (6 desimal) |

## Ringkasan eksekutif

**Verdict: deployment live AMAN untuk demo dan submit dalam bentuknya sekarang
(v1), dengan satu catatan desain yang harus dipahami.** Tidak ditemukan
Critical atau High. Kontrak inti sudah benar: otorisasi per peran ketat,
state machine tidak bisa dilewati dua kali, reentrancy dijaga
(`nonReentrant` + checks-effects-interactions + `SafeERC20`), tidak ada
owner/admin/upgrade, dan bytecode yang ter-deploy **identik** dengan hasil
build repo (3343 byte, hanya slot immutable alamat token yang berbeda;
creator + creation tx cocok).

Dua perbaikan kontrak diimplementasikan di working tree (belum deploy) dan
empat perbaikan frontend/konfigurasi diimplementasikan (belum commit):
temuannya di bawah. **Keputusan yang dibutuhkan: apakah redeploy kontrak
(v2) sebelum submit atau tidak** — lihat § Keputusan redeploy.

## Temuan

### F-1 — Medium · Tidak ada jalur sengketa atas delivery yang buruk (Confirmed)

**Lokasi:** `contracts/src/AgentEscrow.sol` — `markDelivered` (93–103),
`claimUnconfirmed` (130–139). Tidak ada fungsi reject/dispute.

**Penjelasan.** Sekali agent memanggil `markDelivered`, client hanya punya dua
pilihan: `confirmRelease` (bayar) atau diam. Tidak ada aksi untuk menolak
delivery. Jika client diam, agent mengklaim seluruh dana setelah
`deliveredAt + 1 hari`. Artinya agent bisa mengirim proof kosong
(`bytes32(0)`) dan tetap dibayar penuh — escrow hanya melindungi dari
*tidak adanya* delivery, bukan dari delivery yang tidak berharga. Syaratnya:
agent harus sudah dipilih client (bukan penyerang tanpa privilege), jadi ini
bukan pencurian oleh pihak luar — tapi ini adalah celah pada janji inti
produk escrow.

**PoC (lokal, `contracts/test/AgentEscrowAudit.t.sol`):**
`test_knownLimitation_emptyProofPaysIfClientNeverActs` — agent deliver
proof kosong → warp lewat grace → `claimUnconfirmed` → agent menerima 100
tUSD8 penuh. Lolos (membuktikan mekanisme).

**Perbaikan (DIPERBAIKI di working tree, butuh redeploy):**
`rejectDelivery(bytes32)` — client-only, hanya saat `Delivered` dan masih
dalam grace period. Status kembali ke `Created`, `deliveredAt`/`proof`
direset, agent boleh deliver ulang sebelum deadline; setelah deadline client
bisa refund. Setelah grace lewat, hak klaim agent bersifat mutlak
(`GracePassed`) sehingga client tidak bisa membatalkan klaim dengan
rejection di detik terakhir. Event baru `DeliveryRejected`, error baru
`GracePassed`, UI menambah tombol "Reject delivery" (hanya saat client,
Delivered, dan grace belum habis). Trade-off yang dicatat: client jahat bisa
menolak pekerjaan bagus berulang kali sampai deadline — tapi itu dibatasi
deadline, dan agent tetap bisa berhenti bekerja sama dengan client tersebut.
8 test regresi baru lolos.

### F-2 — Low · Jumlah tercatat vs jumlah yang benar-benar diterima (Confirmed mekanisme; tidak berlaku pada token aktual)

**Lokasi:** `AgentEscrow.sol` — `createEscrow` (74–90, versi lama).

**Penjelasan.** Versi lama mencatat `amount` yang diminta lalu
`safeTransferFrom`. Pada token fee-on-transfer, kontrak menerima lebih
sedikit dari yang dicatat → `confirmRelease`/`refund` akan revert
(`ERC20InsufficientBalance`) dan dana terkunci. Token aktual tUSD8 adalah
FiatTokenV2 (USDC-style) **tanpa fee transfer** — diverifikasi dari perilaku
on-chain dan dokumentasi kit — jadi risiko ini hipotetis untuk deployment
sekarang, tapi mekanisme lockup-nya nyata.

**PoC (lokal):** mock `FeeToken` (fee 1%) di
`AgentEscrowAudit.t.sol` — dengan kontrak lama, release akan gagal karena
saldo < tercatat; dengan perbaikan, escrow mencatat net 99 (dari 100) dan
release berhasil, saldo kontrak kembali 0. Test `testFeeTokenRecordsNetReceived`
dan `testFeeTokenFullFeeReverts` lolos.

**Perbaikan (DIPERBAIKI di working tree, butuh redeploy):**
`createEscrow` kini mengukur `balanceBefore`/`balanceAfter` dan mencatat
jumlah yang benar-benar diterima; `received == 0` revert `ZeroAmount`.
Untuk token standar tidak ada perubahan perilaku (test lama 18/18 tetap hijau).

### F-3 — Low · Link "Source" di Docs menunjuk ke repo starter kit (Confirmed live)

**Lokasi:** `web/src/lib/env.ts` — `repoUrl` default
`https://github.com/qday-io/aevum-starter-kit`; Netlify tidak mengeset
`NEXT_PUBLIC_REPO_URL`.

**Bukti live:** HTML halaman https://agent-escrow.netlify.app/docs memuat
`github.com/qday-io/aevum-starter-kit` **8 kali**, nol kali
`catalysdrop/agent-escrow`. Juri yang mengklik Source akan sampai ke repo
yang salah.

**Perbaikan (DIPERBAIKI di working tree):** default diubah ke
`https://github.com/catalysdrop/agent-escrow`, `web/.env.example`
`NEXT_PUBLIC_REPO_URL` diisi. Perlu redeploy frontend (Netlify auto-deploy
saat push).

### F-4 — Low · Squatting taskId lewat front-running (Likely; tidak diperbaiki)

**Lokasi:** `createEscrow` + pembuatan taskId di `page.tsx`.

**Penjelasan.** taskId terlihat di mempool saat transaksi create dikirim.
Penyerang bisa front-run dengan taskId yang sama (sebagai client dan agent
dirinya sendiri) sehingga transaksi korban revert `AlreadyExists`. Dampak:
satu transaksi gagal + gas; korban membuat taskId acak baru dan mengulang.
Tidak ada dana yang hilang atau dicuri, tidak ada motif profit.

**Status: TIDAK DIPERBAIKI** — mitigasi sudah ada (taskId acak 32 byte);
commit-reveal tidak sebanding dengan kompleksitasnya untuk hackathon.

### F-5 — Low · Tombol aksi digating oleh jam lokal browser (Confirmed by code; DIPERBAIKI)

**Lokasi:** `web/src/app/escrow/page.tsx` — `EscrowCard` (`expired`,
`claimReady`, countdown memakai `Date.now()`).

**Penjelasan.** Jika jam lokal pengguna miring dari waktu chain, tombol
Deliver/Refund/Claim bisa tersembunyi padahal aksi masih valid on-chain
(atau sebaliknya, muncul lalu revert saat simulasi). Bukan risiko dana,
tapi UI menyesatkan.

**Perbaikan (DIPERBAIKI di working tree):** `chainNow` diambil dari timestamp
head block di query escrow, dipakai untuk semua gating; fallback ke jam lokal
bila header blok gagal dibaca.

### F-6 — Info · Pesan error menyebut "Gasless mode" di halaman escrow (DIPERBAIKI)

**Lokasi:** `web/src/lib/errors.ts`.

**Penjelasan.** Pesan "Not enough tQDAY for gas … or use Gasless mode"
muncul juga untuk error pembuatan escrow, padahal escrow tidak punya mode
gasless. Menyesatkan pengguna.

**Perbaikan (DIPERBAIKI):** klausa gasless dihapus dari pesan itu (halaman
checkout tetap menunjukkan opsi gasless di UI-nya sendiri).

### F-7 — Info · Tidak ada pengaman escrow ke diri sendiri (DIPERBAIKI)

**Lokasi:** `page.tsx` — `onCreate` tidak menolak `agent == client`.

**Penjelasan.** Mengunci dana ke alamat sendiri tidak berbahaya (dana kembali
ke diri sendiri) tapi sia-sia dan bisa terjadi karena salah tempel alamat.

**Perbaikan (DIPERBAIKI):** validasi di form — agent tidak boleh sama dengan
alamat wallet yang terhubung.

### F-8 — Low · Risiko pause/blacklist bawaan token tUSD8 (Confirmed; TIDAK diperbaiki)

**Lokasi:** token tUSD8 (di luar kontrak kita).

**Bukti on-chain (eth_call, 16 Nov):** `paused()` ada dan mengembalikan
`false`; `isBlacklisted(escrow)` = `false`,
`isBlacklisted(deployer)` = `false`. Token adalah FiatTokenV2 (USDC-style)
dengan fungsi pause + blacklist yang dikontrol admin QDay. Jika admin
mem-pause token atau mem-blacklist kontrak escrow, semua payout akan revert
dan dana membeku. Tidak ada escape hatch di kontrak — dan menambahkannya
butuh pihak tepercaya (owner/rescue), yang justru melemahkan desain
trust-minimised.

**Status: TIDAK DIPERBAIKI** — dicatat sebagai asumsi trust: token testnet
milik penyelenggara hackathon, saat ini tidak di-pause dan tidak ada yang
di-blacklist.

### F-9 — Info · Token yang dikirim langsung ke kontrak akan nyangkut (TIDAK diperbaiki)

**Lokasi:** `AgentEscrow.sol` — tidak ada fungsi sweep/rescue.

**Penjelasan.** Transfer tUSD8 langsung ke alamat kontrak (bukan lewat
`createEscrow`) tidak bisa diambil kembali. Ini by design (tanpa owner =
tanpa pihak yang bisa menyalahgunakan rescue). UI tidak pernah mengarahkan
pengguna untuk transfer langsung.

## Yang diperiksa dan bersih

- **Slither 0.11.6** (penuh + per-file): tidak ada temuan High/Medium.
  Yang tersisa hanya Info: `timestamp` (deadline bergranularitas hari —
  manipulasi miner beberapa detik tidak relevan), `incorrect-equality`
  (false positive pada `received != amount` — perbandingan itu tidak
  meng-gate apa pun, hanya mencatat jumlah riil), noise dari lib OpenZeppelin
  (`assembly`, `low-level-calls`, `pragma`/`solc-version`).
- **Reentrancy:** semua fungsi yang memindahkan dana memakai `nonReentrant`
  + ubah state sebelum transfer + `SafeERC20`. `markDelivered` tidak
  memanggil eksternal. `createEscrow` versi baru memanggil
  `safeTransferFrom` sebelum `emit` tapi setelah validasi, di bawah
  `nonReentrant`; reentransi ke fungsi state-changing lain terblokir, dan
  satu-satunya state yang bisa disentuh token memerlukan peran
  client/agent (token bukan salah satunya).
- **Access control:** setiap transisi memeriksa `msg.sender` terhadap
  client/agent yang tercatat; tidak ada peran admin/owner.
- **Matematika:** `uint256`/`uint64`, tanpa `unchecked`, tanpa pembagian
  yang bisa membulatkan ke arah merugikan; `deliveredAt + GRACE_PERIOD`
  tidak bisa overflow secara praktis (uint64).
- **Checkout.sol (kit):** di luar scope perbaikan; halaman escrow tidak
  memakai atau mewarisi masalahnya (diketahui: siapa pun bisa membayar
  order apa pun — tidak berlaku di AgentEscrow karena setiap transisi
  memeriksa caller + state).
- **TRUSTED_IP_HEADER=x-vercel-forwarded-for di Netlify: TERKONFIRMASI
  TIDAK BERDAMPAK.** Relayer nonaktif total: tidak ada
  `RELAYER_PRIVATE_KEY` di Netlify dan tidak ada Checkout di Aevum, sehingga
  `GET /api/relay` mengembalikan `enabled: false` dan `POST` selalu 503
  sebelum relay apa pun. `clientIp()` hanya mengisi bucket rate-limit yang
  tidak pernah dipakai karena request selalu ditolak di langkah akun.
  Satu-satunya efek teoretis: bila relayer diaktifkan nanti, bucket
  per-IP akan menyatu ke `unknown` di Netlify — tidak relevan sekarang.
- **Bytecode live:** `eth_getCode` 3343 byte, identik dengan artifact build
  lokal kecuali slot immutable alamat token; creator =
  `0x58d5…19aa`, creation tx cocok.
- **Live escrow demo:** taskId `0x0e24…5e1be`, 0,5 tUSD8, status Created —
  konsisten dengan state on-chain.

## Perbaikan yang dilakukan (working tree, BELUM commit/push/deploy)

| File | Perubahan |
|---|---|
| `contracts/src/AgentEscrow.sol` | `rejectDelivery` + event `DeliveryRejected` + error `GracePassed`; pencatatan jumlah terima-bersih di `createEscrow` |
| `contracts/test/AgentEscrowAudit.t.sol` | **Baru.** 10 test: PoC F-1, 6 test rejectDelivery, 2 test fee-token, 1 batas |
| `packages/aevum/src/contracts.ts` | ABI: `rejectDelivery`, `DeliveryRejected`, `GracePassed` |
| `web/src/app/escrow/page.tsx` | Tombol "Reject delivery"; validasi agent ≠ diri sendiri; gating waktu pakai chain time; teks How-it-works |
| `web/src/lib/env.ts` | Default `repoUrl` → `catalysdrop/agent-escrow` |
| `web/src/lib/errors.ts` | Mapping `GracePassed`; hapus klausa "Gasless mode" |
| `web/.env.example` | `NEXT_PUBLIC_REPO_URL` diisi |
| `README.md` | Alur reject + pencatatan net di dokumentasi |

## Verifikasi ulang

- `make test` (forge): **39/39 hijau** (29 lama + 10 baru). Sebelum audit: 29/29.
- Slither: tidak ada High/Medium (lihat di atas).
- `pnpm --filter web typecheck`: exit 0.
- `pnpm build` (web): exit 0, rute `/escrow` tetap prerendered.
- `git status`: 7 file diubah + 1 file test baru, **semuanya uncommitted**
  sesuai instruksi (tidak ada commit, push, deploy, atau transaksi).

## Keputusan redeploy (BUTUH KEPUTUSAN)

Perubahan kontrak (F-1, F-2) **hanya berlaku bila kontrak di-redeploy**.
Dampak redeploy:

1. Alamat kontrak baru → ubah `NEXT_PUBLIC_ESCROW_AEVUM` +
   `NEXT_PUBLIC_DEPLOY_BLOCK_AEVUM` di Netlify → redeploy frontend →
   verifikasi ulang → update README/video.
2. Escrow demo 0,5 tUSD8 (taskId `0x0e24…5e1be`) tetap hidup di kontrak v1;
   di v2 daftar escrow mulai kosong. Video demo yang sedang dibuat
   menampilkan kontrak v1 (alamat + UI tanpa tombol Reject).
3. Biaya: redeploy ~0,001 tQDAY + gas demo ulang (kecil, dari saldo
   deployer ~0,94 tQDAY). Tenggat submit 11 Des 16:00 WITA — masih longgar.

Opsi:
- **A. Redeploy sekarang (direkomendasikan untuk skor Safety):** v2 dengan
  dispute path + hardening; video direkam ulang setelahnya (cepat — alur
  sama, tambah 1 scene Reject). Paling kuat buat juri.
- **B. Submit v1, catat v2 sebagai hardening pasca-hackathon:** tidak ada
  risiko jadwal/video; temuan F-1 dicatat sebagai known limitation di README
  (saat ini README belum menyebutkannya — perlu ditambahkan bila memilih B).

Perubahan frontend (F-3, F-5, F-6, F-7) tidak butuh redeploy kontrak —
cukup push + Netlify auto-deploy. Perlu dicatat: setelah push frontend,
tombol Reject akan muncul di UI tapi memanggil fungsi yang belum ada di
kontrak v1 — simulasinya akan gagal dengan pesan jelas (bukan dana
berisiko), tapi lebih rapi bila push frontend dilakukan bersamaan dengan
redeploy kontrak (opsi A).

## Hal yang sengaja tidak diperbaiki

- F-4 (squatting taskId): dampak terbatas pada satu transaksi gagal, tanpa
  kehilangan dana; mitigasi acak sudah memadai.
- F-8 (pause/blacklist token): risiko bawaan token penyelenggara; fix-nya
  (rescue/owner) justru menambah trust.
- F-9 (token nyangkut): by design tanpa owner.
- `rejectDelivery` TIDAK mengubah fakta bahwa client yang tidak pernah
  bertindak tetap akan membayar agent atas proof kosong setelah grace —
  itu batas desain: dispute butuh client yang aktif dalam 1 hari.
- Checkout.sol dan relayer tidak disentuh (di luar scope; relayer nonaktif).

# Security policy / Güvenlik politikası

## English

### Reporting a vulnerability

Please report security problems **privately** through GitHub's *Report a vulnerability* button
(<https://github.com/ahmetcanalaca/videoeditor/security/advisories/new>) instead of a public issue. You will get an answer as soon
as possible; fixes are published together with a note in the changelog.

### What is in scope

* The **web edition** (`web/`, published with GitHub Pages): a static site, no server code, no accounts, no analytics.
* The **Local AI helper** (`web/local-ai/`, a small PowerShell script offered for download by the web edition).
* The **desktop edition** (`src/`, the Windows installer).

### Design (what you can verify yourself)

* **Your videos never leave your computer.** The web edition reads the files you pick with the browser's own file picker, edits them with
  WebCodecs inside the page and writes the result with the save picker. There is no upload endpoint. The **only** requests that can leave the
  page belong to the optional AI assistant that you switch on yourself: to the Local AI on `127.0.0.1`, or to the provider you chose and confirmed
  (your command and a *text* summary of the timeline; with Foundry *video analysis* switched on, a small copy of the video goes to **your own**
  Azure resource, after a confirmation every time, and - when a zoom has to aim at an object - a few small pictures (at most 640 px) go to **your own**
  chat model, after a separate confirmation every time that names the number of pictures, the object and the model; this app does not keep them, the data policy of
  the model's service applies there; each picture is at most 640 px and 120 KB, at most 64 requests per call, and a request that the provider adapter repeats after a
  rate-limit or network error carries the same picture to the same address).
* **One network path, with an allow-list.** The page's Content-Security-Policy is `connect-src 'self'`. All assistant requests are made by a
  dedicated worker (`web/js/web/ai/net-worker.js`) served with its own policy: `127.0.0.1` / `localhost`, three well-known provider addresses, and
  the https addresses you confirmed in the settings. No redirects, no cookies, no referrer.
* **No API key, secret, token or account** is needed or contained: neither in the source nor in the published site. A key you type for a cloud
  provider is kept in `sessionStorage` (this tab only, meant to be gone when the tab closes), bound to the address it was typed for, sent only there, and never
  written by this site to a project or to a file. A Chromium-based browser may still keep a copy of an open tab's session data in its own profile folder (crash
  recovery, "reopen closed tab"), so on a shared computer use a key you can revoke.
* **The Local AI helper** runs the model on your computer: it listens on `127.0.0.1` only, every request except the status check `/health` (it only says that the server is up) needs a random key that is made on your computer
  **at every start** (handed to the page in the URL *fragment*, which browsers never send to a server, and removed from the address bar at once; it is
  worthless once the helper's window is closed), it downloads only from github.com and huggingface.co (their download servers), checks every file against a
  pinned SHA-256 before using it, checks that the program answering on its port is the one it started, needs no administrator rights and sends no
  telemetry. It is a readable script, not a binary.
* **No telemetry, cookies or tracking.** In this browser the page stores your settings and the pairing of the Local AI helper (`localStorage`; the helper's key changes at every start), the addresses you confirmed (`localStorage`, plus a Cache Storage copy for the network worker), the offline copy of the site itself (Cache Storage, service worker) and, only if you use the optional Foundry video analysis, its results (IndexedDB: scene descriptions and speech text of your videos, kept on this computer; 30 days / 100 MB).
* **No third-party code is loaded at run time.** The few libraries are copied into `web/vendor/`, pinned by SHA-256
  (`web/vendor/vendor-lock.json`); the build fails if one of them changes. The page's Content-Security-Policy allows scripts from the
  site itself only (no inline scripts, no `eval`), and a service worker adds the same policy (plus `frame-ancestors 'none'`) as an HTTP
  header, which GitHub Pages cannot send by itself.
* **The service worker checks what it serves.** Everything it keeps in the cache is compared with the SHA-256 of the build manifest, and the manifest has to be
  the one whose hash the build wrote into the worker script itself; a changed or forged cache entry is dropped and the file comes from the network instead
  (see "Hosting" below for why).
* **Honest limits:** "no known vulnerabilities" is not "no vulnerabilities". Browsers and their codecs (which decode your video) are
  large programs; keep your browser up to date and only open videos from sources you trust. The model server of the helper trusts whoever has its
  key. A cloud provider you choose sees what you send to it.

### Hosting: the origin is shared

Browsers isolate by **origin** (scheme + host + port), not by path. `https://<user>.github.io/videoeditor/` shares its origin, and therefore its
`localStorage`, `IndexedDB` and Cache Storage, with every other GitHub Pages site of the same account. The service worker checks its cache (above) and the
helper's key is short-lived, but data of the editor that stays in the browser (settings, the results of a video analysis) can be read by a page of the same
origin. Such a page could also pre-fill the list of "allowed addresses" kept in that storage; so whenever you enter an API key for an address that is not the provider's
own, the editor asks again, even if the address is already on the list, and shows the address. Read it before you answer. In addition: **do not host untrusted or dynamic content on other repositories of the account that publishes this site**, or give this site an origin of its own
(a custom domain, or a dedicated GitHub user or organisation).

### What you trust when you run the Local AI helper

The helper is a script (`web/local-ai/local-ai.ps1`) that the web page offers as a zip. It is **not signed** with a code-signing certificate, and the zip, its
hash on the page and the pinned downloads all come from the same site. You therefore trust the owner of this repository and GitHub. What lets you check it:

* the script is short and readable, and every download it makes is pinned (`web/local-ai/pins.json`, generated from the desktop app's catalog);
* the workflow that publishes the site (`.github/workflows/pages.yml`) **attests the exact zip it publishes** (signed build provenance, Sigstore, through
  GitHub), so the file you downloaded can be checked against where it was built, whatever the page says:
  `gh attestation verify VideoEditor-LocalAI.zip --repo ahmetcanalaca/videoeditor --signer-workflow ahmetcanalaca/videoeditor/.github/workflows/pages.yml --source-ref refs/heads/main`;
* a fixed, archived copy can also be published as a **GitHub release** (workflow `.github/workflows/helper-release.yml`, same kind of attestation, signer
  workflow `helper-release.yml`); its SHA-256 is in the release notes and equals the page's zip when both were built from the same commit;
* your IT can allow-list the SHA-256 of the script, or you can use the desktop edition, which needs no script.

### Repository settings that belong to this (for the maintainer)

Two-factor authentication or passkeys on the account · branch protection on `main` (require a pull request and, once there are collaborators, review by the code
owners in `.github/CODEOWNERS`) · the `github-pages` environment limited to the `main` branch · Pages source "GitHub Actions" (never "Deploy from a branch") ·
secret scanning with push protection and private vulnerability reporting switched on · Actions allowed from the owner and verified creators only · push only
`main` (not `--mirror` / `--all`).

## Türkçe

### Güvenlik açığı bildirme

Lütfen güvenlik sorunlarını herkese açık issue yerine, GitHub'ın **Report a vulnerability** düğmesiyle **özel olarak** bildirin
(<https://github.com/ahmetcanalaca/videoeditor/security/advisories/new>).

### Tasarım (kendiniz doğrulayabilirsiniz)

* **Videolarınız bilgisayarınızdan çıkmaz.** Web sürümü, tarayıcının kendi dosya seçicisiyle seçtiğiniz dosyaları okur, sayfa içinde
  WebCodecs ile düzenler ve sonucu kaydetme penceresiyle yazar. Yükleme noktası yoktur. Sayfadan çıkabilecek **tek** istekler, sizin açtığınız
  isteğe bağlı AI asistanına aittir: `127.0.0.1` üzerindeki Yerel AI'ya ya da seçip onayladığınız sağlayıcıya (komutunuz ve zaman çizelgesinin
  *metin* özeti; Foundry *video analizi* açıksa, her seferinde onayınızla videonun küçük bir kopyası **kendi** Azure kaynağınıza gider ve - bir zoom'un
  bir nesneye kilitlenmesi gerekiyorsa - her seferinde ayrı bir onayla (resim sayısı, nesne ve model yazılır) birkaç küçük resim (en fazla 640 piksel) **kendi**
  sohbet modelinize gider; bu uygulama onları saklamaz, modelin hizmetinde o hizmetin veri politikası geçerlidir; her resim en fazla 640 piksel ve 120 KB'tır, çağrı başına en fazla 64 istek yapılır ve sağlayıcı bağdaştırıcısının hız sınırı/ağ hatası sonrası yinelediği bir istek aynı resmi aynı adrese taşır).
* **Tek ağ yolu ve izin listesi.** Sayfanın İçerik Güvenliği Politikası `connect-src 'self'` şeklindedir. Asistanın tüm istekleri, kendi
  politikasıyla sunulan ayrı bir worker tarafından (`web/js/web/ai/net-worker.js`) yapılır: `127.0.0.1` / `localhost`, üç bilinen sağlayıcı
  adresi ve ayarlarda onayladığınız https adresleri. Yönlendirme, çerez ve referrer yoktur.
* **API anahtarı, secret, token veya hesap gerekmez ve yoktur** (kaynakta da yayınlanan sitede de). Bir bulut sağlayıcısı için yazdığınız anahtar
  `sessionStorage` içinde (yalnızca bu sekme; sekme kapanınca silinmesi amaçlanır) tutulur, yazıldığı adrese bağlıdır, yalnızca oraya gönderilir; bu site onu projeye
  veya dosyaya yazmaz. Chromium tabanlı bir tarayıcı yine de açık sekmenin oturum verisinin bir kopyasını (çökme kurtarma, "kapatılan sekmeyi yeniden aç") kendi
  profil klasöründe tutabilir; bu yüzden paylaşılan bir bilgisayarda iptal edebileceğiniz bir anahtar kullanın.
* **Yerel AI yardımcısı** modeli sizin bilgisayarınızda çalıştırır: yalnızca `127.0.0.1`'i dinler, durum denetimi `/health` (yalnızca sunucunun ayakta olduğunu söyler) dışında her istek bilgisayarınızda **her başlatmada** üretilen
  rastgele bir anahtar ister (sayfaya URL'nin *fragment* bölümünde verilir; tarayıcılar bunu hiçbir sunucuya göndermez ve sayfa adres çubuğundan hemen
  siler; yardımcının penceresi kapanınca değersiz olur), yalnızca github.com ve huggingface.co'dan (onların indirme sunucularından) indirir, kullanmadan
  önce her dosyayı sabitlenmiş SHA-256 ile denetler, portunda yanıt veren programın kendi başlattığı program olduğunu doğrular, yönetici yetkisi
  gerektirmez ve telemetri göndermez. İkili dosya değil, okunabilir bir betiktir.
* **Telemetri, çerez, izleme yoktur.** Sayfa bu tarayıcıda şunları saklar: ayarlarınız ve Yerel AI yardımcısının eşleşmesi (`localStorage`; yardımcının anahtarı her başlatmada değişir), onayladığınız adresler (`localStorage` ve ağ işçisi için bir Cache Storage kopyası), sitenin kendisinin çevrimdışı kopyası (Cache Storage, service worker) ve yalnızca isteğe bağlı Foundry video analizini kullanırsanız sonuçları (IndexedDB: videolarınızın sahne açıklamaları ve konuşma metni, bu bilgisayarda kalır; 30 gün / 100 MB).
* **Çalışma anında üçüncü taraf kod yüklenmez.** Az sayıdaki kütüphane `web/vendor/` içine kopyalanmış ve SHA-256 ile sabitlenmiştir
  (`web/vendor/vendor-lock.json`); biri değişirse derleme başarısız olur. Sayfanın İçerik Güvenliği Politikası (CSP) yalnızca sitenin
  kendi betiklerine izin verir (satır içi betik yok, `eval` yok); GitHub Pages özel başlık gönderemediği için aynı politikayı
  (`frame-ancestors 'none'` ile birlikte) bir service worker HTTP başlığı olarak ekler.
* **Service worker sunduğunu denetler.** Önbellekte tuttuğu her şey derleme manifestinin SHA-256 değeriyle karşılaştırılır; manifest de, hash'i derleme sırasında worker
  betiğinin kendisine yazılmış olan manifest olmak zorundadır. Değişmiş veya sahte bir önbellek kaydı atılır, dosya ağdan gelir (nedeni için aşağıdaki "Barındırma" bölümüne bakın).
* **Dürüst sınırlar:** "bilinen açık yok", "açık yok" demek değildir. Tarayıcılar ve kodekleri (videonuzu çözen kısım) büyük programlardır;
  tarayıcınızı güncel tutun ve yalnızca güvendiğiniz kaynaklardan video açın. Yardımcının model sunucusu anahtarı bilene güvenir.
  Seçtiğiniz bulut sağlayıcısı kendisine gönderdiklerinizi görür.

### Barındırma: köken (origin) ortaktır

Tarayıcılar yolu değil **kökeni** (şema + sunucu + port) yalıtır. `https://<kullanıcı>.github.io/videoeditor/`, aynı hesabın tüm diğer GitHub Pages siteleriyle kökenini, dolayısıyla
`localStorage`, `IndexedDB` ve Cache Storage alanını paylaşır. Service worker önbelleğini denetler (yukarıda) ve yardımcının anahtarı kısa ömürlüdür; ancak editörün tarayıcıda kalan verileri
(ayarlar, video analizi sonuçları) aynı kökendeki bir sayfa tarafından okunabilir. Böyle bir sayfa, o alanda tutulan "izin verilen adresler" listesini de önceden doldurabilir; bu yüzden sağlayıcının kendi adresi
dışında bir adres için API anahtarı girdiğinizde, adres listede olsa bile editör yeniden sorar ve adresi gösterir; cevaplamadan önce adresi okuyun. Ayrıca: **bu siteyi yayınlayan hesabın diğer depolarında güvenilmeyen veya dinamik içerik barındırmayın**
veya bu siteye kendi kökenini verin (özel alan adı ya da ayrı bir GitHub kullanıcısı/kuruluşu).

### Yerel AI yardımcısını çalıştırırken neye güveniyorsunuz?

Yardımcı, web sayfasının zip olarak sunduğu bir betiktir (`web/local-ai/local-ai.ps1`). Kod imzalama sertifikasıyla **imzalı değildir**; zip, sayfadaki hash'i ve sabitlenmiş indirmeler aynı siteden
gelir. Dolayısıyla bu deponun sahibine ve GitHub'a güvenirsiniz. Denetlemenizi sağlayanlar:

* betik kısa ve okunabilirdir, yaptığı her indirme sabitlenmiştir (`web/local-ai/pins.json`, masaüstü uygulamasının kataloğundan üretilir);
* siteyi yayınlayan iş akışı (`.github/workflows/pages.yml`) **yayınladığı zip'in tam kendisini onaylar** (imzalı yapı kanıtı, Sigstore, GitHub üzerinden); böylece sayfa ne derse desin,
  indirdiğiniz dosya nerede üretildiğiyle karşılaştırılabilir:
  `gh attestation verify VideoEditor-LocalAI.zip --repo ahmetcanalaca/videoeditor --signer-workflow ahmetcanalaca/videoeditor/.github/workflows/pages.yml --source-ref refs/heads/main`;
* sabit, arşivlenmiş bir kopya ayrıca **GitHub sürümü** olarak yayınlanabilir (`.github/workflows/helper-release.yml`, aynı türde kanıt, imzalayan iş akışı `helper-release.yml`);
  SHA-256 sürüm notlarındadır ve ikisi aynı commit'ten üretildiğinde sayfadaki zip'le aynıdır;
* BT biriminiz betiğin SHA-256 değerini izin listesine alabilir ya da betik gerektirmeyen masaüstü sürümünü kullanabilirsiniz.

### Bununla ilgili depo ayarları (bakımcı için)

Hesapta iki adımlı doğrulama veya passkey · `main` için dal koruması (çekme isteği; ortak çalışan olunca `.github/CODEOWNERS` sahiplerinin incelemesi) · `github-pages` ortamının yalnızca
`main` dalıyla sınırlanması · Pages kaynağı "GitHub Actions" (asla "Deploy from a branch") · gizli bilgi taraması + push koruması ve özel güvenlik açığı bildirimi açık · Actions yalnızca sahibin ve doğrulanmış
üreticilerin eylemlerine izinli · yalnızca `main` gönderin (`--mirror` / `--all` değil).

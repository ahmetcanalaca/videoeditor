# Security policy / Güvenlik politikası

## English

### Reporting a vulnerability

Please report security problems **privately** through GitHub's *Report a vulnerability* button
(<https://github.com/ahmetcanalaca/videoeditor/security/advisories/new>) instead of a public issue. You will get an answer as soon
as possible; fixes are published together with a note in the changelog.

### What is in scope

* The **web edition** (`web/`, published with GitHub Pages): a static site, no server code, no accounts, no analytics.
* The **desktop edition** (`src/`, the Windows installer), including how it talks to **Foundry Local**.
* The **browser extension** that lets the web edition use Foundry Local (`web/extension/`; see "Foundry Local in the web edition" below).
* Not in scope (report these to their vendors): Foundry Local itself, Ollama, LM Studio, the cloud providers, your browser.

### Design (what you can verify yourself)

* **Your videos never leave your computer.** The web edition reads the files you pick with the browser's own file picker, edits them with
  WebCodecs inside the page and writes the result with the save picker. There is no upload endpoint. The **only** requests that can leave the
  page belong to the optional AI assistant that you switch on yourself: to a model server on this computer (Ollama, LM Studio; Foundry Local through the browser extension, see below) or to the provider you chose and confirmed
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
* **No telemetry, cookies or tracking.** In this browser the page stores your settings (`localStorage`), the addresses you confirmed (`localStorage`, plus a Cache Storage copy for the network worker), the offline copy of the site itself (Cache Storage, service worker) and, only if you use the optional Foundry video analysis, its results (IndexedDB: scene descriptions and speech text of your videos, kept on this computer; 30 days / 100 MB).
* **No third-party code is loaded at run time.** The few libraries are copied into `web/vendor/`, pinned by SHA-256
  (`web/vendor/vendor-lock.json`); the build fails if one of them changes. The page's Content-Security-Policy allows scripts from the
  site itself only (no inline scripts, no `eval`), and a service worker adds the same policy (plus `frame-ancestors 'none'`) as an HTTP
  header, which GitHub Pages cannot send by itself.
* **The service worker checks what it serves.** Everything it keeps in the cache is compared with the SHA-256 of the build manifest, and the manifest has to be
  the one whose hash the build wrote into the worker script itself; a changed or forged cache entry is dropped and the file comes from the network instead
  (see "Hosting" below for why).
* **A model server on this computer (web edition) is reachable only if it lets the page in.** Ollama (`OLLAMA_ORIGINS`) can allow just this site. LM Studio's "Enable CORS" switch allows
  every website while it is on: other sites you visit could then also send requests to that server, so switch it on only when you need it. Chrome / Edge ask once before a page on the internet may talk to
  a program on this computer ("local network access"). Foundry Local lets no page in at all; the web edition reaches it only through the browser extension (below).
* **Honest limits:** "no known vulnerabilities" is not "no vulnerabilities". Browsers and their codecs (which decode your video) are
  large programs; keep your browser up to date and only open videos from sources you trust. A cloud provider you choose sees what you send to it.

### Foundry Local (desktop app)

Foundry Local is Microsoft's free program that runs AI models on your computer. It is **not part of this project**: you install it yourself (`winget install Microsoft.FoundryLocal`
or <https://aka.ms/foundry-local-installer>), and the desktop app only uses an installation that is already there. What the app does with it, and what it does not:

* **Where it talks:** only to Foundry Local's server on `127.0.0.1` (its port changes at every start). The address is read from `%USERPROFILE%\.foundry\daemon.json` and is believed only when
  (1) it is a literal loopback address (`127.0.0.1` / `[::1]`, a port from 1024), (2) `/status` answers like Foundry Local **with the process id written in that file**, and (3) the process that owns the port is that process.
  Foundry Local's server takes no key, so a program that took over the port of a crashed server must not be handed your prompts and the pictures of your video; (2) and (3) keep it out.
* **What it runs:** the Foundry Local command line, only from the per-user app-execution alias `%LOCALAPPDATA%\Microsoft\WindowsApps\foundry.exe` (the `PATH` is not searched), without a shell, with fixed arguments;
  the only variable argument is a model id that has to match a strict pattern. A server that this app starts stops by itself after 30 minutes without a request; one you started yourself is never touched.
* **What is sent:** your command, the text summary of the timeline and - only if the model you chose can look at pictures and you ask for something that needs it ("zoom in on the dog") - small pictures
  from the video; all of it to that server and nowhere else. No key, account or address is stored for it.
* **What Foundry Local does on its own** (its own traffic, not this app's): it downloads a model only when you press *Download*, and it may fetch hardware components from Microsoft and the chip makers when it starts for the
  first time and when its model list is fetched. The app lists only the models already on your computer; the full catalogue is asked for only when you press *Show all models*.
* **Honest limits:** Foundry Local's server has **no key**: other programs on the computer - and other users of a shared Windows (Remote Desktop, multi-session) - can send requests to it and read the answers.
  On such a computer use the built-in model, which listens only for a random key made at every start. What the model sends back is untrusted text: the assistant can only edit the timeline (one `Ctrl+Z` undoes it all);
  it has no access to files, the network or a shell, and the tool calls it writes are parsed with strict limits (size, number of calls). Text inside video pictures can steer the model, but not more than that.
* **In the browser:** a web page cannot reach Foundry Local by itself (its server sends none of the CORS headers browsers require). The web edition uses the optional browser extension described next.

### Foundry Local in the web edition: the browser extension

Because a page cannot read Foundry Local's answers, the web edition offers a small **browser extension** for Edge / Chrome (Manifest V3, `web/extension/`: plain JavaScript and HTML, no build step, no dependency). It is optional, not part of
the page, and installed by you (developer mode, *Load unpacked*, from the zip that the site offers; the release `foundry-bridge-v1.0.0` carries the same zip with its SHA-256). What it does, and what it does not:

* **Where it can go:** only `http://127.0.0.1:<port>`. Its manifest asks for two host patterns - `http://127.0.0.1/*` and this site (`https://ahmetcanalaca.github.io/videoeditor/*`, top frame only, where its one content script runs) - and two permissions: `storage` (the approval, the last port, the language)
  and `scripting` (to attach to a tab of this site that was already open when the extension was installed). No `tabs`, `webRequest`, `cookies`, `<all_urls>`, no remote host, no `localhost`, no native messaging.
* **What a page may ask for:** four routes of Foundry Local and nothing else - `/v1/models`, `/models/loaded`, `/models/load/{id}`, `/v1/chat/completions`. Not `/status` (the extension reads it itself; it names the Windows user in the model cache path), no unloading, no `/shutdown`, no streaming; a model id has to match a strict pattern;
  pictures only as JPEG data, never as an address (`file:`, `http:`) that the model server could fetch; a request is at most 24 M characters, an answer at most 8 MB, two requests run at a time with a short queue behind them (the surplus gets *busy*), the time limit is 1 s to 10 min. What is sent on is the object that was checked, written again (a body that names a key twice is read differently by different parsers).
  The page names neither an address nor a port: the extension decides where a request goes. The rules are pure functions in `web/extension/policy.js`, covered by `web/tests/ext-policy.test.js`.
* **Who may use it:** only this site, and only after **you** approved it in a window that the extension opens itself and that names the site (a page cannot click in it; "Allow" becomes active a second and a half after the window opens, so a click that was meant for the page cannot approve). Approving and the port search need a click on the page, an automatic call is refused.
  The approval is kept per site, can be removed in the extension's pop-up and is readable only by the extension's own pages and worker. A window that another page opened (`window.open`) is not served at all: its opener could reach into it, as every page of the same origin can.
* **How Foundry Local is recognised:** an address is used only when `GET /status` answers like Foundry Local *and names that very address*. Looking for the port (the stored one, `5272`, then `49152–65535` on `127.0.0.1`: one small `GET /status` per port, 3-11 s) happens only when you press *Find automatically*;
  another port is typed into the extension's own window - the page cannot choose a port, so it cannot use the extension to probe the ports of this computer.
  After 30 seconds without a request the address is looked at again before anything else is sent: a program that took the port of a server that was stopped meanwhile and answers differently - or says nothing (it is given a second, longer chance first) - gets only a `GET /status` and none of your prompts (tested).
  A program that copies Foundry Local's whole `/status` answer is not recognised as different (see the limits).
* **What it keeps:** the approved site, the last port and the language, in the extension's own storage. No log, no prompts, no pictures, no telemetry; nothing leaves `127.0.0.1`.
* **What is sent through it:** the same as in the desktop app - your command, the text summary of the timeline and, only if the model can look at pictures and you ask for something that needs it, small pictures (at most 640 px) of the video - and only to Foundry Local on this computer, so there is nothing to confirm, as in the desktop app.
* **Honest limits:**
  Foundry Local's server has **no key**: any program on the computer, and the approved site, can use the model that is loaded. The extension cannot see **which program** owns a port (the desktop app can: it compares the process id that `/status` returns with the owner of the port); a program that copies the whole answer of `/status` (it is public, easy to copy) on a free port could therefore receive the requests.
  On a shared computer (Remote Desktop, multi-session) do not use it, use the desktop app's built-in model.
  The approval belongs to the site's **origin**, which `*.github.io` shares with the account's other Pages sites (see "Hosting"): the extension refuses a window that another page opened (the usual way into a window of the same origin), but the shared origin stays a weakness of this kind of hosting - the reason not to host untrusted pages there.
  The extension is unsigned and loaded from a folder; on a company computer, policy may forbid developer-mode extensions (ask IT to approve it, or use the desktop app). What the model sends back is untrusted text: the assistant can only edit the timeline (one `Ctrl+Z` undoes it all).
  A scan of local ports can look unusual to endpoint-security software; fixing Foundry Local's port once (`foundry config set port 5272`) avoids it. A copy of the site that is published under another address does **not** get the feature (the manifest names this site only).

### Hosting: the origin is shared

Browsers isolate by **origin** (scheme + host + port), not by path. `https://<user>.github.io/videoeditor/` shares its origin, and therefore its
`localStorage`, `IndexedDB` and Cache Storage, with every other GitHub Pages site of the same account. The service worker checks its cache (above), but data of the editor that stays in the browser (settings, the results of a video analysis) can be read by a page of the same
origin. Such a page could also pre-fill the list of "allowed addresses" kept in that storage; so whenever you enter an API key for an address that is not the provider's
own, the editor asks again, even if the address is already on the list, and shows the address. Read it before you answer. In addition: **do not host untrusted or dynamic content on other repositories of the account that publishes this site**, or give this site an origin of its own
(a custom domain, or a dedicated GitHub user or organisation).

### What you trust

* **The desktop installer** is built on the maintainer's computer and is **not code-signed** (Windows SmartScreen says so); its SHA-256 is in the release notes. It contains FFmpeg (GPL v3) and the llama.cpp program of the built-in model, both pinned by SHA-256 when they are fetched for the build.
  The installer needs no administrator rights and writes only to your user profile (per-user install).
* **The web edition** is built by the workflow `.github/workflows/pages.yml` from this repository (every action pinned to a commit) and published by GitHub Pages; you trust this repository and GitHub.
* **Foundry Local** is Microsoft's program, installed by you from Microsoft's own addresses; this repository neither ships nor downloads it.
* **The browser extension** is built from `web/extension/` by `web/scripts/pack-extension.js` into a reproducible zip (the same bytes on every build). Its SHA-256 is written in the release notes of `foundry-bridge-v1.0.0` on GitHub - a place other than the site that serves the zip - and the dialog shows the `Get-FileHash` command to compare it.
  It is **not signed or published in a store**, and runs with the rights described above: you can read all of it (about 700 lines of JavaScript) before you load it.

### Repository settings that belong to this (for the maintainer)

Two-factor authentication or passkeys on the account · branch protection on `main` (require a pull request and, once there are collaborators, review by the code
owners in `.github/CODEOWNERS`) · the `github-pages` environment limited to the `main` branch · Pages source "GitHub Actions" (never "Deploy from a branch") ·
secret scanning with push protection and private vulnerability reporting switched on · Actions allowed from the owner and verified creators only · push only
`main` (not `--mirror` / `--all`).

## Türkçe

### Güvenlik açığı bildirme

Lütfen güvenlik sorunlarını herkese açık issue yerine, GitHub'ın **Report a vulnerability** düğmesiyle **özel olarak** bildirin
(<https://github.com/ahmetcanalaca/videoeditor/security/advisories/new>).

### Kapsam

* **Web sürümü** (`web/`, GitHub Pages ile yayınlanır): statik site; sunucu kodu, hesap ve analiz yoktur.
* **Masaüstü sürümü** (`src/`, Windows kurulum dosyası) ve **Foundry Local** ile konuşma biçimi.
* Web sürümünün Foundry Local'i kullanmasını sağlayan **tarayıcı uzantısı** (`web/extension/`; aşağıda "Web sürümünde Foundry Local").
* Kapsam dışı (ilgili üreticiye bildirin): Foundry Local'in kendisi, Ollama, LM Studio, bulut sağlayıcıları, tarayıcınız.

### Tasarım (kendiniz doğrulayabilirsiniz)

* **Videolarınız bilgisayarınızdan çıkmaz.** Web sürümü, tarayıcının kendi dosya seçicisiyle seçtiğiniz dosyaları okur, sayfa içinde
  WebCodecs ile düzenler ve sonucu kaydetme penceresiyle yazar. Yükleme noktası yoktur. Sayfadan çıkabilecek **tek** istekler, sizin açtığınız
  isteğe bağlı AI asistanına aittir: bu bilgisayardaki bir model sunucusuna (Ollama, LM Studio; Foundry Local tarayıcı uzantısı üzerinden, aşağıya bakın) ya da seçip onayladığınız sağlayıcıya (komutunuz ve zaman çizelgesinin
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
* **Telemetri, çerez, izleme yoktur.** Sayfa bu tarayıcıda şunları saklar: ayarlarınız (`localStorage`), onayladığınız adresler (`localStorage` ve ağ işçisi için bir Cache Storage kopyası), sitenin kendisinin çevrimdışı kopyası (Cache Storage, service worker) ve yalnızca isteğe bağlı Foundry video analizini kullanırsanız sonuçları (IndexedDB: videolarınızın sahne açıklamaları ve konuşma metni, bu bilgisayarda kalır; 30 gün / 100 MB).
* **Çalışma anında üçüncü taraf kod yüklenmez.** Az sayıdaki kütüphane `web/vendor/` içine kopyalanmış ve SHA-256 ile sabitlenmiştir
  (`web/vendor/vendor-lock.json`); biri değişirse derleme başarısız olur. Sayfanın İçerik Güvenliği Politikası (CSP) yalnızca sitenin
  kendi betiklerine izin verir (satır içi betik yok, `eval` yok); GitHub Pages özel başlık gönderemediği için aynı politikayı
  (`frame-ancestors 'none'` ile birlikte) bir service worker HTTP başlığı olarak ekler.
* **Service worker sunduğunu denetler.** Önbellekte tuttuğu her şey derleme manifestinin SHA-256 değeriyle karşılaştırılır; manifest de, hash'i derleme sırasında worker
  betiğinin kendisine yazılmış olan manifest olmak zorundadır. Değişmiş veya sahte bir önbellek kaydı atılır, dosya ağdan gelir (nedeni için aşağıdaki "Barındırma" bölümüne bakın).
* **Bu bilgisayardaki bir model sunucusuna (web sürümü) yalnızca sunucu sayfayı içeri alırsa ulaşılır.** Ollama (`OLLAMA_ORIGINS`) yalnızca bu siteye izin verebilir. LM Studio'nun "Enable CORS" anahtarı açıkken **her** web sitesine izin verir:
  gezdiğiniz başka siteler de o sunucuya istek gönderebilir; bu yüzden yalnızca gerektiğinde açın. Chrome / Edge, internetteki bir sayfa bu bilgisayardaki bir programla konuşmadan önce bir kez sorar ("yerel ağ erişimi"). Foundry Local hiçbir sayfayı içeri almaz; web sürümü ona yalnızca tarayıcı uzantısı üzerinden ulaşır (aşağıda).
* **Dürüst sınırlar:** "bilinen açık yok", "açık yok" demek değildir. Tarayıcılar ve kodekleri (videonuzu çözen kısım) büyük programlardır;
  tarayıcınızı güncel tutun ve yalnızca güvendiğiniz kaynaklardan video açın. Seçtiğiniz bulut sağlayıcısı kendisine gönderdiklerinizi görür.

### Foundry Local (masaüstü uygulaması)

Foundry Local, Microsoft'un yapay zekâ modellerini bilgisayarınızda çalıştıran ücretsiz programıdır. **Bu projenin parçası değildir**: siz kurarsınız (`winget install Microsoft.FoundryLocal`
ya da <https://aka.ms/foundry-local-installer>); masaüstü uygulaması yalnızca kurulu olanı kullanır. Uygulamanın onunla yaptıkları ve yapmadıkları:

* **Nereyle konuşur:** yalnızca Foundry Local'in `127.0.0.1` üzerindeki sunucusuyla (portu her başlatmada değişir). Adres `%USERPROFILE%\.foundry\daemon.json` dosyasından okunur ve yalnızca şu koşullarda güvenilir:
  (1) düz bir geri döngü adresi olmalı (`127.0.0.1` / `[::1]`, port 1024 ve üstü), (2) `/status` Foundry Local gibi **ve o dosyada yazan süreç numarasıyla** yanıt vermeli, (3) portun sahibi o süreç olmalı.
  Foundry Local'in sunucusu anahtar istemez; bu yüzden çökmüş bir sunucunun portunu ele geçiren bir programa komutlarınız ve video kareleriniz verilmemelidir; (2) ve (3) bunu engeller.
* **Ne çalıştırır:** Foundry Local komut satırını yalnızca kullanıcı klasöründeki uygulama-yürütme takma adından (`%LOCALAPPDATA%\Microsoft\WindowsApps\foundry.exe`; `PATH` aranmaz), kabuk (shell) olmadan, sabit bağımsız değişkenlerle çalıştırır;
  tek değişken argüman, sıkı bir kalıba uyması gereken model adıdır. Uygulamanın başlattığı sunucu 30 dakika istek gelmezse kendiliğinden kapanır; sizin başlattığınıza dokunulmaz.
* **Ne gönderilir:** komutunuz, zaman çizelgesinin metin özeti ve - yalnızca seçtiğiniz model resme bakabiliyorsa ve "köpeği yakınlaştır" gibi buna ihtiyaç duyan bir şey isterseniz - videodan küçük resimler;
  hepsi yalnızca o sunucuya. Bunun için anahtar, hesap veya adres saklanmaz.
* **Foundry Local'in kendi yaptıkları** (onun trafiği, bu uygulamanın değil): modeli yalnızca siz *İndir*'e basınca indirir; ilk başlatmada ve model listesini alırken Microsoft'tan ve çip üreticilerinden donanım bileşenleri alabilir.
  Uygulama yalnızca bilgisayarınızdaki modelleri listeler; tüm katalog ancak *Tüm modelleri göster*'e basınca istenir.
* **Dürüst sınırlar:** Foundry Local'in sunucusu **anahtar istemez**: bilgisayardaki başka programlar - ve paylaşılan bir Windows'ta (Uzak Masaüstü, çok oturum) başka kullanıcılar - ona istek gönderip yanıtları okuyabilir.
  Böyle bir bilgisayarda, her başlatmada üretilen rastgele bir anahtarla korunan yerleşik modeli kullanın. Modelin geri gönderdiği metin güvenilmezdir: asistan yalnızca zaman çizelgesini düzenleyebilir (`Ctrl+Z` hepsini geri alır);
  dosyalara, ağa veya kabuğa erişimi yoktur; yazdığı araç çağrıları sıkı sınırlarla ayrıştırılır (boyut, çağrı sayısı). Video karelerindeki yazılar modeli yönlendirebilir, ama bundan fazlasını yapamaz.
* **Tarayıcıda:** bir web sayfası Foundry Local'e kendi başına ulaşamaz (sunucusu tarayıcıların istediği CORS başlıklarının hiçbirini göndermiyor). Web sürümü bunun için aşağıda anlatılan isteğe bağlı tarayıcı uzantısını kullanır.

### Web sürümünde Foundry Local: tarayıcı uzantısı

Bir sayfa Foundry Local'in yanıtlarını okuyamadığı için web sürümü, Edge / Chrome için küçük bir **tarayıcı uzantısı** sunar (Manifest V3, `web/extension/`: düz JavaScript ve HTML, derleme adımı yok, bağımlılık yok). İsteğe bağlıdır, sayfanın parçası değildir ve sizin tarafınızdan kurulur
(geliştirici modu, *Paketlenmemiş öğe yükle*; sitenin sunduğu zip'ten; `foundry-bridge-v1.0.0` sürümü aynı zip'i SHA-256 değeriyle taşır). Ne yapar, ne yapmaz:

* **Nereye gidebilir:** yalnızca `http://127.0.0.1:<port>`. Manifesti iki ana makine kalıbı ister - `http://127.0.0.1/*` ve bu site (`https://ahmetcanalaca.github.io/videoeditor/*`, yalnızca üst çerçeve; tek içerik betiği burada çalışır) - ve iki izin: `storage` (onay, son port, dil)
  ve `scripting` (uzantı kurulduğunda zaten açık olan bu sitenin sekmesine bağlanmak için). `tabs`, `webRequest`, `cookies`, `<all_urls>`, uzak sunucu, `localhost`, native messaging yoktur.
* **Bir sayfa ne isteyebilir:** Foundry Local'in dört yolu ve başka hiçbir şey - `/v1/models`, `/models/loaded`, `/models/load/{id}`, `/v1/chat/completions`. `/status` yok (uzantı onu kendisi okur; model önbellek yolunda Windows kullanıcı adı geçer), model boşaltma yok, `/shutdown` yok, akış (stream) yok; model adı sıkı bir kalıba uymalı;
  resimler yalnızca JPEG verisi olabilir, model sunucusunun kendisi getirebileceği bir adres (`file:`, `http:`) olamaz; bir istek en fazla 24 M karakter, bir yanıt en fazla 8 MB, aynı anda iki istek ve arkasında kısa bir kuyruk (fazlası *meşgul* yanıtı alır), zaman sınırı 1 sn - 10 dk. İleriye giden, denetlenen nesnenin yeniden yazılmış hâlidir (bir anahtarı iki kez yazan gövdeyi farklı ayrıştırıcılar farklı okur).
  Sayfa ne adres ne port söyler: isteğin nereye gideceğine uzantı karar verir. Kurallar `web/extension/policy.js` içinde saf fonksiyonlardır ve `web/tests/ext-policy.test.js` ile sınanır.
* **Kim kullanabilir:** yalnızca bu site ve yalnızca **siz** uzantının kendi açtığı, siteyi adıyla gösteren bir pencerede onayladıktan sonra (o pencerede bir sayfa tıklayamaz; **İzin ver** düğmesi pencere açıldıktan bir buçuk saniye sonra etkinleşir, böylece sayfaya yönelik bir tıklama onay vermez). Onay vermek ve port aramak sayfada bir tıklama ister; kendiliğinden yapılan çağrı reddedilir.
  Onay site başına tutulur, uzantının açılır penceresinden kaldırılabilir ve yalnızca uzantının kendi sayfaları ile işçisi tarafından okunabilir. Başka bir sayfanın açtığı pencere (`window.open`) hiç hizmet almaz: açan sayfa, aynı kökendeki her sayfa gibi, onun içine uzanabilir.
* **Foundry Local nasıl tanınır:** bir adres yalnızca `GET /status` Foundry Local gibi *ve sorulan adresin kendisini adlandırarak* yanıt verirse kullanılır. Portun aranması (kayıtlı port, `5272`, sonra `127.0.0.1` üzerinde `49152–65535`: port başına küçük bir `GET /status`, 3-11 sn) yalnızca *Otomatik bul*'a basınca yapılır;
  başka bir port uzantının kendi penceresine yazılır - sayfa port seçemez, dolayısıyla uzantıyı bu bilgisayarın portlarını yoklamak için kullanamaz.
  30 saniye istek gelmezse, başka bir şey gönderilmeden önce adrese yeniden bakılır: bu arada durdurulmuş bir sunucunun portunu alıp farklı yanıt veren - ya da hiç yanıt vermeyen (ona önce ikinci, daha uzun bir şans verilir) - bir program yalnızca bir `GET /status` görür, komutlarınızı görmez (sınandı).
  `/status` yanıtının tamamını kopyalayan bir program farklı olarak tanınmaz (sınırlara bakın).
* **Ne saklar:** onaylanan site, son port ve dil; uzantının kendi depolama alanında. Günlük, komut, resim, telemetri yoktur; `127.0.0.1` dışına hiçbir şey çıkmaz.
* **Ondan ne geçer:** masaüstü uygulamasındakiyle aynısı - komutunuz, zaman çizelgesinin metin özeti ve, yalnızca model resme bakabiliyorsa ve buna ihtiyaç duyan bir şey isterseniz, videodan küçük resimler (en fazla 640 piksel) - ve yalnızca bu bilgisayardaki Foundry Local'e; bu yüzden masaüstü uygulamasında olduğu gibi onaylanacak bir şey yoktur.
* **Dürüst sınırlar:**
  Foundry Local'in sunucusu **anahtar istemez**: bilgisayardaki her program ve onaylanan site, yüklü modeli kullanabilir. Uzantı bir portun **hangi programa** ait olduğunu göremez (masaüstü uygulaması görür: `/status`'un döndürdüğü süreç numarasını portun sahibiyle karşılaştırır);
  boş bir portta `/status` yanıtının tamamını kopyalayan bir program (yanıt herkese açıktır, kopyalamak kolaydır) bu yüzden istekleri alabilir. Paylaşılan bir bilgisayarda (Uzak Masaüstü, çok oturum) kullanmayın; masaüstü uygulamasının yerleşik modelini kullanın.
  Onay sitenin **köken**ine bağlıdır; `*.github.io` bu kökeni hesabın diğer Pages siteleriyle paylaşır ("Barındırma" bölümüne bakın): uzantı başka bir sayfanın açtığı pencereyi (aynı kökendeki bir pencereye uzanmanın olağan yolu) reddeder, ama ortak köken bu tür barındırmanın zayıflığı olarak kalır - orada güvenilmeyen sayfa barındırmamanın nedeni budur.
  Uzantı imzasızdır ve bir klasörden yüklenir; şirket bilgisayarında politika geliştirici modu uzantılarını yasaklayabilir (BT'den onay isteyin ya da masaüstü uygulamasını kullanın). Modelin geri gönderdiği metin güvenilmezdir: asistan yalnızca zaman çizelgesini düzenleyebilir (`Ctrl+Z` hepsini geri alır).
  Yerel portların taranması güvenlik yazılımlarına alışılmadık görünebilir; Foundry Local'in portunu bir kez sabitlemek (`foundry config set port 5272`) bunu önler. Sitenin başka bir adreste yayınlanan bir kopyası bu özelliği **almaz** (manifest yalnızca bu siteyi adlandırır).

### Barındırma: köken (origin) ortaktır

Tarayıcılar yolu değil **kökeni** (şema + sunucu + port) yalıtır. `https://<kullanıcı>.github.io/videoeditor/`, aynı hesabın tüm diğer GitHub Pages siteleriyle kökenini, dolayısıyla
`localStorage`, `IndexedDB` ve Cache Storage alanını paylaşır. Service worker önbelleğini denetler (yukarıda); ancak editörün tarayıcıda kalan verileri
(ayarlar, video analizi sonuçları) aynı kökendeki bir sayfa tarafından okunabilir. Böyle bir sayfa, o alanda tutulan "izin verilen adresler" listesini de önceden doldurabilir; bu yüzden sağlayıcının kendi adresi
dışında bir adres için API anahtarı girdiğinizde, adres listede olsa bile editör yeniden sorar ve adresi gösterir; cevaplamadan önce adresi okuyun. Ayrıca: **bu siteyi yayınlayan hesabın diğer depolarında güvenilmeyen veya dinamik içerik barındırmayın**
veya bu siteye kendi kökenini verin (özel alan adı ya da ayrı bir GitHub kullanıcısı/kuruluşu).

### Neye güveniyorsunuz?

* **Masaüstü kurulum dosyası** bakımcının bilgisayarında derlenir ve **kod imzalı değildir** (Windows SmartScreen bunu söyler); SHA-256 değeri sürüm notlarındadır. İçinde FFmpeg (GPL v3) ve yerleşik modelin llama.cpp programı vardır;
  ikisi de derleme için indirilirken SHA-256 ile sabitlenmiştir. Kurulum yönetici yetkisi gerektirmez ve yalnızca kullanıcı profilinize yazar (kullanıcı başına kurulum).
* **Web sürümü**, bu depodan `.github/workflows/pages.yml` iş akışıyla (her eylem bir commit'e sabitlenmiş) derlenir ve GitHub Pages ile yayınlanır; bu depoya ve GitHub'a güvenirsiniz.
* **Foundry Local** Microsoft'un programıdır ve Microsoft'un kendi adreslerinden siz kurarsınız; bu depo onu ne dağıtır ne indirir.
* **Tarayıcı uzantısı** `web/extension/` klasöründen `web/scripts/pack-extension.js` ile yeniden üretilebilir bir zip'e derlenir (her derlemede aynı baytlar). SHA-256 değeri GitHub'daki `foundry-bridge-v1.0.0` sürüm notunda yazar - zip'i sunan siteden başka bir yerde - ve pencere karşılaştırmak için `Get-FileHash` komutunu gösterir.
  **İmzalı değildir ve mağazada yayınlanmamıştır**, yukarıda anlatılan haklarla çalışır: yüklemeden önce hepsini okuyabilirsiniz (yaklaşık 700 satır JavaScript).

### Bununla ilgili depo ayarları (bakımcı için)

Hesapta iki adımlı doğrulama veya passkey · `main` için dal koruması (çekme isteği; ortak çalışan olunca `.github/CODEOWNERS` sahiplerinin incelemesi) · `github-pages` ortamının yalnızca
`main` dalıyla sınırlanması · Pages kaynağı "GitHub Actions" (asla "Deploy from a branch") · gizli bilgi taraması + push koruması ve özel güvenlik açığı bildirimi açık · Actions yalnızca sahibin ve doğrulanmış
üreticilerin eylemlerine izinli · yalnızca `main` gönderin (`--mirror` / `--all` değil).

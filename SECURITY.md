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
* The **assistant that runs in the browser** (`web/js/web/ai/inbrowser/`, the service worker's rules for its two workers, the pinned model catalogue; see "AI in the browser" below).
* Not in scope (report these to their vendors): Foundry Local itself, Ollama, LM Studio, the cloud providers, Hugging Face and the authors of the models, your browser.

### Design (what you can verify yourself)

* **Your videos never leave your computer.** The web edition reads the files you pick with the browser's own file picker, edits them with
  WebCodecs inside the page and writes the result with the save picker. There is no upload endpoint. The **only** requests that can leave the
  page belong to the optional AI assistant that you switch on yourself: to a model server on this computer (Ollama, LM Studio; Foundry Local through the browser extension, see below), to the provider you chose and confirmed, or - for the model that runs in the browser - the download of its model files from Hugging Face, after a question (see "AI in the browser" below)
  (your command and a *text* summary of the timeline; with Foundry *video analysis* switched on, a small copy of the video goes to **your own**
  Azure resource, after a confirmation every time, and - when a zoom has to aim at an object - a few small pictures (at most 640 px) go to **your own**
  chat model, after a separate confirmation every time that names the number of pictures, the object and the model; this app does not keep them, the data policy of
  the model's service applies there; each picture is at most 640 px and 120 KB, at most 64 requests per call, and a request that the provider adapter repeats after a
  rate-limit or network error carries the same picture to the same address).
* **Network paths, with allow-lists.** The page's Content-Security-Policy is `connect-src 'self'`. The requests of the cloud / model-server assistant are made by a
  dedicated worker (`web/js/web/ai/net-worker.js`) served with its own policy: `127.0.0.1` / `localhost`, three well-known provider addresses, and
  the https addresses you confirmed in the settings. No redirects, no cookies, no referrer. The model files of the in-browser assistant are downloaded by a second dedicated worker
  (`ib-dl-worker.js`) whose policy names this site and Hugging Face only (see "AI in the browser").
* **No API key, secret, token or account** is needed or contained: neither in the source nor in the published site. A key you type for a cloud
  provider is kept in `sessionStorage` (this tab only, meant to be gone when the tab closes), bound to the address it was typed for, sent only there, and never
  written by this site to a project or to a file. A Chromium-based browser may still keep a copy of an open tab's session data in its own profile folder (crash
  recovery, "reopen closed tab"), so on a shared computer use a key you can revoke.
* **No telemetry, cookies or tracking.** In this browser the page stores your settings (`localStorage`), the addresses you confirmed (`localStorage`, plus a Cache Storage copy for the network worker), the offline copy of the site itself (Cache Storage, service worker), the model files of the in-browser assistant if you downloaded one (Cache Storage, 1.5 or 2.8 GB per model, deletable in the settings) and, only if you use the optional Foundry video analysis, its results (IndexedDB: scene descriptions and speech text of your videos, kept on this computer; 30 days / 100 MB).
* **No third-party code is loaded at run time.** The few libraries (the editor's video library, and the two that run the in-browser model) are copied into `web/vendor/`, pinned by SHA-256
  (`web/vendor/vendor-lock.json`); the build fails if one of them changes. One of them carries one declared change - a class name that GitHub's secret scanning took for an API key is spelled with an underscore, see `web/THIRD-PARTY-NOTICES.txt` - recorded as a patch with the SHA-256 of the official file and of the patched one, which `node scripts/vendor.js verify` proves offline. The page's Content-Security-Policy allows scripts from the
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

### AI in the browser (web edition): a model that runs inside the page

The default assistant of the web edition runs an AI model **in the browser tab, on your graphics card** (WebGPU). Nothing is installed: no program, no `.bat` file, no browser extension. What it does, and what it does not:

* **What is downloaded, and from where.** Only the **model files** - data: ONNX weights, tokenizer and configuration, 1.5 / 2.8 GB - from Hugging Face (`huggingface.co`, which redirects to its content network `*.hf.co`), after a question that names the model, its size, the repository, the commit and what is stored.
  Hugging Face sees the download (your IP address); your commands, your videos and your keys are not sent there. The libraries that run the model (transformers.js, Apache-2.0; ONNX Runtime Web, MIT) are **not** fetched from anywhere else: they are part of this site (`web/vendor/`, pinned by SHA-256, see above).
* **Every byte is checked.** The repository and the **commit** of each model are pinned in `web/js/web/ai/inbrowser/ib-models.js`, together with the size and SHA-256 of every file and the SHA-256 of every 16 MiB block of it. The file is generated by `web/scripts/ib-model-lock.js`, which downloads each file and compares it with what Hugging Face publishes (the LFS hash, or the git blob id of a small file).
  The download worker hands bytes to the browser's storage only after the block they belong to has the pinned hash; the engine checks the same hashes again whenever it reads a file back (a page of another repository of the same account shares this origin and could write into Cache Storage, see "Hosting"). A file that does not match is never stored or used, a stored one that was changed is deleted and offered again.
  The page names a model by its **key in the catalogue** only: no address, no file name and no hash comes from the page, and a download that is redirected to any host but Hugging Face is refused.
* **Two workers, each with a policy of its own** (the service worker adds them as HTTP headers, which GitHub Pages cannot send): the **download worker** may talk to this site and to `huggingface.co` / `*.hf.co`, compiles no WebAssembly and starts no workers; the **engine worker**, which runs the model, may compile WebAssembly (`wasm-unsafe-eval`) but may talk to **this origin only** (`connect-src 'self'`; on `github.io` that is every Pages site of the account, see "Hosting") and starts no workers either - whatever runs in it cannot open a network connection to any other address. (What that policy does not cover is the origin's own storage and message channels - which, on `github.io`, the other Pages sites of the account share; see "Hosting".)
  The page's own policy is unchanged (no `wasm-unsafe-eval`, `connect-src 'self'`). The libraries of the engine - among them a 26 MB WebAssembly file - are on the **lazy list** of the build manifest: not part of the offline copy, fetched when the model is first used, and served by the service worker only when their size and SHA-256 are the manifest's (HTTP 502 otherwise; checked again on every use of the cached copy).
* **These protections belong to the service worker, so the assistant checks for it.** A file cannot carry its own HTTP headers; without a service worker in control of the page (a private window of a browser that has none, a policy that switches them off) the two workers would run without their policies and the libraries would not be checked. The assistant therefore **does not start** then (step 1 of the panel says why). Two more guards do not depend on the headers: before it loads the model the engine worker **tests that it cannot open network connections** - a request to a `data:` address (which needs no network, so being offline or blocked from Hugging Face cannot fake a pass) and one to another site must both be refused, otherwise it does not load the model - and the service worker serves the code of the in-browser model feature (`js/web/ai/inbrowser/`) and the libraries of the model **only under the address of the manifest and only with the manifest's bytes, from the cache and from the network alike**: every address inside its scope that is not written the plain way (a doubled slash, a `%`-escape, a backslash) is a 404, and so is another letter case (`Vendor/…`); while there is no checked manifest - the cache was emptied - they are a 503 until the cache is filled again, and bytes from the network that are not the manifest's are a 502. An unchecked file is never passed on.
* **What the model gets:** your command, the text summary of the timeline and - only when you ask for something that needs it ("zoom in on the dog") - small pictures of the video. All of it stays in the tab (a message to the worker); there is no key and no account.
* **What it keeps:** the model files in Cache Storage (`ve-ib-models-v1`; *Delete download* removes them) and the chosen model in `localStorage`. The page asks the browser to keep the files (`navigator.storage.persist()`: only a request). The model leaves the memory after 10 minutes without a request (*Free memory* does it at once).
* **Honest limits.** (1) Hugging Face and the repositories (`onnx-community`, `webgpu`) are third parties: the pinned commit and hashes mean that *you get exactly the files whose hashes were compared with the ones Hugging Face publishes* - nobody has audited the model, and it is not flawless. A model file is data that ONNX Runtime interprets, and a bug in that interpreter could in principle be triggered by a hostile file - the pinning (nobody can change the file afterwards), the engine worker that can reach this origin only (tested at every start) and the browser's sandbox are the answer, not a guarantee.
  (2) A small model is often wrong: it can only edit the timeline (one `Ctrl+Z` undoes it all), it has no access to files, the network or a shell, and text inside video pictures or in a file name can steer it, but not more than that (the control tokens of the model are made plain text before they reach it, so a file name cannot forge a turn of the conversation). A smaller 0.8B model was tried and is not offered because it could not carry out editing commands. (3) It needs memory while it is loaded (measured with integrated graphics, which share the computer's memory: about 5 GB for the 2B model, about 10 GB for the 4B model); two tabs load two copies. (4) Company networks may block `huggingface.co` / `hf.co`; a download that was cancelled by hand starts over (a broken or silent connection - no byte for 60 s - is resumed automatically).
  (5) The libraries are a development build of ONNX Runtime Web (the version transformers.js was built with, pinned); a vulnerability report about a bundled library is answered with an update of the pin.

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
* **The in-browser model files** are third-party data: Qwen3.5 (Alibaba Cloud's Qwen team, Apache-2.0) converted to ONNX and published by `onnx-community` and `webgpu` on Hugging Face. They are pinned to a commit and by SHA-256 in `web/js/web/ai/inbrowser/ib-models.js` (part of the files the service worker verifies) and are only downloaded after your confirmation.
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
* **Tarayıcıda çalışan asistan** (`web/js/web/ai/inbrowser/`, service worker'ın iki worker için kuralları, sabitlenmiş model kataloğu; aşağıda "Tarayıcıda yapay zekâ").
* Kapsam dışı (ilgili üreticiye bildirin): Foundry Local'in kendisi, Ollama, LM Studio, bulut sağlayıcıları, Hugging Face ve modellerin yazarları, tarayıcınız.

### Tasarım (kendiniz doğrulayabilirsiniz)

* **Videolarınız bilgisayarınızdan çıkmaz.** Web sürümü, tarayıcının kendi dosya seçicisiyle seçtiğiniz dosyaları okur, sayfa içinde
  WebCodecs ile düzenler ve sonucu kaydetme penceresiyle yazar. Yükleme noktası yoktur. Sayfadan çıkabilecek **tek** istekler, sizin açtığınız
  isteğe bağlı AI asistanına aittir: bu bilgisayardaki bir model sunucusuna (Ollama, LM Studio; Foundry Local tarayıcı uzantısı üzerinden, aşağıya bakın), seçip onayladığınız sağlayıcıya ya da - tarayıcıda çalışan model için - model dosyalarının Hugging Face'ten indirilmesine, bir soruyla onayınız alındıktan sonra (aşağıda "Tarayıcıda yapay zekâ") (komutunuz ve zaman çizelgesinin
  *metin* özeti; Foundry *video analizi* açıksa, her seferinde onayınızla videonun küçük bir kopyası **kendi** Azure kaynağınıza gider ve - bir zoom'un
  bir nesneye kilitlenmesi gerekiyorsa - her seferinde ayrı bir onayla (resim sayısı, nesne ve model yazılır) birkaç küçük resim (en fazla 640 piksel) **kendi**
  sohbet modelinize gider; bu uygulama onları saklamaz, modelin hizmetinde o hizmetin veri politikası geçerlidir; her resim en fazla 640 piksel ve 120 KB'tır, çağrı başına en fazla 64 istek yapılır ve sağlayıcı bağdaştırıcısının hız sınırı/ağ hatası sonrası yinelediği bir istek aynı resmi aynı adrese taşır).
* **Ağ yolları ve izin listeleri.** Sayfanın İçerik Güvenliği Politikası `connect-src 'self'` şeklindedir. Bulut / model sunucusu asistanının istekleri, kendi
  politikasıyla sunulan ayrı bir worker tarafından (`web/js/web/ai/net-worker.js`) yapılır: `127.0.0.1` / `localhost`, üç bilinen sağlayıcı
  adresi ve ayarlarda onayladığınız https adresleri. Yönlendirme, çerez ve referrer yoktur. Tarayıcıdaki asistanın model dosyalarını ikinci bir özel worker indirir
  (`ib-dl-worker.js`); politikası yalnızca bu siteyi ve Hugging Face'i adlandırır ("Tarayıcıda yapay zekâ" bölümüne bakın).
* **API anahtarı, secret, token veya hesap gerekmez ve yoktur** (kaynakta da yayınlanan sitede de). Bir bulut sağlayıcısı için yazdığınız anahtar
  `sessionStorage` içinde (yalnızca bu sekme; sekme kapanınca silinmesi amaçlanır) tutulur, yazıldığı adrese bağlıdır, yalnızca oraya gönderilir; bu site onu projeye
  veya dosyaya yazmaz. Chromium tabanlı bir tarayıcı yine de açık sekmenin oturum verisinin bir kopyasını (çökme kurtarma, "kapatılan sekmeyi yeniden aç") kendi
  profil klasöründe tutabilir; bu yüzden paylaşılan bir bilgisayarda iptal edebileceğiniz bir anahtar kullanın.
* **Telemetri, çerez, izleme yoktur.** Sayfa bu tarayıcıda şunları saklar: ayarlarınız (`localStorage`), onayladığınız adresler (`localStorage` ve ağ işçisi için bir Cache Storage kopyası), sitenin kendisinin çevrimdışı kopyası (Cache Storage, service worker), indirdiyseniz tarayıcıdaki asistanın model dosyaları (Cache Storage, model başına 1,5 veya 2,8 GB; ayarlardan silinebilir) ve yalnızca isteğe bağlı Foundry video analizini kullanırsanız sonuçları (IndexedDB: videolarınızın sahne açıklamaları ve konuşma metni, bu bilgisayarda kalır; 30 gün / 100 MB).
* **Çalışma anında üçüncü taraf kod yüklenmez.** Az sayıdaki kütüphane (editörün video kütüphanesi ve tarayıcıdaki modeli çalıştıran iki kütüphane) `web/vendor/` içine kopyalanmış ve SHA-256 ile sabitlenmiştir
  (`web/vendor/vendor-lock.json`); biri değişirse derleme başarısız olur. Bunlardan birinde tek bir bildirilmiş değişiklik vardır - GitHub'ın gizli anahtar taramasının API anahtarı sandığı bir sınıf adı alt çizgiyle yazılmıştır, bkz. `web/THIRD-PARTY-NOTICES.txt` - ve resmî dosyanın ile yamalı dosyanın SHA-256 değerleriyle bir yama olarak kaydedilmiştir; `node scripts/vendor.js verify` bunu çevrimdışı kanıtlar. Sayfanın İçerik Güvenliği Politikası (CSP) yalnızca sitenin
  kendi betiklerine izin verir (satır içi betik yok, `eval` yok); GitHub Pages özel başlık gönderemediği için aynı politikayı
  (`frame-ancestors 'none'` ile birlikte) bir service worker HTTP başlığı olarak ekler.
* **Service worker sunduğunu denetler.** Önbellekte tuttuğu her şey derleme manifestinin SHA-256 değeriyle karşılaştırılır; manifest de, hash'i derleme sırasında worker
  betiğinin kendisine yazılmış olan manifest olmak zorundadır. Değişmiş veya sahte bir önbellek kaydı atılır, dosya ağdan gelir (nedeni için aşağıdaki "Barındırma" bölümüne bakın).
* **Bu bilgisayardaki bir model sunucusuna (web sürümü) yalnızca sunucu sayfayı içeri alırsa ulaşılır.** Ollama (`OLLAMA_ORIGINS`) yalnızca bu siteye izin verebilir. LM Studio'nun "Enable CORS" anahtarı açıkken **her** web sitesine izin verir:
  gezdiğiniz başka siteler de o sunucuya istek gönderebilir; bu yüzden yalnızca gerektiğinde açın. Chrome / Edge, internetteki bir sayfa bu bilgisayardaki bir programla konuşmadan önce bir kez sorar ("yerel ağ erişimi"). Foundry Local hiçbir sayfayı içeri almaz; web sürümü ona yalnızca tarayıcı uzantısı üzerinden ulaşır (aşağıda).
* **Dürüst sınırlar:** "bilinen açık yok", "açık yok" demek değildir. Tarayıcılar ve kodekleri (videonuzu çözen kısım) büyük programlardır;
  tarayıcınızı güncel tutun ve yalnızca güvendiğiniz kaynaklardan video açın. Seçtiğiniz bulut sağlayıcısı kendisine gönderdiklerinizi görür.

### Tarayıcıda yapay zekâ (web sürümü): sayfanın içinde çalışan model

Web sürümünün varsayılan asistanı bir yapay zekâ modelini **tarayıcı sekmesinin içinde, ekran kartınızda** (WebGPU) çalıştırır. Hiçbir şey kurulmaz: program yok, `.bat` dosyası yok, tarayıcı eklentisi yok. Yaptıkları ve yapmadıkları:

* **Ne indirilir, nereden.** Yalnızca **model dosyaları** - veri: ONNX ağırlıkları, tokenizer ve yapılandırma, 1,5 / 2,8 GB - Hugging Face'ten (`huggingface.co`; içerik ağı `*.hf.co`'ya yönlendirir); önce modeli, boyutunu, depoyu, sürümü (commit) ve nelerin saklanacağını yazan bir soru sorulur.
  Hugging Face indirmeyi (IP adresinizi) görür; komutlarınız, videolarınız ve anahtarlarınız oraya gönderilmez. Modeli çalıştıran kütüphaneler (transformers.js, Apache-2.0; ONNX Runtime Web, MIT) başka bir yerden **alınmaz**: bu sitenin parçasıdır (`web/vendor/`, SHA-256 ile sabitli, yukarıya bakın).
* **Her bayt denetlenir.** Her modelin deposu ve **commit**'i `web/js/web/ai/inbrowser/ib-models.js` içinde, her dosyanın boyutu ve SHA-256'sı ile her 16 MiB'lık bloğunun SHA-256'sıyla birlikte sabitlenmiştir. Dosyayı `web/scripts/ib-model-lock.js` üretir: her dosyayı indirir ve Hugging Face'in yayımladığıyla (LFS özeti veya küçük dosyanın git blob kimliği) karşılaştırır.
  İndirme worker'ı baytları tarayıcının deposuna yalnızca ait oldukları blok sabitlenmiş özete sahipse verir; motor, bir dosyayı geri okurken aynı özetleri yeniden denetler (aynı hesabın başka bir deposundaki sayfa bu kökeni paylaşır ve Cache Storage'a yazabilir, bkz. "Barındırma"). Uyuşmayan dosya asla saklanmaz veya kullanılmaz; saklanmışken değişmiş olan silinir ve yeniden indirmek önerilir.
  Sayfa modeli yalnızca **katalogdaki anahtarıyla** adlandırır: adres, dosya adı ve özet sayfadan gelmez; Hugging Face dışındaki bir adrese yönlendirilen indirme reddedilir.
* **İki worker, her birinin kendi politikası var** (service worker bunları HTTP başlığı olarak ekler; GitHub Pages bunu kendisi yapamaz): **indirme worker'ı** bu siteyle ve `huggingface.co` / `*.hf.co` ile konuşabilir, WebAssembly derlemez, worker başlatmaz; modeli çalıştıran **motor worker'ı** WebAssembly derleyebilir (`wasm-unsafe-eval`) ama **yalnızca bu kökenle** konuşabilir (`connect-src 'self'`; `github.io`'da bu, hesabın tüm Pages sitelerini kapsar, bkz. "Barındırma") ve o da worker başlatmaz - içinde çalışan hiçbir şey başka bir adrese ağ bağlantısı kuramaz. (Bu politikanın kapsamadığı şey kökenin kendi depolaması ve ileti kanallarıdır - `github.io`'da hesabın diğer Pages siteleri bunları paylaşır; bkz. "Barındırma".)
  Sayfanın kendi politikası değişmedi (`wasm-unsafe-eval` yok, `connect-src 'self'`). Motorun kütüphaneleri - aralarında 26 MB'lık bir WebAssembly dosyası - derleme manifestinin **tembel listesinde**dir: çevrimdışı kopyaya girmez, model ilk kullanılırken alınır ve service worker onları yalnızca boyutları ve SHA-256'ları manifestinkiyle aynıysa sunar (değilse HTTP 502; önbellekteki kopya her kullanımda yeniden denetlenir).
* **Bu korumalar service worker'a aittir; bu yüzden asistan onu arar.** Bir dosya kendi HTTP başlıklarını taşıyamaz: sayfayı kontrol eden bir service worker yoksa (service worker'ı olmayan bir tarayıcının özel penceresi, onları kapatan bir ilke) iki worker politikalarsız çalışır ve kütüphaneler denetlenmezdi. Bu yüzden asistan o durumda **başlamaz** (panelin 1. adımı nedenini söyler). Başlıklara bağlı olmayan iki koruma daha vardır: motor worker'ı modeli yüklemeden önce **ağ bağlantısı kuramadığını sınar** - bir `data:` adresine (ağ gerektirmez; yani çevrimdışı olmak ya da Hugging Face'in engellenmesi sınamayı geçmiş gibi göstermez) ve başka bir siteye istek, ikisi de reddedilmelidir; değilse modeli yüklemez - ve service worker tarayıcıdaki model özelliğinin kodunu (`js/web/ai/inbrowser/`) ve modelin kütüphanelerini **yalnızca manifestteki adreste ve yalnızca manifestteki baytlarla, hem önbellekten hem ağdan** sunar: kapsamındaki düz yazılmamış her adres (çift eğik çizgi, `%` kaçışı, ters eğik çizgi) 404'tür, farklı harf büyüklüğü de (`Vendor/…`); denetlenmiş manifest yokken - önbellek boşaltılmışsa - önbellek yeniden doldurulana kadar 503'tür, ağdan gelen bayt manifestinki değilse 502'dir. Denetlenmemiş dosya asla verilmez.
* **Modele ne verilir:** komutunuz, zaman çizelgesinin metin özeti ve - yalnızca buna ihtiyaç duyan bir şey isterseniz ("köpeği yakınlaştır") - videodan küçük resimler. Hepsi sekmede kalır (worker'a bir ileti); anahtar ve hesap yoktur.
* **Ne saklar:** model dosyalarını Cache Storage'ta (`ve-ib-models-v1`; *İndirileni sil* kaldırır), seçilen modeli `localStorage`'ta. Sayfa tarayıcıdan dosyaları tutmasını ister (`navigator.storage.persist()`: yalnızca bir istek). Model 10 dakika istek gelmezse bellekten kalkar (*Belleği boşalt* hemen yapar).
* **Dürüst sınırlar.** (1) Hugging Face ve depolar (`onnx-community`, `webgpu`) üçüncü taraflardır: sabitlenmiş commit ve özetler *tam olarak, özetleri Hugging Face'in yayımladıklarıyla karşılaştırılmış dosyaları aldığınızı* garanti eder - modeli kimse denetlemedi ve kusursuz değildir. Model dosyası ONNX Runtime'ın yorumladığı veridir ve bu yorumlayıcıdaki bir hata, ilke olarak kötü niyetli bir dosyayla tetiklenebilir - cevap sabitleme (dosya sonradan kimse tarafından değiştirilemez), yalnızca bu kökene erişebilen motor worker'ı (her başlangıçta sınanır) ve tarayıcının korumalı alanıdır; garanti değildir.
  (2) Küçük model çoğu zaman yanılır: yalnızca zaman çizelgesini düzenleyebilir (tek `Ctrl+Z` hepsini geri alır), dosyalara, ağa veya kabuğa erişimi yoktur; video resimlerindeki veya dosya adındaki metin onu yönlendirebilir ama bundan fazlasını yapamaz (modelin denetim belirteçleri ona ulaşmadan düz metne çevrilir, bu yüzden bir dosya adı konuşmaya sahte bir tur ekleyemez). Daha küçük bir 0,8B model denendi ve düzenleme komutlarını yapamadığı için sunulmuyor. (3) Yüklüyken bellek ister (bilgisayarın belleğini paylaşan tümleşik ekran kartında ölçüldü: 2B model için yaklaşık 5 GB, 4B model için yaklaşık 10 GB); iki sekme iki kopya yükler. (4) Şirket ağları `huggingface.co` / `hf.co` adreslerini engelleyebilir; elle iptal edilen indirme baştan başlar (kopan veya susan - 60 sn boyunca bayt gelmeyen - bağlantı kendiliğinden kaldığı yerden sürdürülür).
  (5) Kütüphaneler ONNX Runtime Web'in geliştirme derlemesidir (transformers.js'in derlendiği, sabitlenmiş sürüm); paketlenmiş bir kütüphane hakkındaki zafiyet bildirimine sabitin güncellenmesiyle yanıt verilir.

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
* **Tarayıcıdaki modelin dosyaları** üçüncü tarafın verisidir: Hugging Face'te `onnx-community` ve `webgpu` tarafından yayımlanan, ONNX'e çevrilmiş Qwen3.5 (Alibaba Cloud Qwen ekibi, Apache-2.0). `web/js/web/ai/inbrowser/ib-models.js` içinde (service worker'ın doğruladığı dosyalardan biri) bir commit'e ve SHA-256 değerlerine sabitlenmiştir ve yalnızca onayınızdan sonra indirilir.
* **Tarayıcı uzantısı** `web/extension/` klasöründen `web/scripts/pack-extension.js` ile yeniden üretilebilir bir zip'e derlenir (her derlemede aynı baytlar). SHA-256 değeri GitHub'daki `foundry-bridge-v1.0.0` sürüm notunda yazar - zip'i sunan siteden başka bir yerde - ve pencere karşılaştırmak için `Get-FileHash` komutunu gösterir.
  **İmzalı değildir ve mağazada yayınlanmamıştır**, yukarıda anlatılan haklarla çalışır: yüklemeden önce hepsini okuyabilirsiniz (yaklaşık 700 satır JavaScript).

### Bununla ilgili depo ayarları (bakımcı için)

Hesapta iki adımlı doğrulama veya passkey · `main` için dal koruması (çekme isteği; ortak çalışan olunca `.github/CODEOWNERS` sahiplerinin incelemesi) · `github-pages` ortamının yalnızca
`main` dalıyla sınırlanması · Pages kaynağı "GitHub Actions" (asla "Deploy from a branch") · gizli bilgi taraması + push koruması ve özel güvenlik açığı bildirimi açık · Actions yalnızca sahibin ve doğrulanmış
üreticilerin eylemlerine izinli · yalnızca `main` gönderin (`--mirror` / `--all` değil).

# Video Editör · Web edition (v4)

**Live site / Canlı site:** <https://ahmetcanalaca.github.io/videoeditor/>

The same compact editor as the Windows app, as a **static website**: no server code, no installation, no account, and **no API key to edit videos**.
Your videos are opened with the browser's own file picker, decoded and encoded **inside the page** (WebCodecs, through the
[Mediabunny](https://github.com/Vanilagy/mediabunny) library) and the result is written with the browser's save dialog.
**Nothing is uploaded anywhere** unless you switch on the optional Foundry video analysis (then, each time you confirm it, a reduced copy goes to *your own* Azure resource). After the first visit the site also works **offline** (service worker).
The optional **AI assistant** is the same as in the Windows app: it talks to the provider *you* choose with *your* key, or to a model server on *your* computer that allows browsers (Ollama, LM Studio). **Foundry Local** is used from the Windows app: a web page cannot reach it (explained below).

Windows uygulamasıyla aynı kompakt editör, **statik bir web sitesi** olarak: sunucu kodu, kurulum, hesap yok; **video düzenlemek için API anahtarı gerekmez**.
Videolarınız tarayıcının kendi dosya seçicisiyle açılır, **sayfanın içinde** çözülür/kodlanır (WebCodecs, Mediabunny kütüphanesi üzerinden)
ve sonuç tarayıcının kaydetme penceresiyle yazılır. **İsteğe bağlı Foundry video analizini açmadıkça hiçbir şey bir yere yüklenmez** (açarsanız her seferinde onayınızla küçültülmüş bir kopya *kendi* Azure kaynağınıza gider). İlk ziyaretten sonra site **internetsiz** de çalışır.
İsteğe bağlı **AI asistanı** Windows uygulamasındakiyle aynıdır: *sizin* seçtiğiniz sağlayıcıyla (*sizin* anahtarınızla) ya da *sizin* bilgisayarınızdaki, tarayıcılara izin veren bir model sunucusuyla (Ollama, LM Studio) çalışır. **Foundry Local** Windows uygulamasından kullanılır: bir web sayfası ona bağlanamaz (aşağıda açıklanıyor).

## Use it / Kullanım

<p>
  <img src="../docs/screenshots/web-03-editor-tr-dark.png" alt="Web edition, Turkish, dark theme" width="49%">
  <img src="../docs/screenshots/web-02-empty-en-light.png" alt="Web edition, English, light theme" width="49%">
</p>
1. Open the site in **Chrome or Edge** (a current version). Türkçe is the default language, dark the default theme (switch in the title bar; the choice is remembered).
2. Add videos (button or drag & drop), cut them on the timeline (split `S`, delete `Delete`, undo `Ctrl+Z`), set speed (0.25–8×), zoom in / out / hold with a focus point, volume, fades.
3. **Export** → pick the file in the save dialog → MP4 (H.264 + AAC). The export shows progress, can be cancelled and never overwrites a source file.

| | Web edition | Windows app |
|---|---|---|
| Split, cut, delete, reorder, merge, speed, zoom, volume, fades, undo/redo, projects (`.vedproj`) | ✔ | ✔ |
| MP4 export with progress / cancel | ✔ (WebCodecs, ≈2.6× real time for 1080p on a laptop) | ✔ (FFmpeg) |
| Works offline | ✔ after the first visit | ✔ |
| Installation / administrator rights | none | per-user installer or portable folder |
| Formats it can open | what the browser decodes: MP4, MOV, M4V, MKV, WebM, MPEG-TS with H.264 / VP8 / VP9 / AV1 (HEVC only where the browser has hardware support) | everything FFmpeg reads (AVI, WMV, FLV, MPG …, with a preview proxy) |
| AI assistant (optional) | ✔ cloud providers with your key, a model server on this computer that allows browsers (Ollama, LM Studio), Foundry video analysis | ✔ built-in local model, **Foundry Local**, cloud providers, other local servers, Foundry video analysis |
| Browsers | Chrome / Edge (tested, full). Other browsers are not tested: without the save picker the export is built in memory (limit ≈1.2 GB) and downloaded | – |

### AI assistant (optional) / AI asistanı (isteğe bağlı)

<p>
  <img src="../docs/screenshots/web-07-ai-assistant-tr-dark.png" alt="The assistant cuts the first 3 seconds (Turkish, dark)" width="49%">
  <img src="../docs/screenshots/web-06-ai-settings-foundrylocal-tr-dark.png" alt="Settings: Foundry Local is used from the Windows app (Turkish, dark)" width="49%">
</p>
<p>
  <img src="../docs/screenshots/web-08-ai-settings-foundry-cu-en-light.png" alt="Settings: Microsoft Foundry with video analysis (English, light)" width="49%">
</p>

Type what you want ("cut the first 3 seconds", "speed up the quiet parts", "zoom in on the dog") and the assistant edits the timeline; everything it did is **one undo step**.
It is the desktop app's assistant, unchanged (`scripts/sync-desktop.js` bundles the desktop code instead of copying it by hand). Open it with the **AI** button; the settings dialog offers:

| Provider | What runs where | Needs |
|---|---|---|
| OpenAI-compatible, Azure OpenAI, **Microsoft Foundry**, Anthropic, Gemini | The page calls the provider directly from your browser. Only your command and a **text** summary of the timeline are sent. | Your own API key (kept for this tab only and never written to a project; the browser may keep a copy of an open tab's session data in its profile). Entra ID: paste a short-lived access token. |
| **Model server on this computer** (Ollama, LM Studio, llama.cpp …) | On this computer; nothing leaves it. A model without tool calling still works: the tools are written into the prompt. | The server must allow this site (CORS), e.g. `OLLAMA_ORIGINS` for Ollama, "Enable CORS" in LM Studio. |
| **Foundry Local** (Microsoft) | **Windows app only.** A web page cannot connect to it: its server (checked with version 0.14) sends no CORS headers, which browsers require, and it has no setting for them. The Windows app is not a browser: it finds Foundry Local itself, lets you pick, download and load a model (e.g. `qwen3.5-4b`) and can have it look at the picture of the video. The settings dialog shows this explanation with the official links. | Install Foundry Local ([official installer](https://aka.ms/foundry-local-installer) or `winget install Microsoft.FoundryLocal`) and use the [Windows app](https://github.com/ahmetcanalaca/videoeditor/releases/latest). No key, no account. |
| **Foundry + Content Understanding** | Optional *video analysis*: with your confirmation each time, a small copy of your video is uploaded to **your** Azure resource; the result (scene descriptions, speech) comes back as text. For a zoom that has to aim at an object, a few small pictures (≤ 640 px, ≤ 120 KB each) can also be shown to your chat model, after a separate confirmation every time (the analysis says *when*, the pictures say *where*; this app does not keep them, the model service's own data policy applies). | A Foundry / Azure AI resource with Content Understanding; a chat model that accepts pictures (e.g. `gpt-4.1`) for the position. |

Türkçe özet: bulut sağlayıcıları kendi anahtarınızla çalışır; bu bilgisayardaki bir model sunucusu (Ollama, LM Studio) tarayıcılara izin verirse (CORS) kullanılabilir. **Foundry Local** web sürümünden kullanılamaz (sunucusu tarayıcıların istediği CORS başlıklarını göndermiyor); Windows uygulaması ona doğrudan bağlanır: Foundry Local'i resmî bağlantıdan kurun, uygulamada AI ayarlarında *Foundry Local*'ı seçin.

How it is kept safe:

* **One network path.** The page itself can only talk to its own origin (`connect-src 'self'`). Every request of the assistant goes through a small worker (`js/web/ai/net-worker.js`) that has its own, stricter policy:
  `127.0.0.1` / `localhost`, the three well-known provider origins, and the https origins **you confirmed** in the settings (asked whenever you enter a key for such an address, saying what is sent there). No redirects, no cookies, no referrer.
* **Keys.** A browser has no secure key store, so a cloud key lives in `sessionStorage` (this tab only, meant to be gone when the tab closes; a Chromium-based browser may still keep a copy of an open tab's session data in its profile folder for crash recovery, so on a shared computer use a key you can revoke), is bound to the origin it was typed for, is only ever sent to that origin, and is never part of a project file.
* **Hosting.** Browsers isolate by origin, not by path: this site shares `*.github.io` with every other Pages site of the account. The service worker therefore verifies every cached file against the build manifest (whose hash is baked into the worker script), and you should not host untrusted content on other repositories of the same account (or give this site its own domain).

Limits of the AI part: Chrome/Edge ask once for permission to "access devices on your local network" (Local Network Access, Chrome/Edge 142+) the first time the page talks to a model server on `127.0.0.1` (choose *Allow*; if you chose *Block*, the error message says where to change it: site settings > Local network access / Loopback network; on a company computer IT can pre-allow it with the policy `LoopbackNetworkAllowedForUrls` for this site; `tests/lna.test.js` runs the real browser check). A cloud provider has to allow browser calls (OpenAI, Anthropic, Gemini and Azure do); the Foundry / Content Understanding path is tested against a mock and the services' CORS answers, not against a live resource in this release.

### Known limits

* The browser decides what it can decode: no AVI / WMV / FLV, no HEVC on machines without hardware support. HDR sources are converted to SDR without tone mapping (the editor warns about it).
* Export speed depends on your GPU/CPU and the browser's hardware encoder; very long 4K projects are far faster with the Windows app.
* Shortcuts `Ctrl+N`, `Ctrl+T`, `Ctrl+W` belong to the browser: use the toolbar button for a new project.
* A project file stores the media **names**, not paths (a web page cannot know paths): opening a project asks you to pick the media again.

## Privacy and security

* The page's Content-Security-Policy only allows its own origin (a service worker adds the same policy as an HTTP header, plus `frame-ancestors 'none'`, which GitHub Pages cannot send itself). There is no upload endpoint, no analytics, no cookies and no third-party request from the editor. The **only** requests that can leave the page are the assistant's, made on purpose through its network worker (see above): to `127.0.0.1`, or to a provider you chose and confirmed.
* No API key, token or secret exists anywhere in this site or its source. (A key you type for a cloud provider stays in your tab.)
* Libraries are vendored and pinned by SHA-256 (`vendor/vendor-lock.json`, checked by every build); nothing is loaded from a CDN.
* Details and how to report a problem: [SECURITY.md](../SECURITY.md). "No known vulnerabilities" is not "no vulnerabilities": keep your browser up to date and only open videos you trust.

## Develop / Geliştirme

```text
cd web
node scripts/serve.js                 # http://127.0.0.1:<port>/ (the site as GitHub Pages serves it)
node scripts/build.js                 # builds _site/ (what is published: service worker with the build id, precache list, .nojekyll, 404.html)
node scripts/sync-desktop.js          # regenerates what is taken from the desktop sources (add --check to only verify)
node scripts/vendor.js verify         # vendored libraries == vendor-lock.json
node tests/audio-dsp.test.js          # unit tests (no browser)
node tests/ai-core.test.js            # the desktop assistant code running in the web bundle (agent loop, providers incl. the tools-in-the-prompt fallback, endpoints, find_in_video, crypto shims)
node tests/smoke.test.js              # real Chrome/Edge (set VE_BROWSER to its path if it is not found)
node tests/ui.test.js                 # the whole UI: languages, themes, import, editing, shortcuts, export dialog, projects
node tests/ai.test.js                 # the assistant in the browser: a model server on this computer, cutting by command, cancel, wrong key, a model without tool calling, cloud providers, trust dialogs, the Foundry Local explanation
node tests/cu.test.js                 # Foundry + Content Understanding video analysis against the desktop app's mock of the service
node tests/locate.test.js             # the zoom aims at WHERE the object is: pictures after a question every time, a stand-in vision model that decodes every JPEG (tests/locate-world.js)
node tests/lna.test.js                # Local Network Access as Chrome/Edge enforce it (page counts as public, model server on loopback): refusal, grant, settings written by another page                # service worker: offline, headers, network-worker policy, integrity of the cache, update flow
node tests/export.test.js             # 27 export cases checked with ffprobe/ffmpeg (set VE_FFMPEG / VE_FFPROBE, or keep the desktop vendor\ffmpeg\bin next to the repo)
```

The renderer in `js/` is the Windows app's UI; `js/web/` replaces what Electron provided (file access, settings, export engine, projects, the assistant's network and key handling) with
browser APIs. The editing model and the assistant's brain (`js/shared/`, `js/web/ai/desktop-core.js`) come from the desktop app and are regenerated, not forked.

### Publish your own copy

Fork the repository → *Settings → Pages → Source: GitHub Actions* → push to `main`. The workflow `.github/workflows/pages.yml`
verifies the vendored libraries, builds `web/_site` and deploys it. A project site lives under `/<repository name>/`; all URLs in the site are relative.
The browser tests above are not run on every push (a hosted runner has no ffmpeg and no reliable package mirror); `.github/workflows/browser-tests.yml` starts them by hand, and `npm test` runs them on your own computer.

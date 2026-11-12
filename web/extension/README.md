# Video Editor – Foundry Local bridge (browser extension)

Lets the **Video Editor web app** (<https://ahmetcanalaca.github.io/videoeditor/>) use **Foundry Local** on your own computer — free, no API key, nothing leaves the computer.
Works in Microsoft Edge and Google Chrome (version 116 or newer). · *Türkçe özet en altta.*

## Why an extension?

Foundry Local's web service listens on `127.0.0.1` only and sends no CORS headers (checked with Foundry Local 0.14), so a web page can never read its answers. An extension
with host permission for `127.0.0.1` can. It carries a small, fixed set of requests for the web app — and nothing else.

## Install (once, about a minute)

1. Download `video-editor-foundry-bridge.zip` from the app's AI settings (choose **Foundry Local**) or from the GitHub release, and extract it into a folder you will keep
   (e.g. `Documents\VideoEditor-FoundryBridge`). The extension runs from that folder.
2. Open `edge://extensions` (Edge) or `chrome://extensions` (Chrome) and switch on **Developer mode**.
3. Press **Load unpacked** and choose the folder.
4. Go back to the web app: the first step of the Foundry Local panel turns green by itself (no reload).

Update: extract the new zip over the folder, then press the reload icon of the extension. Remove: **Remove** on the extensions page.

Check the download before you load it: `Get-FileHash .\video-editor-foundry-bridge.zip -Algorithm SHA256` (PowerShell) must give the SHA-256 that is written in the
[release notes](https://github.com/ahmetcanalaca/videoeditor/releases/tag/foundry-bridge-v1.0.0) on GitHub (the zip is built reproducibly: the same sources give the same bytes). The extension is not signed and not in a store.

> On a company computer Developer mode may be switched off by policy. Ask IT to approve the extension (it is small and its source is here), or use the desktop app.

## What it may do — and what it may not

| Permission | Why |
| --- | --- |
| `http://127.0.0.1/*` (host) | to talk to Foundry Local. Nothing else on the network is contacted. |
| `https://ahmetcanalaca.github.io/videoeditor/*` (host + the one content script) | to serve the web app, and only it. |
| `storage` | to remember the sites you allowed, the last port and the language of the app. Only the extension's own pages and worker can read it (`TRUSTED_CONTEXTS`). |
| `scripting` | to put the bridge into an already open page of the app right after installing, so you do not lose an unsaved project by reloading. |

* **You approve each site once**, in a window of the extension itself (the page cannot answer for you; "Allow" becomes active a second and a half after the window opens, so a click that was meant for the page cannot approve). The window shows the site's origin as the browser reports it.
  Withdraw it any time: toolbar icon → **Remove**. A window that another page opened (`window.open`) is not served at all: its opener could reach into it.
* A page can ask for **four things by name** — `models`, `loaded`, `load`, `chat` — never for an address, a port, a method or headers. A model id must look like
  `qwen3.5-4b-generic-cpu:3`; a chat request must be a JSON object with a model and messages (no streaming; pictures only as JPEG data, never as an address; at most 24 MB; the answer is capped at 8 MB;
  at most two requests at a time and a short queue behind them). What is sent on is the checked object, written again. Foundry Local's `/status` (the extension reads it itself), `/shutdown`, unloading and its other services are not reachable for a page.
* The extension **verifies that what answers is Foundry Local**: `GET /status` must describe itself as Foundry Local at exactly that address - and it looks again after 30 seconds without a request,
  before anything else is sent. A program that took over the port of a server that was stopped meanwhile and does not answer like Foundry Local (or says nothing) receives only that `GET /status`, none of your prompts.
* Finding the port: the last port, then `5272`; a scan of `49152–65535` (loopback only) runs **only when you press “Find automatically”** in the page or in the extension's window. The page cannot name a port.
  Another port is typed into the extension's own window (toolbar icon). Tip: `foundry config set port 5272` fixes the port for good.
* No cookies, no referrer, no redirects, no telemetry. Prompts, pictures and answers pass through and are **not stored or logged**.

Residual risk, as with every local model server: Foundry Local takes no key, so other programs on the computer can talk to it too, and a site you allowed can use the loaded model.
The extension cannot see which program owns a port, so a program that imitates the whole `/status` answer of Foundry Local on a free port (it is public, easy to copy) could still be mistaken for it (the desktop app compares the process id and the port's owner; a browser extension cannot).
Every GitHub Pages page of an account shares one origin — only allow sites you trust. On a shared Windows (Remote Desktop, multi-session) use the desktop app's built-in model instead.

## For developers

* `policy.js` – the rules (pure functions; unit-tested), `background.js` – the service worker, `content.js` – the page ↔ worker relay, `popup.*` / `consent.*` – the windows.
* `node scripts/pack-extension.js` (in `web/`) builds a reproducible zip; `npm test` in `web/` runs `tests/ext-policy.test.js` (rules, manifest, package),
  `tests/fl-bridge.test.js` (the extension in a real browser against a stand-in for Foundry Local) and `tests/fl-web.test.js` (the whole path with the assistant).
* The test build only adds `http://127.0.0.1/*` and `http://localhost/*` to the pages that are served; nothing else differs.
* The browser must allow loading it from the command line for the tests: `--load-extension` with `--disable-features=DisableLoadExtensionCommandLineSwitch` (Chrome / Edge 137+).

MIT licence (see the repository's `LICENSE`).

---

### Türkçe özet

Foundry Local'in sunucusu tarayıcılar için gereken CORS izin başlıklarını göndermez; bu yüzden bir web sayfası ona doğrudan bağlanamaz. Bu küçük eklenti, **Video Editör web uygulamasına**
bu bilgisayardaki Foundry Local ile konuşma imkânı verir: ücretsiz, anahtarsız, hiçbir şey bilgisayardan çıkmaz.

**Kurulum (bir kez):** zip'i kalıcı bir klasöre çıkarın → `edge://extensions` (veya `chrome://extensions`) → **Geliştirici modu** açık → **Paketlenmemiş öğe yükle** → klasörü seçin.
Uygulamanın yapay zekâ ayarlarında Foundry Local adımları kendiliğinden yeşile döner (sayfayı yenilemek gerekmez). Zip'i yüklemeden önce `Get-FileHash .\video-editor-foundry-bridge.zip -Algorithm SHA256` ile denetleyip GitHub'daki sürüm notunda yazan SHA-256 ile karşılaştırın.

**Güvenlik:** her siteye bir kez, eklentinin kendi penceresinde izin verirsiniz (**İzin ver** düğmesi pencere açıldıktan bir buçuk saniye sonra etkinleşir); sayfa yalnızca dört bilinen istek (`models`, `loaded`, `load`, `chat`) isteyebilir, adres ve port seçemez (başka bir portu eklentinin kendi penceresine yazarsınız);
eklenti yalnızca kendini Foundry Local olarak tanıtan bir sunucuya istek gönderir (30 saniye istek gelmezse adrese yeniden bakar); port taraması yalnızca “Otomatik bul”a bastığınızda yapılır; istemler, kareler ve yanıtlar saklanmaz.
Foundry Local anahtar istemez: bilgisayardaki diğer programlar da ona konuşabilir; uzantı bir portun hangi programa ait olduğunu göremez (paylaşılan Windows'ta masaüstü uygulamasının yerleşik modelini kullanın).
Şirket bilgisayarında Geliştirici modu kapalıysa BT biriminden eklentiyi onaylamasını isteyin veya masaüstü uygulamasını kullanın.

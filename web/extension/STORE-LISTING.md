# Store listing material (Microsoft Edge Add-ons / Chrome Web Store)

Not published. This is what a maintainer needs if they decide to publish the extension in a store (a store build can be updated by the browser and force-installed by a company's IT;
publishing needs the maintainer's own developer account). The package is `video-editor-foundry-bridge-<version>.zip` (`node scripts/pack-extension.js`).

## Name and summaries

* **Name (≤ 45):** Video Editor – Foundry Local bridge
* **Short description (≤ 132):** Lets the Video Editor web app use Foundry Local on this computer. It talks to 127.0.0.1 only; nothing leaves your computer.
* **Category:** Developer tools / Productivity

## Single purpose

Connects the Video Editor web app (`https://ahmetcanalaca.github.io/videoeditor/`) to Foundry Local, Microsoft's local AI model runner on the user's own computer, because Foundry Local's local web
service sends no CORS headers and a web page therefore cannot read its answers.

## Long description

Video Editor is a free web video editor (https://ahmetcanalaca.github.io/videoeditor/). Its optional AI assistant can use Foundry Local, Microsoft's tool that runs AI models on your own computer —
free, no API key, nothing leaves the computer. A web page cannot talk to Foundry Local directly; this small extension is the bridge.

* The site has to be allowed once, in a window of the extension itself. You can withdraw the permission at any time from the extension icon.
* The extension passes only four known requests from the site to Foundry Local on 127.0.0.1 (models, loaded, load, chat). The site cannot choose an address, a port, a method or headers; pictures can only be JPEG data, never an address.
* It only talks to a server that describes itself as Foundry Local at exactly that address.
* The port search of the dynamic port range (49152–65535, loopback only) runs only when you press "Find automatically".
* Your prompts, the pictures the assistant looks at and the answers pass through and are not stored. No analytics, no accounts.

Requires Foundry Local (`winget install Microsoft.FoundryLocal`) and a downloaded model (`foundry model download qwen3.5-4b`).

## Permission justifications

| Permission | Justification |
| --- | --- |
| Host `http://127.0.0.1/*` | The only network destination: Foundry Local's local web service. Requests are limited to four fixed routes and are made only after the user approved the requesting site. |
| Host `https://ahmetcanalaca.github.io/videoeditor/*` and the content script | The one site this extension serves; the content script only relays messages between that page and the extension's service worker. |
| `storage` | Remembers the sites the user approved, the last Foundry Local port and the language of the app. |
| `scripting` | Puts the content script into an already open page of the site right after installation or an update, so that the user does not have to reload the editor (and lose an unsaved project). |

No remote code is loaded or executed. No `eval`. The extension pages have the CSP `script-src 'self'; object-src 'none'`.

## Privacy

* **Data collected:** none. The extension has no server and sends nothing anywhere except to Foundry Local on `127.0.0.1` on the user's own computer.
* **Data stored on the device:** the list of approved sites (origins), the last port of Foundry Local and the language of the app (`chrome.storage.local`). Nothing else; no prompts, pictures or answers.
* **Data sharing:** none. No third parties, no analytics, no advertising.
* **Contact / reports:** <https://github.com/ahmetcanalaca/videoeditor/security/advisories/new> (security), <https://github.com/ahmetcanalaca/videoeditor/issues> (other).

## Review notes for the store reviewers

* The extension is inert without Foundry Local running on the same computer; with the test build (`scripts/pack-extension.js` + `tests/fl-bridge.test.js`) a stand-in for Foundry Local is used.
* The content script is injected only on `https://ahmetcanalaca.github.io/videoeditor/*` (top frame). There is no `externally_connectable`, no `web_accessible_resources`, no native messaging.
* If the site moves to another origin, the `matches` and `host_permissions` of the manifest (one line each) and `tests/ext-policy.test.js` have to change together; there is no other place that names the site.

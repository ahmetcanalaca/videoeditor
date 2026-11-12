VIDEO EDITOR - LOCAL AI (helper of the web edition)  /  VIDEO EDITOR - YEREL AI (web sürümünün yardımcısı)
==========================================================================================================

English first, Türkçe aşağıda.


ENGLISH
-------

What is this?
  The web edition of Video Editor (https://ahmetcanalaca.github.io/videoeditor/) has an optional AI assistant. This helper runs the AI model on
  YOUR computer: it downloads the model once, checks it, and runs it on 127.0.0.1 (this computer only, never the network). The web page talks to
  it directly; your commands, the timeline summary and the pictures taken from your video do not leave your computer.
  It is the same model and the same engine as in the desktop app (Qwen3.5-4B Q4_K_M with image input, llama.cpp).

How to use it
  1. Extract this folder anywhere (for example into Documents). Nothing is installed; no administrator rights are needed.
  2. Double-click  Start-Local-AI.cmd.
  3. First run only: it downloads the engine (llama.cpp, about 40 MB, from github.com) and the model (about 3.4 GB, from huggingface.co) and checks every
     file against a pinned SHA-256 (see pins.json). A file that does not match is deleted and never started.
  4. When the window says "Ready", your browser opens the web page with a pairing link. Press "Connect" on the page. That is all.
  5. Keep the window open while you use the assistant. Close it (or press ENTER in it) to stop the model and free the memory.
     From another window:  Start-Local-AI.cmd -Stop
  Next time, double-click it again: nothing is downloaded, and the helper opens the page again with a new pairing link (a new key is made at every start).

What you need
  Windows 10 or 11 (64-bit), about 6 GB of free memory, about 4 GB of free disk space. A graphics card (Vulkan) is used when it has room, otherwise the
  processor. The first start takes a minute or so (the model is loaded into memory).

Options (add them after the name: Start-Local-AI.cmd -Port 9000)
  -Port <n>        first port to try (default 8473; the next free one is taken when it is busy)
  -Backend cpu     use the processor only (default: auto; also: vulkan)
  -Stop            stop a Local AI that runs in another window
  -Remove          delete everything this helper downloaded (asks first)
  -NoBrowser       do not open the page
  -PrepareOnly     download and check everything, then stop

Where things are
  %LOCALAPPDATA%\VideoEditor-LocalAI\   engine, model, logs and, while the model runs, its key (key.txt). If the desktop app of Video Editor already downloaded the same model
  (%APPDATA%\VideoEditor\models), it is used in place after the same check - nothing is downloaded twice.

Security and privacy
  - The model server listens on 127.0.0.1 only and every request needs a key, except the status check /health (it only says that the server is up). A new random key is made on your computer at every start (so a link or a log
    line that leaked is worthless once the window is closed) and handed to the page in the part of the address after "#", which browsers never send to a server.
  - The helper contacts github.com and huggingface.co (the downloads of the first run; the files may come from their download servers) and nothing else. No account, no telemetry.
  - The helper is a plain, readable PowerShell script (local-ai.ps1), not signed. WHAT YOU TRUST: the person who owns the repository
    (https://github.com/ahmetcanalaca/videoeditor) and GitHub. The zip on the web page and the pins come from the same site, but the workflow that publishes
    the site also attests the exact zip (signed build provenance, Sigstore, through GitHub), so you can check - with the GitHub CLI, on the file you
    downloaded, whatever the page says - that this very file was built by that workflow from this repository:
        gh attestation verify VideoEditor-LocalAI.zip --repo ahmetcanalaca/videoeditor --signer-workflow ahmetcanalaca/videoeditor/.github/workflows/pages.yml --source-ref refs/heads/main
    You can also read the script before you run it, and your IT can allow-list its hash.
  - If the window was killed, the next start stops the model of the earlier run (or reuses it when it still works).

If something does not work
  - "huggingface.co could not be reached": on a company network IT may have to allow huggingface.co and github.com (and a proxy may need your Windows
    sign-in, which the helper uses automatically). You can also download the files yourself - the window prints their addresses and the folder to put them
    in - and start again; they are checked before use.
  - Windows or your antivirus asks about the script: it is unsigned and was downloaded, so Windows is careful. If your IT blocks PowerShell scripts, use the
    desktop app, or start llama-server yourself (below).
  - The page says it cannot reach the Local AI: is the window still open? If your browser asks for permission to "access devices on your local network",
    choose Allow (the helper is on this computer). Then press "Test the connection" in the page's AI settings.
  - Port in use: the helper takes the next free port and puts it into the pairing link.
  - Anything else: the engine's log is %LOCALAPPDATA%\VideoEditor-LocalAI\llama-server.err.log.

Without this helper (other systems, or when scripts are blocked)
  Start llama-server (llama.cpp) yourself, only on 127.0.0.1, with a key of your choice, then in the page open AI settings > Local AI > "Connect by hand".
    set LLAMA_API_KEY=<a long random key>
    set LLAMA_ARG_CHAT_TEMPLATE_KWARGS={"enable_thinking":false}
    llama-server -m Qwen3.5-4B-Q4_K_M.gguf --mmproj Qwen3.5-4B-mmproj-F16.gguf --host 127.0.0.1 --port 8473 -c 24576 --parallel 2 --jinja --no-webui --no-slots

Licences
  This helper: MIT. Model Qwen3.5-4B: Apache-2.0. llama.cpp: MIT.


TÜRKÇE
------

Bu nedir?
  Video Editor'ün web sürümünde (https://ahmetcanalaca.github.io/videoeditor/) isteğe bağlı bir yapay zekâ asistanı vardır. Bu yardımcı, yapay zekâ
  modelini SİZİN bilgisayarınızda çalıştırır: modeli bir kez indirir, doğrular ve 127.0.0.1 üzerinde (yalnızca bu bilgisayar; ağa açılmaz) çalıştırır.
  Web sayfası ona doğrudan bağlanır; komutlarınız, zaman çizelgesi özeti ve videonuzdan alınan kareler bilgisayarınızdan çıkmaz.
  Masaüstü uygulamasındakiyle aynı model ve aynı motordur (görüntü girişli Qwen3.5-4B Q4_K_M, llama.cpp).

Nasıl kullanılır?
  1. Bu klasörü istediğiniz yere çıkarın (örneğin Belgelerim). Kurulum yoktur; yönetici yetkisi gerekmez.
  2. Start-Local-AI.cmd dosyasına çift tıklayın.
  3. Yalnızca ilk çalıştırmada motor (llama.cpp, yaklaşık 40 MB, github.com'dan) ve model (yaklaşık 3,4 GB, huggingface.co'dan) indirilir; her dosya
     sabitlenmiş SHA-256 değeriyle denetlenir (bkz. pins.json). Uyuşmayan dosya silinir, asla çalıştırılmaz.
  4. Pencerede "Hazır" yazınca tarayıcınız web sayfasını eşleşme bağlantısıyla açar. Sayfada "Bağlan"a basın. Hepsi bu.
  5. Asistanı kullandığınız sürece pencereyi açık tutun. Kapatınca (veya içinde ENTER'a basınca) model durur ve bellek boşalır.
     Başka bir pencereden:  Start-Local-AI.cmd -Stop
  Bir dahaki sefer yeniden çift tıklayın: hiçbir şey indirilmez; yardımcı sayfayı yeni bir eşleşme bağlantısıyla yeniden açar (anahtar her başlatmada yenilenir).

Gerekenler
  Windows 10 veya 11 (64 bit), yaklaşık 6 GB boş bellek, yaklaşık 4 GB boş disk alanı. Ekran kartı (Vulkan) yeterliyse o, değilse işlemci kullanılır.
  İlk başlatma bir dakika kadar sürer (model belleğe yüklenir).

Seçenekler (addan sonra yazın: Start-Local-AI.cmd -Port 9000)
  -Port <n>        denenecek ilk port (varsayılan 8473; doluysa sıradaki boş port alınır)
  -Backend cpu     yalnızca işlemci (varsayılan: auto; ayrıca: vulkan)
  -Stop            başka bir pencerede çalışan Yerel AI'yı durdurur
  -Remove          bu yardımcının indirdiği her şeyi siler (önce sorar)
  -NoBrowser       sayfayı açmaz
  -PrepareOnly     her şeyi indirir ve denetler, sonra durur

Dosyalar nerede?
  %LOCALAPPDATA%\VideoEditor-LocalAI\   motor, model, günlükler ve model çalışırken anahtarı (key.txt). Video Editor masaüstü uygulaması aynı modeli zaten indirdiyse
  (%APPDATA%\VideoEditor\models) aynı denetimden sonra yerinde kullanılır; hiçbir şey iki kez indirilmez.

Güvenlik ve gizlilik
  - Model sunucusu yalnızca 127.0.0.1'i dinler ve durum denetimi /health (yalnızca sunucunun ayakta olduğunu söyler) dışında her istek anahtar ister. Her başlatmada bilgisayarınızda yeni bir rastgele anahtar üretilir (sızan bir bağlantı
    veya günlük satırı pencere kapanınca değersiz olur) ve sayfaya adresin "#" sonrası bölümünde verilir; tarayıcılar bu bölümü hiçbir sunucuya göndermez.
  - Yardımcı yalnızca github.com ve huggingface.co'ya bağlanır (ilk çalıştırmadaki indirmeler; dosyalar onların indirme sunucularından gelebilir); başka hiçbir yere değil. Hesap yok, telemetri yok.
  - Yardımcı düz, okunabilir, imzasız bir PowerShell betiğidir (local-ai.ps1). GÜVENDİĞİNİZ: deponun sahibi
    (https://github.com/ahmetcanalaca/videoeditor) ve GitHub. Web sayfasındaki zip ve sabitlenmiş değerler aynı siteden gelir; ancak siteyi yayınlayan iş akışı
    zip'in tam kendisini de onaylar (imzalı yapı kanıtı, Sigstore, GitHub üzerinden). Böylece, sayfa ne derse desin, indirdiğiniz dosyanın bu depodan o iş akışıyla
    üretildiğini GitHub CLI ile denetleyebilirsiniz:
        gh attestation verify VideoEditor-LocalAI.zip --repo ahmetcanalaca/videoeditor --signer-workflow ahmetcanalaca/videoeditor/.github/workflows/pages.yml --source-ref refs/heads/main
    Çalıştırmadan önce betiği okuyabilirsiniz; BT biriminiz hash'ini izin listesine alabilir.
  - Pencere zorla kapatıldıysa bir sonraki başlatma önceki çalıştırmanın modelini durdurur (hâlâ çalışıyorsa yeniden kullanır).

Bir şey çalışmazsa
  - "huggingface.co'ya ulaşılamadı": şirket ağında BT biriminin huggingface.co ve github.com'a izin vermesi gerekebilir (proxy Windows oturumunuzu isterse
    yardımcı bunu otomatik kullanır). Dosyaları kendiniz de indirebilirsiniz - pencere adreslerini ve koyacağınız klasörü yazar - sonra yeniden başlatın;
    kullanılmadan önce denetlenirler.
  - Windows veya antivirüs betik hakkında soru sorarsa: betik imzasız ve internetten indirilmiş olduğu için Windows temkinlidir. BT biriminiz PowerShell
    betiklerini engelliyorsa masaüstü uygulamasını kullanın veya llama-server'ı kendiniz başlatın (aşağıda).
  - Sayfa Yerel AI'ya ulaşamadığını söylüyorsa: pencere hâlâ açık mı? Tarayıcı "yerel ağınızdaki cihazlara erişim" izni isterse İzin ver deyin (yardımcı bu
    bilgisayardadır). Sonra sayfadaki AI ayarlarında "Bağlantıyı dene"ye basın.
  - Port doluysa: yardımcı sıradaki boş portu alır ve eşleşme bağlantısına yazar.
  - Başka bir şey: motorun günlüğü %LOCALAPPDATA%\VideoEditor-LocalAI\llama-server.err.log dosyasındadır.

Bu yardımcı olmadan (başka sistemler veya betikler engelliyse)
  llama-server'ı (llama.cpp) kendiniz, yalnızca 127.0.0.1'de ve seçeceğiniz bir anahtarla başlatın; sayfada AI ayarları > Yerel AI > "Elle bağlan" deyin.
    set LLAMA_API_KEY=<uzun rastgele bir anahtar>
    set LLAMA_ARG_CHAT_TEMPLATE_KWARGS={"enable_thinking":false}
    llama-server -m Qwen3.5-4B-Q4_K_M.gguf --mmproj Qwen3.5-4B-mmproj-F16.gguf --host 127.0.0.1 --port 8473 -c 24576 --parallel 2 --jinja --no-webui --no-slots

Lisanslar
  Bu yardımcı: MIT. Qwen3.5-4B modeli: Apache-2.0. llama.cpp: MIT.

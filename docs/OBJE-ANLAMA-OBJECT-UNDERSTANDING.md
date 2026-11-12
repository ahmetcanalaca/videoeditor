<a id="tr"></a>

# Nesne / sahne anlama ve üretken düzenleme — fizibilite raporu · Object & scene understanding and generative editing — feasibility report

[Türkçe](#tr) · [English](#en) — Video Editör 2.0 için yazılmış fizibilite raporu; **3.0.0 durumu hemen aşağıdaki kutudadır** / feasibility report written for 2.0; **the 3.0.0 status is in the box right below**

> **Durum (3.0.0):** Bu raporun görsel anlama yolu **yerel olarak uygulandı.** Yerleşik **Qwen3.5-4B** (görüntü destekli, llama.cpp ile çalışır; kurulumla gelmez, tek tıkla indirilir) videodan örneklenen karelere bakar ("bu karede köpek var mı?"), bulunan aralıkların başını/sonunu ≈0,5 sn'ye inceltir, nesnenin karedeki yerini bulur; asistan komutu (zoom, kes, hızlandır …) yalnızca bu aralıklara uygular (`find_in_video` aracı). Ölçülen: köpek fotoğraflarından yapılmış 60 sn'lik deneme filminde 5/5 bölüm, uç hatası ≈0,3 sn, kutu örtüşmesi 0,89–0,98, olmayan nesnede yanlış alarm yok; sorgu başına ≈1,5–2,5 dk (ekran kartlı dizüstü), ≈1 sn/kare. **Uygulanmayanlar:** YOLOX/CLIP (yerel dedektör), Whisper (konuşma → metin), nesne takibi, bulut görsel modeller, videoya yeni nesne ekleme. Aşağıdaki bölümler 2.0 sırasında yazılan analizdir. Kullanım: kılavuz bölüm 5.3–5.4. **Ek (3.1.0):** Foundry sağlayıcısında isteğe bağlı bir **bulut yolu** eklendi: **Azure Content Understanding** ile videonun *içeriği* (sahne açıklamaları + zamanlı konuşma metni + kesme noktaları) okunur (`analyze_video` aracı; kılavuz 5.9). Yerleşik modelden farkı: **konuşmayı da yazıya döker** (böylece "'teşekkürler' dediği yeri kes" yapılabilir) ama **resimdeki konumu vermez** (zoom nesneye değil, ortaya/söylediğiniz yere gider) ve videonun *küçültülmüş bir kopyasını* kaynağınıza yükler (her seferinde sizin onayınızla; varsayılan kapalı). Ücret ≈ 3 $/saat video (Kasım 2026, yaklaşık). Gerçek bir Azure kaynağıyla denenmedi; belgelerdeki biçimleri taklit eden sahte sunucuyla sınandı. **Ek (konum — `locate_in_video`; masaüstü 3.2.0 ve web 4.1.0):** "resimdeki konumu vermez" eksiği sonradan giderildi: analizin bulduğu sahnelerin içinden birkaç kare, **her seferinde ayrı onayınızla**, sohbet modelinize gösterilir ve nesnenin kutusu istenir (önce "var mı? EVET/HAYIR", yalnızca EVET kareler için kutu); zoom her bölümde nesnenin kendi yerine kilitlenir. Ölçüm (yerleşik Qwen3.5-4B, bulut sohbet yolundan görüntü modeli olarak; COCO fotoğraflarından 60 sn'lik köpek ve 51 sn'lik araba filmi, aralıklar = gerçek bölümler ±1 sn): verilen aralıklarda 10/10 bölüm bulundu, olmayan nesnede (zürafa) yanlış bölüm yok; kutusu bilinen 4 bölümde zoom odağı hatası ortalama 0,076 (en fazla 0,21; resim boyutunun oranı; tüm filmi tarayan yerleşik yolda 0,037 / 0,13), istek başına ≈2 sn, toplam 36 sn'lik aralıklar için 40–47 istek (≈2 dk); sohbet modeli olarak da Qwen3.5-4B'yle "arabalara zoom yap" / "köpeğe yakınlaştır" komutları `analyze_video` → `locate_in_video` → nesneye odaklı zoom sırasıyla doğru işlendi. **Gerçek bir Foundry/GPT dağıtımıyla (kutu doğruluğu, istem uyumu) denenmedi.**
>
> **Status (3.0.0):** The visual-understanding route of this report is now **implemented locally.** The built-in **Qwen3.5-4B** (vision-capable, run by llama.cpp; not part of the setup, downloaded with one click) looks at pictures sampled from the video ("is there a dog in this picture?"), narrows the start/end of the parts it finds to ≈0.5 s, locates the object in the picture; the assistant then applies the command (zoom, cut, speed up …) only to those ranges (the `find_in_video` tool). Measured: on a 60-second test film made of dog photos 5/5 parts, edge error ≈0.3 s, box overlap 0.89–0.98, no false alarm for an absent object; ≈1.5–2.5 min per query (laptop with a graphics chip), ≈1 s per picture. **Not implemented:** YOLOX/CLIP (local detector), Whisper (speech to text), object tracking, cloud vision models, adding new objects to the picture. The sections below are the analysis written during 2.0. How to use it: guide sections 5.3–5.4. **Addendum (3.1.0):** an optional **cloud route** was added for the Foundry provider: **Azure Content Understanding** reads the *content* of the video (scene descriptions + time-stamped transcript + shot changes; the `analyze_video` tool; guide 5.9). Unlike the built-in model it **also transcribes speech** (so "cut the part where he says 'thank you'" works) but it **gives no position in the picture** (the zoom goes to the centre / where you say, not onto the object) and it uploads a *reduced copy* of the video to your resource (each time with your permission; off by default). Cost ≈ $3 per hour of video (November 2026, approximate). Not tried against a real Azure resource; tested with a mock server that imitates the documented formats. **Addendum (position — `locate_in_video`; desktop 3.2.0 and web 4.1.0):** the "gives no position in the picture" gap was closed later: a few frames inside the scenes the analysis found are shown to your chat model, **each time with your separate permission**, and the box of the object is asked for (first "is there one? YES/NO", the box only for the YES frames); the zoom of every part locks onto the object's own place. Measured (the built-in Qwen3.5-4B used as the vision model through the cloud chat route; a 60 s dog film and a 51 s car film made of COCO photographs; ranges = the true parts ±1 s): 10/10 parts found inside the given ranges, no false part for an absent object (giraffe); on the 4 parts with a known box the zoom focus was off by 0.076 on average (at most 0.21; as a fraction of the picture; the built-in route that scans the whole film: 0.037 / 0.13), ≈2 s per request, 40–47 requests (≈2 min) for ranges of 36 s in total; as the CHAT model, too, Qwen3.5-4B handled "arabalara zoom yap" / "köpeğe yakınlaştır" in the right order: `analyze_video` → `locate_in_video` → zoom aimed at the object. **Not tried with a real Foundry / GPT deployment (box accuracy, how well it follows the prompt).**

---

## 🇹🇷 Türkçe

### 1. Kısa cevap

**Evet, mümkün — ama bugünkü AI asistanı bunu yapamaz ve bilerek yapmaz.** Asistan videoyu *görmez ve duymaz*; yalnızca zaman çizelgesinin **metin özetini** (klip adları, süreler, hız/zoom değerleri) ve sizin komutunuzu görür. Bu bir eksiklik değil, bir tasarım kararıdır: görüntü göndermek gizliliği, maliyeti ve gecikmeyi değiştirir (bkz. bölüm 5). Bu yüzden “arabayı yakınlaştır” dendiğinde asistan dürüstçe “videoyu göremiyorum, zaman aralığı verin” der.

Nesne/sahne anlama için beş yol var; hepsi “önce videodan **metin gerçekler** (zaman damgalı) çıkar, sonra mevcut asistan bu gerçeklerle çalışsın” mantığına oturur:

| # | Yol | Ne sağlar | Nerede çalışır | Veri dışarı çıkar mı? | Tahmini efor* | Durum |
|---|-----|-----------|----------------|-----------------------|---------------|-------|
| A | **FFmpeg çözümleyicileri** (YZ yok) | sessizlik, sahne değişimi, siyah/donuk kare, ses yüksekliği | yerel, ffmpeg içinde | hayır | 1–2 gün | ✅ bu makinede çalıştırıp doğruladım |
| B | **Konuşma → metin** (Whisper) | “şu cümleden sonrasını kes”, “susulan yerleri at” | yerel (whisper.cpp / ONNX) | hayır | 3–5 gün | mümkün (ölçüm: bölüm 7) |
| C | **Bulut görsel model + kare örnekleme** | “araba ne zaman görünüyor?”, “gülümsediği yerler” | Azure OpenAI / Foundry / OpenAI / Claude / Gemini | **evet (kareler)** | 3–5 gün | mümkün, onay gerektirir |
| D | **Yerel nesne algılama / CLIP** | “köpek”, “araba”, “yüz” aralıkları | yerel (ONNX Runtime) | hayır | 1–2 hafta | mümkün, model dosyası gerekir (ölçüm: bölüm 7) |
| E | **Nesne takibi ile otomatik zoom** | hareketli nesneyi izleyen zoom | yerel | hayır | 2+ hafta | modelde anahtar kare gerekir |

\* Eforlar benim tahminimdir (ölçülmüş değil); 1 geliştirici, mevcut kod tabanı için.

### 2. Bugün neden yok?

* Asistanın araçları (`remove_range`, `set_speed`, `set_zoom` …) yalnızca **zaman aralığı** alır. Aralığı bulmak kullanıcıya bırakılmıştır.
* Asistana giden her şey metindir; **kare, ses ya da video gönderilmez**. Ayarlar penceresindeki gizlilik notu ve “Hakkında” bunu vaat eder. Görüntü göndermeye başlamak bu vaadi değiştirir; bu yüzden ancak **açık onayla, isteğe bağlı** bir özellik olabilir.
* Küçük yerel modeller (1–4 B parametre) çoğunlukla görüntü girdisini desteklemez ya da görüntüyle yavaştır.

### 3. Yollar ayrıntılı

**A — FFmpeg ile “YZ’siz” analiz (en ucuz ilk adım).** Paketlenen ffmpeg 9.0.2 (2.0.1'den itibaren) şu filtreleri içerir: `silencedetect`, `scdet` / `select='gt(scene,x)'`, `blackdetect`, `freezedetect`, `ebur128`, `astats`, `volumedetect`, `cropdetect`, `mestimate`, `signalstats` (listeyi bu makinede `ffmpeg -filters` ile doğruladım). Çıktıları zaman damgalı metindir; asistana araç olarak verilir (`find_silences`, `find_scene_changes`, `find_loud_parts`) ve şu komutları mümkün kılar: “sessiz yerleri at”, “sahne değişimlerinden böl”, “en gürültülü 10 saniyeyi yavaşlat”.
*Kanıt (bu makinede çalıştırıldı):* 8 sn’lik bir sinyalde 3–5 sn arası susturulunca `silencedetect` `silence_start: 3.01859` / `silence_end: 5.01551` verdi. Sahne değişimi testinde kırmızı→yeşil→mavi üç parçada eşik 0.3 ile yalnızca yeşil→mavi kesimi (4 sn) bulundu; kırmızı→yeşil kesimi (≈0.29) eşiğin altında kaldı. **Ders:** ölçüt parlaklığa dayanır, eşik ayarı gerekir.

**B — Konuşma metni.** Whisper (MIT) / whisper.cpp (MIT) ile yerel çözümleme; çıktı “saniye–metin” listesidir. Asistan bunu doğrudan okuyabilir: “‘teşekkürler’ dediğim yerde bitir”, “her ‘şey’ kelimesini at”. Gerekenler: model dosyası (tiny ≈ 75 MB … medium ≈ 1,5 GB; büyüdükçe doğruluk artar, hız CPU’da gerçek zamanın altında olabilir).

**C — Bulut görsel model.** ffmpeg ile her 2–3 saniyede bir kare çıkarılır (örn. 512 px JPEG), zaman damgasıyla bir görsel modele gönderilir (GPT-4o sınıfı, Claude, Gemini; kurumsal kullanımda **Azure OpenAI / Microsoft Foundry** veri sınırı açısından uygundur). Model “şu aralıklarda araba var” gibi JSON döndürür; asistan bunu `remove_range` / `set_zoom` çağrılarına çevirir.
* **Doğruluk:** zaman çözünürlüğü örnekleme aralığı kadardır (±1–3 sn). İkinci “ince tarama” turu (hedef aralığın çevresinde 0,25 sn aralıkla) bunu düzeltir.
* **Maliyet:** Gemini belgelerine göre doğrudan video girişinde saniyede 1 kare örneklenir; kare başına 258 token, varsayılan (düşük) çözünürlükte toplam ≈100 token/sn, yüksek çözünürlükte ≈300 token/sn (10 dakikalık video ≈ 60–180 bin token). Kare tabanlı yöntemde de sıra büyüklüğü benzerdir; yüzlerce kare = on binlerce token.
* **Gizlilik:** kareler sağlayıcıya gider. Kurumsal politikanıza uygun hesap/bölge seçin; özellik **varsayılan kapalı** ve her kullanımda açık onaylı olmalıdır.

**D — Yerel nesne algılama.** ONNX Runtime (MIT) üzerinde YOLOX (Apache-2.0) veya RT-DETR (Apache-2.0) gibi bir algılayıcı, belirli sınıfları (kişi, araç, köpek …) bulur; “serbest metin” için CLIP (MIT, kare↔metin benzerliği) veya GroundingDINO (Apache-2.0 kod; ağırlık lisansını ayrıca kontrol edin) kullanılır. MediaPipe (Apache-2.0) yüz/nesne için küçük çözümler sunar.
⚠️ **Lisans uyarısı:** Ultralytics YOLO (v5/v8/11) **AGPL-3.0**’dır; kapalı kaynaklı iş uygulamasında ticari lisans gerekir. Apache-2.0/MIT seçenekleri tercih edilmelidir.
Model dosyaları onlarca MB ile birkaç yüz MB arasındadır; uygulamayla birlikte paketlenirse internetsiz çalışır.

**E — Takipli (otomatik) zoom.** Mevcut modelde **her segmentin tek bir odak noktası** vardır (`fx`, `fy`) ve zoom `zoomFrom→zoomTo` ile animasyonludur. Bu yüzden iki seviye vardır:
1. *Statik otomatik odak* (✅ mevcut modelle yapılabilir): algılanan nesnenin merkezi, aralığın tek odağı olur.
2. *Hareketli nesneyi izleme* (modele **odak anahtar kareleri** gerekir): kare başına (örn. 5 Hz) kutu → yumuşatma → anahtar kareler. Önizleme (CSS dönüşümü) ve dışa aktarma (`perspective` filtresi, `eval=frame`) zaman bağımlı odağı desteklemelidir; ikisinin aynı sonucu vermesi test edilmelidir. Yaklaşık çözüm olarak aralığı çok kısa segmentlere bölmek mümkündür ama sıçrama riski vardır.

### 4. Önerilen yol haritası

1. **Faz 1 (1–2 gün):** A’yı ajan araçları olarak ekle (`find_silences`, `find_scene_changes`, `find_loud_parts`) — yerel, bedava, gizlilik değişmez.
2. **Faz 2 (3–5 gün):** B (Whisper) — metin tabanlı komutlar; model dosyası isteğe bağlı indirilir/paketlenir.
3. **Faz 3 (3–5 gün):** C’yi **isteğe bağlı ve onaylı** ekle: kare örnekleme + görsel model + “neden bu aralıklar?” açıklaması; maliyet ve kare sayısı sınırı (ör. en çok 120 kare) ve iptal düğmesi.
4. **Faz 4 (1–2+ hafta):** D ve E — yerel algılama, ardından odak anahtar kareleri (model + önizleme + dışa aktarma + testler).

### 5. Riskler ve sınırlar

* **Gizlilik/politika:** C’de kareler dışarı çıkar. İş yerinde Azure OpenAI/Foundry (kiracınızın veri sınırı) veya yerel model tercih edin.
* **Doğruluk:** Görsel modeller halüsinasyon yapabilir; zaman damgaları yaklaşıktır. Her sonuç *önizlenebilir* ve tek adımda geri alınabilir olmalıdır (şu anki asistanda olduğu gibi).
* **Maliyet/gecikme:** Uzun videolarda önce ucuz yöntemleri (A, B) çalıştırıp yalnızca aday bölgelerde görsel modeli kullanmak en verimlisidir.
* **Lisanslar:** yukarıdaki lisanslar GitHub deposu bilgisine göre doğrulandı (Ultralytics AGPL-3.0; YOLOX, RT-DETR, MediaPipe, GroundingDINO kodu Apache-2.0; Whisper, whisper.cpp, CLIP, ONNX Runtime MIT). Model *ağırlıklarının* lisansı ayrıca kontrol edilmelidir.

### 6. Bugün uygulamada olan

* AI asistanı (Ctrl+K): zaman aralığıyla kes, böl, hızlandır/yavaşlat, zoom, ses/solma, sırala, dışa aktarma ayarı — tek adımda geri alınır.
* Sağlayıcılar: OpenAI/uyumlu, Azure OpenAI, **Microsoft Foundry**, Anthropic, Gemini ve **yerel model** (Foundry Local, Ollama, LM Studio, llama.cpp). Anahtar girilmezse (veya yerel model seçilmezse) bölüm devre dışıdır.
* Asistan videoyu göremediğini açıkça söyler; nesne istenirse zaman aralığı ister.

### 7. Ölçümler ve maliyet (9 Kasım 2026)

“Mümkün” ifadelerini sayıya döktüm. D (YOLOX, CLIP) ve B (Whisper) yolları **bu makinede denendi**: AMD Ryzen AI 9 HX PRO 375 (12 çekirdek / 24 iş parçacığı), 31 GB RAM, yalnızca CPU; tipik bir iş dizüstüsü 2–4 kat yavaş olabilir. Veriler herkese açık veri kümeleridir, **sizin videolarınız değil**; gerçek videoda (hareket bulanıklığı, düşük ışık, müzik/gürültü) sonuçlar farklı çıkabilir. Denemeler uygulamaya kod olarak eklenmedi.

**Doğruluk (ölçüldü)**

| Ne | Model / veri | Sonuç |
|----|--------------|-------|
| Nesne var mı? (80 sık sınıf) | YOLOX-s · COCO val’den 400 fotoğraf (1197 fotoğraf-sınıf çifti) | Karede olan sınıfı bulma (güven eşiği 0,25 / 0,40): **büyük** nesneler (kareyi ≥%10 kaplayan) %92 / %88 · orta (%2–10) %83 / %74 · küçük (<%2) %66 / %54 · **insan** %98 / %97. Bulunan sınıfların yanlış olanı: %19 / %11 (COCO etiketleri eksik olduğundan gerçek oran biraz daha düşüktür). |
| Serbest kelimeyle kare arama | CLIP ViT-B/32 (int8) · aynı 400 fotoğraf, 80 nesne adı | İngilizce sorguda ilk 5 sonucun **%61’i** (kareyi ≥%2 kaplayan nesnelerde %73’ü), ilk 10’un %50’si (%62’si) doğru. **Türkçe sorguda şansa yakın (%6–15):** OpenAI CLIP İngilizce eğitildi; sorgu İngilizceye çevrilmeli (asistan bunu yapabilir). |
| Türkçe konuşma → metin | whisper.cpp · MediaSpeech Türkçe: 30 gerçek TV/radyo klibi (7,3 dk, 920 kelime), varsayılan ayarlar | Kelime hata oranı: base **%28,7** · small **%22,4** · large-v3-turbo (q5) **%18,0**. Klip medyanı %9; 30 klibin 5’inde hata ≥%25 (konuşmanın büyük kısmı hiç yazılmıyor). |

**Hız (bu makinede)**

| İş | Ölçüm |
|----|-------|
| Kare çıkarma (ffmpeg, saniyede 1 kare) | 1080p ≈ 13×, 4K60 ≈ 4–8× gerçek zaman (kısa deneme) |
| YOLOX | s: 73 ms/kare (24 iş parçacığı), 166 ms (4 iş parçacığı) · tiny: 24 / 45 ms (küçük nesnede %48) · m: 178 ms (küçük nesnede %70) |
| CLIP ViT-B/32 int8 | ≈ 23 ms/kare |
| Whisper (4 iş parçacığı) | base 7,5× · small 1,3× · turbo 0,78× gerçek zaman (14,6 sn’lik klipler; kesintisiz seste ≈ 2× daha hızlı olabilir) |

Sonuç: 10 dakikalık bir 1080p video için nesne taraması (1 kare/sn, YOLOX-s) ≈ **1,5–2,5 dk**; konuşma metni (small) ek olarak ≈ **4–8 dk**. Arka planda, ilerleme çubuğuyla çalışır ve sonuç dosyada saklanırsa bekleme sorun olmaz.

**Maliyet**

| Senaryo | Ücret |
|---------|-------|
| Yerel (YOLOX + CLIP + Whisper) | **Kullanım başına ücret yok** (yazılım lisansları Apache-2.0 / MIT; ağırlık lisansları ayrıca kontrol edilmeli). Maliyet: disk ≈ **0,7 GB** (YOLOX-s 34 MB, CLIP int8 146 MB, Whisper-small 465 MB, motorlar ≈ 30 MB; Whisper-turbo-q5 547 MB) ve işlem süresi. Mevcut zip 190 MB. |
| Bulut video modeli, 10 dk video | Gemini belgelerine göre ≈ 100 token/sn (düşük çözünürlük) – 300 token/sn (yüksek) = **60–180 bin token**. Google’ın 9 Kasım 2026 fiyatlarıyla: Gemini 3.8 Flash ($0,75 / 1M giriş) **$0,045–0,135**; Gemini 4 Argon ($2 / 1M) **$0,12–0,36**. Google bu fiyatların Aralık 2026 / Ocak 2027’de iki katına çıkacağını duyurmuş. 1 saatlik video ≈ 6 kat. |
| Bulut konuşma → metin | OpenAI’nin listelediği ≈ **$0,003–0,006 / dk** → 10 dk ≈ $0,03–0,06 (fiyat sayfası doğrudan okunamadı; üçüncü taraf alıntısı). |
| Asistan komutu (bugünkü, yalnızca metin) | ≈ 8–10 bin token / komut (gerçek denemede 8 048) → Flash ≈ 0,6–0,8 sent, Argon ≈ 1,6–2 sent (giriş tokenleri). |

**Yorum:** Yerel yolda para harcanmaz; bulutta bile video başına kuruşlar–onlarca sent düzeyindedir. Pahalıya patlayan tek senaryo, her komutta **tüm videoyu yeniden** buluta göndermektir. Çözüm: analizi bir kez yerelde yapıp zaman damgalı **metin dizini** olarak saklamak ve asistana yalnızca bu metni vermek (kareler dışarı çıkmaz, komut başına maliyet değişmez).

**Sınırlar:** (1) COCO fotoğrafları ve yayın sesi sizin videonuzdan farklıdır; ciddi karardan önce kendi ≈20 videonuzda 1–2 günlük pilot önerilir. (2) YOLOX yalnızca 80 COCO sınıfını bilir; “forklift”, “logo” gibi şeyler için CLIP veya özel eğitim gerekir. (3) “Gol oldu”, “kapıdan girdi” gibi olay/eylem istekleri bu üçlüyle çözülmez (ölçülmedi; bulut video modeli gerekir). (4) Birkaç ardışık karede teyit aranırsa video düzeyinde sonuçların kare düzeyinden iyi olması beklenir — **ölçülmedi**. (5) Whisper ayarları (VAD, sıcaklık, beam) ve GPU hızlandırma denenmedi.

### 8. Ekleme ve genişletme istekleri: ne mümkün, ne kadar tutar (9 Kasım 2026)

“Videoya köpek ekle”, “sahneyi uzat / kısalt” gibi istekler dört ayrı işe ayrılır. Bugünkü asistan hiçbirini yapmaz ve bunu açıkça söyler (sistem istemi: metin, müzik, katman ekleyemez); aşağıda her biri için yol ve ücret var.

| İstek | Yol | Durum ve ücret |
|-------|-----|----------------|
| Elinizdeki bir şeyi eklemek: yazı, logo/resim, çıkartma, başka klip, müzik | Klasik düzenleme (ffmpeg `drawtext` / `overlay` / `amix`); asistan araç olarak çağırır | **Ücretsiz, yerel.** Bugün yok: modelde katman yok; katman + önizleme + dışa aktarma gerekir (≈1–2 hafta, tahminim) |
| Sahneyi **kısaltmak** | kes / kırp / hızlandır | ✅ bugün var, ücretsiz |
| Sahneyi **uzatmak**, kaynakta fazladan görüntü varsa | Kırpılan kısmı geri açmak: editörde kenar tutamacıyla bugün mümkün; asistana araç eklemek ≈1 gün | ücretsiz |
| Sahneyi uzatmak, kaynak bittiyse | Yavaşlatma (0,25×’e kadar var), son karede dondurma, döngü / ileri-geri (eklenebilir, ücretsiz); **yeni içerik uydurmak** = üretken YZ | üretken kısım aşağıda |
| Videoda **olmayan** bir şeyi eklemek (sokağa köpek), nesne silmek / değiştirmek | Üretken video düzenleme modeli (bulut) | mümkün, kısıtlı, ücretli — aşağıda |

**Üretken video düzenleme servisleri** (resmî belge / fiyat sayfaları, 9 Kasım 2026; ben denemedim, anahtarım yok):

| Servis | Gerçek videoyu düzenler mi? | Sınırlar | Ücret |
|--------|-----------------------------|----------|-------|
| **Google Gemini Omni 1.2 Flash** (Gemini API, ücretli katman) | Evet: videoyu yükleyip metinle düzenler (belgedeki örnek: “Kedi ekle… geri kalan aynı kalsın”) ve sonuna 3–10 sn ekler; 6’ya kadar referans görsel (örn. belirli bir köpek) | Girdi **≤15 sn**, çıktı ≤15 sn (uzatmayla toplam ≤30 sn); uzatma yalnızca **sona**; 720p (1080p/4K yukarı ölçekli); AEA / İsviçre / Birleşik Krallık’ta yüklenen videoyu düzenleme **kapalı** (Türkiye bu listede yok); tanınabilir kişilerde kısıt; ses girdisi / ses düzenleme yok; tüm çıktıda görünmez SynthID filigranı; İngilizce tam desteklenir, diğer diller “değerlendirilmedi” | **720p ≈ $0,07/sn** (10 sn ≈ $0,70, 15 sn ≈ $1,04) · 1080p ≈ $0,104/sn · 4K ≈ $0,209/sn · girdi $1,50 / 1M token (10 sn’lik video ≈ $0,002–0,005) |
| **Runway Aleph 2.0** | Evet: mevcut videoda nesne/kişi ekler–siler, perspektif ve örtüşmeyi korur (üreticinin tanımı) | Girdi ≤30 sn; üçüncü taraf SaaS | **28 kredi/sn** (1 kredi = $0,01) ≈ **$0,28/sn**, en az $0,56 → 10 sn ≈ $2,80 |
| **Microsoft Foundry · Sora 2 (önizleme)** | **Hayır (gerçek çekim için):** belge “video (üretilmiş) → video” der; “IP ve fotogerçekçi içeriği engeller” | Yalnızca kendi ürettiği videoyu “remix” eder | ≈ $0,10/sn (Azure fiyat sayfası, bölgeye göre) |

**Örnek maliyetler** (liste fiyatı, vergi hariç, tek deneme): 10 sn’lik sokak planına köpek eklemek: Omni 720p ≈ **$0,70**, Aleph 2.0 ≈ **$2,80**. Sonuç her seferinde farklı çıkar; beğenene kadar 2–5 deneme gerekebilir (tahminim) → Omni ≈ $1,4–3,5, Aleph ≈ $5,6–14. 60 sn’lik videonun tamamı: Omni’de 4 parça ≈ $4,2 / geçiş ve parça birleşimleri tutarsız görünebilir; pratik değil, üretken adımı yalnızca gereken plana uygulayın. Sahne uzatma: +5 sn ≈ $0,35 (belge, uzatmada tüm çıktının mı yalnızca yeni kısmın mı faturalandığını yazmıyor; tümü faturalanırsa 15+5 sn ≈ $1,40). Asistanın kendi komut maliyeti (metin) ≈ 1–2 sent, değişmez.

**Kalite ve gizlilik uyarıları:** (1) Klip **yeniden üretilir**, özgün pikseller korunmaz: çözünürlük ve ince doku özgün kaydınızdan düşük olabilir (4K kayıtta eklenen plan belirgin yumuşak kalır). (2) Servis sesi de üretir; ses girdisi ve ses düzenleme desteklenmez → özgün sesi korumak için yalnızca görüntü değiştirilip ses eski kayıttan alınmalı (süreler tutmalı). (3) Kareler/videolar üçüncü taraf buluta gider; iş yerinde politika ve gizlilik onayı gerekir. (4) Çıktı filigranlıdır (SynthID, görünmez) ve içerik güvenlik filtrelerine tabidir. (5) İngilizce komut en güvenilir seçenektir (asistan çevirebilir).

**Öneri (isteğe bağlı yol haritası):** Faz 1 (ücretsiz, ≈2–4 gün): asistana `extend_clip` (kırpılanı geri aç), son karede dondurma, döngü. Faz 2 (ücretsiz, ≈1–2 hafta): yazı / resim / müzik katmanları. Faz 3 (ücretli, isteğe bağlı, ≈1–2 hafta): Omni ile “üretken düzenle / uzat”: çalıştırmadan önce tahmini ücret ve üst sınır, her seferinde onay, ≤15 sn’lik plan, sonucu önizleme ve tek adımda geri alma. Eforlar tahminimdir.

---

<a id="en"></a>

## 🇬🇧 English

### 1. Short answer

**Yes, it is possible — but today's AI assistant cannot do it, and by design.** The assistant neither *sees* nor *hears* the video; it only receives the **text summary** of the timeline (clip names, lengths, speed/zoom values) and your command. That is a design decision, not an oversight: sending pictures changes privacy, cost and latency (see section 5). So for "zoom in on the car" the assistant honestly answers "I cannot see the video, please give a time range".

There are five routes to object/scene understanding; all of them follow one idea: **first extract timestamped *text facts* from the video, then let the existing assistant work with those facts.**

| # | Route | What it gives | Where it runs | Does data leave the PC? | Estimated effort* | Status |
|---|-------|---------------|---------------|-------------------------|-------------------|--------|
| A | **FFmpeg analyzers** (no AI) | silence, scene changes, black/frozen frames, loudness | local, inside ffmpeg | no | 1–2 days | ✅ verified on this machine |
| B | **Speech → text** (Whisper) | "cut after that sentence", "remove the pauses" | local (whisper.cpp / ONNX) | no | 3–5 days | feasible (measured: section 7) |
| C | **Cloud vision model + frame sampling** | "when does the car appear?", "the smiling parts" | Azure OpenAI / Foundry / OpenAI / Claude / Gemini | **yes (frames)** | 3–5 days | feasible, needs consent |
| D | **Local object detection / CLIP** | "dog", "car", "face" ranges | local (ONNX Runtime) | no | 1–2 weeks | feasible, needs model files (measured: section 7) |
| E | **Object tracking for auto-zoom** | a zoom that follows a moving object | local | no | 2+ weeks | needs keyframes in the model |

\* Efforts are my estimates (not measured): one developer, existing code base.

### 2. Why it is not there today

* The assistant's tools (`remove_range`, `set_speed`, `set_zoom` …) only take **time ranges**. Finding the range is left to the user.
* Everything sent to the assistant is text; **no frames, audio or video are sent.** The privacy note in the settings dialog and "About" promise exactly that. Sending images would change this promise, so it can only be an **opt-in feature with explicit consent**.
* Small local models (1–4 B parameters) mostly either do not accept images or are slow with them.

### 3. The routes in detail

**A — "AI-free" analysis with FFmpeg (cheapest first step).** The bundled ffmpeg 9.0.2 (since 2.0.1) contains `silencedetect`, `scdet` / `select='gt(scene,x)'`, `blackdetect`, `freezedetect`, `ebur128`, `astats`, `volumedetect`, `cropdetect`, `mestimate`, `signalstats` (checked with `ffmpeg -filters` on this machine). Their output is timestamped text; it can be handed to the assistant as tools (`find_silences`, `find_scene_changes`, `find_loud_parts`) and enables "remove the silent parts", "split at scene changes", "slow down the loudest 10 seconds".
*Proof (run on this machine):* with seconds 3–5 muted in an 8 s signal, `silencedetect` reported `silence_start: 3.01859` / `silence_end: 5.01551`. In a scene-change test with red→green→blue parts and threshold 0.3 only the green→blue cut (4 s) was found; the red→green cut (≈0.29) stayed below the threshold. **Lesson:** the metric is luma-based, so thresholds need tuning.

**B — Speech transcript.** Local transcription with Whisper (MIT) / whisper.cpp (MIT); the output is a list of "second – text". The assistant can read it directly: "end where I say 'thank you'", "remove every 'um'". Needs a model file (tiny ≈ 75 MB … medium ≈ 1.5 GB; larger = more accurate, CPU speed may be below real time).

**C — Cloud vision model.** ffmpeg extracts a frame every 2–3 seconds (e.g. 512 px JPEG); the frames with their timestamps go to a vision model (GPT-4o class, Claude, Gemini; for business use **Azure OpenAI / Microsoft Foundry** is the better fit for data boundaries). The model returns JSON like "the car is visible in these ranges"; the assistant turns it into `remove_range` / `set_zoom` calls.
* **Accuracy:** time resolution equals the sampling interval (±1–3 s). A second "fine scan" pass (every 0.25 s around the target range) fixes that.
* **Cost:** per the Gemini docs, direct video input is sampled at 1 frame per second; 258 tokens per frame, ≈100 tokens/s of video at the default (low) resolution and ≈300 tokens/s at high resolution (a 10-minute video ≈ 60–180 k tokens). A frame-based approach is in the same order of magnitude: hundreds of frames = tens of thousands of tokens.
* **Privacy:** the frames go to the provider. Choose an account/region that fits your company policy; the feature must be **off by default** and confirmed on every use.

**D — Local object detection.** A detector such as YOLOX (Apache-2.0) or RT-DETR (Apache-2.0) on ONNX Runtime (MIT) finds fixed classes (person, car, dog …); for free text use CLIP (MIT, frame↔text similarity) or GroundingDINO (Apache-2.0 code; check the weights' license separately). MediaPipe (Apache-2.0) offers small ready-made solutions for faces/objects.
⚠️ **License warning:** Ultralytics YOLO (v5/v8/11) is **AGPL-3.0**; a closed-source business app needs a commercial license. Prefer the Apache-2.0/MIT options.
Model files are tens of MB up to a few hundred MB; bundled with the app they work offline.

**E — Tracked (automatic) zoom.** In the current model **each segment has a single focus point** (`fx`, `fy`) and the zoom is animated by `zoomFrom→zoomTo`. So there are two levels:
1. *Static automatic focus* (✅ possible with the current model): the centre of the detected object becomes the range's single focus.
2. *Following a moving object* (the model needs **focus keyframes**): boxes per frame (e.g. 5 Hz) → smoothing → keyframes. Preview (CSS transform) and export (`perspective` filter, `eval=frame`) must both support a time-dependent focus, and the two must be tested to give the same result. Splitting the range into very short segments is an approximation but risks visible jumps.

### 4. Suggested roadmap

1. **Phase 1 (1–2 days):** add A as assistant tools (`find_silences`, `find_scene_changes`, `find_loud_parts`) — local, free, privacy unchanged.
2. **Phase 2 (3–5 days):** B (Whisper) — text-based commands; the model file is downloaded/bundled on request.
3. **Phase 3 (3–5 days):** add C **as opt-in with consent**: frame sampling + vision model + an explanation of why those ranges; cost and frame cap (e.g. at most 120 frames) and a cancel button.
4. **Phase 4 (1–2+ weeks):** D and E — local detection, then focus keyframes (model + preview + export + tests).

### 5. Risks and limits

* **Privacy/policy:** with C the frames leave the PC. At work prefer Azure OpenAI/Foundry (your tenant's data boundary) or a local model.
* **Accuracy:** vision models can hallucinate; timestamps are approximate. Every result must be *previewable* and undoable in one step (as the current assistant already is).
* **Cost/latency:** for long videos run the cheap methods (A, B) first and use the vision model only on candidate regions.
* **Licenses:** verified from the GitHub repository metadata (Ultralytics AGPL-3.0; YOLOX, RT-DETR, MediaPipe, GroundingDINO code Apache-2.0; Whisper, whisper.cpp, CLIP, ONNX Runtime MIT). The license of the model *weights* must be checked separately.

### 6. What the app has today

* AI assistant (Ctrl+K): cut, split, speed up/slow down, zoom, volume/fade, reorder, export settings by time range — undone in one step.
* Providers: OpenAI/compatible, Azure OpenAI, **Microsoft Foundry**, Anthropic, Gemini and **local models** (Foundry Local, Ollama, LM Studio, llama.cpp). Without a key (or a chosen local model) the pane stays disabled.
* The assistant says openly that it cannot see the video and asks for a time range when an object is requested.

### 7. Measurements and cost (9 November 2026)

I turned "feasible" into numbers. Routes D (YOLOX, CLIP) and B (Whisper) were **tried on this machine**: AMD Ryzen AI 9 HX PRO 375 (12 cores / 24 threads), 31 GB RAM, CPU only; a typical business laptop may be 2–4× slower. The data are public datasets, **not your videos**; on real footage (motion blur, low light, music/noise) results can differ. The experiments were not added to the app as code.

**Accuracy (measured)**

| What | Model / data | Result |
|------|--------------|--------|
| Is the object there? (80 common classes) | YOLOX-s · 400 COCO val photos (1,197 photo-class pairs) | Finding a class that is in the picture (confidence threshold 0.25 / 0.40): **large** objects (covering ≥10% of the frame) 92% / 88% · medium (2–10%) 83% / 74% · small (<2%) 66% / 54% · **person** 98% / 97%. Share of reported classes that were wrong: 19% / 11% (COCO labels are incomplete, so the true rate is somewhat lower). |
| Free-word frame search | CLIP ViT-B/32 (int8) · the same 400 photos, 80 object names | With English queries **61%** of the top 5 results (73% for objects covering ≥2% of the frame) and 50% of the top 10 (62%) are correct. **With Turkish queries it is close to chance (6–15%):** OpenAI CLIP was trained on English; the query has to be translated to English (the assistant can do that). |
| Turkish speech → text | whisper.cpp · MediaSpeech Turkish: 30 real TV/radio clips (7.3 min, 920 words), default settings | Word error rate: base **28.7%** · small **22.4%** · large-v3-turbo (q5) **18.0%**. Median clip 9%; 5 of 30 clips have ≥25% errors (most of the speech is not written at all). |

**Speed (on this machine)**

| Job | Measured |
|-----|----------|
| Frame extraction (ffmpeg, 1 frame/s) | 1080p ≈ 13×, 4K60 ≈ 4–8× real time (short test) |
| YOLOX | s: 73 ms/frame (24 threads), 166 ms (4 threads) · tiny: 24 / 45 ms (48% on small objects) · m: 178 ms (70% on small objects) |
| CLIP ViT-B/32 int8 | ≈ 23 ms/frame |
| Whisper (4 threads) | base 7.5× · small 1.3× · turbo 0.78× real time (14.6 s clips; with continuous audio up to ≈ 2× faster) |

Result: for a 10-minute 1080p video an object scan (1 frame/s, YOLOX-s) takes ≈ **1.5–2.5 min**; the speech transcript (small) adds ≈ **4–8 min**. Run in the background with a progress bar and the result stored in a file, the wait is acceptable.

**Cost**

| Scenario | Price |
|----------|-------|
| Local (YOLOX + CLIP + Whisper) | **No per-use fee** (software licenses Apache-2.0 / MIT; check the weights' licenses separately). Costs: disk ≈ **0.7 GB** (YOLOX-s 34 MB, CLIP int8 146 MB, Whisper-small 465 MB, engines ≈ 30 MB; Whisper-turbo-q5 547 MB) and processing time. The current zip is 190 MB. |
| Cloud video model, 10-min video | Per the Gemini docs ≈ 100 tokens/s (low resolution) – 300 tokens/s (high) = **60–180 k tokens**. At Google's 9 Nov 2026 prices: Gemini 3.8 Flash ($0.75 / 1M input) **$0.045–0.135**; Gemini 4 Argon ($2 / 1M) **$0.12–0.36**. Google has announced that these prices double in December 2026 / January 2027. A 1-hour video ≈ 6×. |
| Cloud speech → text | OpenAI lists ≈ **$0.003–0.006 / min** → 10 min ≈ $0.03–0.06 (the price page could not be read directly; third-party quote). |
| Assistant command (today, text only) | ≈ 8–10 k tokens / command (8,048 in the real test) → Flash ≈ 0.6–0.8 cents, Argon ≈ 1.6–2 cents (input tokens). |

**Reading:** the local route costs no money; even in the cloud it is cents to tens of cents per video. The only scenario that gets expensive is re-sending **the whole video with every command**. The fix: analyse once locally, store a timestamped **text index** and give the assistant only that text (frames never leave the PC and the per-command cost stays the same).

**Limits:** (1) COCO photos and broadcast audio differ from your videos; before a serious decision run a 1–2 day pilot on your own ≈20 videos. (2) YOLOX only knows the 80 COCO classes; for things like "forklift" or "logo" you need CLIP or custom training. (3) Event/action requests such as "a goal is scored" or "someone enters the door" are not solved by this trio (not measured; a cloud video model is needed). (4) If a detection must be confirmed in a few consecutive frames, video-level results should beat frame-level ones — **not measured**. (5) Whisper settings (VAD, temperature, beam) and GPU acceleration were not tried.

### 8. Adding and extending: what is possible and what it costs (9 November 2026)

Requests such as "add a dog to the video" or "extend / shorten this scene" fall into four different jobs. Today's assistant does none of the adding and says so openly (system prompt: it cannot add text, music or overlays); below is the route and the price for each.

| Request | Route | Status and price |
|---------|-------|------------------|
| Adding something you already have: text, logo/picture, sticker, another clip, music | Classic editing (ffmpeg `drawtext` / `overlay` / `amix`); the assistant calls it as a tool | **Free, local.** Not there today: the model has no layers; layers + preview + export are needed (≈1–2 weeks, my estimate) |
| **Shortening** a scene | cut / trim / speed up | ✅ available today, free |
| **Extending** a scene when the source has extra footage | Re-open the trimmed part: possible today in the editor with the edge grip; giving the assistant a tool ≈1 day | free |
| Extending a scene when the source has ended | Slow down (down to 0.25× exists), freeze the last frame, loop / ping-pong (can be added, free); **inventing new content** = generative AI | generative part below |
| Adding something that is **not in the footage** (a dog on the street), removing / replacing objects | A generative video-editing model (cloud) | possible, limited, paid — below |

**Generative video-editing services** (official docs / price pages, 9 Nov 2026; I did not try them, I have no key):

| Service | Edits real footage? | Limits | Price |
|---------|---------------------|--------|-------|
| **Google Gemini Omni 1.2 Flash** (Gemini API, paid tier) | Yes: upload a video and edit it by prompt (docs example: "Add a cat… keep everything else the same") and append 3–10 s to its end; up to 6 reference images (e.g. a specific dog) | Input **≤15 s**, output ≤15 s (≤30 s total with extension); extension only at the **end**; 720p (1080p/4K upscaled); editing uploaded videos is **off** in the EEA / Switzerland / UK (Türkiye is not on that list); certain recognizable people restricted; no audio input / voice editing; invisible SynthID watermark on all output; English fully supported, other languages "not evaluated" | **720p ≈ $0.07/s** (10 s ≈ $0.70, 15 s ≈ $1.04) · 1080p ≈ $0.104/s · 4K ≈ $0.209/s · input $1.50 / 1M tokens (a 10 s video ≈ $0.002–0.005) |
| **Runway Aleph 2.0** | Yes: adds/removes objects or people in an existing video, keeping perspective and occlusion (vendor's description) | Input ≤30 s; third-party SaaS | **28 credits/s** (1 credit = $0.01) ≈ **$0.28/s**, minimum $0.56 → 10 s ≈ $2.80 |
| **Microsoft Foundry · Sora 2 (preview)** | **No (for real footage):** the docs say "video (generated) → video" and "blocks all IP and photorealistic content" | Only "remixes" videos it generated itself | ≈ $0.10/s (Azure price page, by region) |

**Example costs** (list price, before tax, one attempt): adding a dog to a 10 s street shot: Omni 720p ≈ **$0.70**, Aleph 2.0 ≈ **$2.80**. The result differs each time; 2–5 attempts may be needed until you like it (my estimate) → Omni ≈ $1.4–3.5, Aleph ≈ $5.6–14. A whole 60 s video: Omni needs 4 parts ≈ $4.2 per pass and the joins may look inconsistent; not practical, apply the generative step only to the shot that needs it. Scene extension: +5 s ≈ $0.35 (the docs do not say whether an extension bills the whole output or only the new part; if everything is billed, 15+5 s ≈ $1.40). The assistant's own (text) command cost stays ≈ 1–2 cents.

**Quality and privacy warnings:** (1) The clip is **regenerated**, the original pixels are not kept: resolution and fine texture may be lower than your recording (on 4K footage the added shot stays visibly soft). (2) The service also generates sound; audio input and voice editing are unsupported → to keep the original sound, replace only the picture and take the audio from the old recording (durations must match). (3) Frames/videos go to a third-party cloud; at work this needs policy and privacy approval. (4) The output is watermarked (SynthID, invisible) and subject to content-safety filters. (5) English prompts are the most reliable choice (the assistant can translate).

**Suggestion (optional roadmap):** Phase 1 (free, ≈2–4 days): give the assistant `extend_clip` (re-open the trimmed part), freeze the last frame, loop. Phase 2 (free, ≈1–2 weeks): text / picture / music layers. Phase 3 (paid, optional, ≈1–2 weeks): "generative edit / extend" with Omni: estimated price and a cap before each run, confirmation every time, shots ≤15 s, preview of the result and one-step undo. The efforts are my estimates.

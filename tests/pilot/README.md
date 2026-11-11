# tests\pilot — v3 ölçüm araçları · v3 measurement tools

Bu klasör **paketlenmez** (asar `/tests` klasörünü dışlar) ve uygulamanın çalışması için gerekli değildir. Amaç, `docs\internal\V3-COZUM-ONERILERI-SOLUTION-PROPOSALS.md` içindeki ölçümleri yeniden üretmektir.
This folder is **not packaged** and not needed to run the app. It exists to reproduce the measurements in `docs\internal\V3-COZUM-ONERILERI-SOLUTION-PROPOSALS.md`.

Hiçbir betik uygulama kodunu değiştirmez; hiçbiri buluta bağlanmaz (yalnızca COCO test fotoğraflarını indiren iki Python betiği hariç).
No script changes application code; none connects to a cloud service (except the two Python scripts that download the COCO test photos).

## Düzen · Layout

Betikler ve büyük veriler aynı klasörde durur (`ROOT = __dirname`). İndirilenler `tests\pilot\` altına konur:
Scripts and big data share this folder. Downloads go under `tests\pilot\`:

| Yol · Path | İçerik · Content | Nereden · Source |
|-----------|------------------|------------------|
| `llama-cpu\` | llama.cpp **b12212** Windows CPU derlemesi (`llama-server.exe`, `llama-bench.exe` …) · Windows CPU build | github.com/ggml-org/llama.cpp releases (MIT) |
| `llama-vk\` | llama.cpp **b12212** Vulkan derlemesi (iGPU) · Vulkan build | aynı yayın · same release |
| `models\` | GGUF dosyaları: `Qwen3.5-4B-Q4_K_M.gguf`, `Qwen3.5-4B-mmproj-F16.gguf`, `Qwen3.5-2B-Q4_K_M.gguf`, `gemma-4-E4B-it-Q4_K_M.gguf`, `gemma-4-E4B-mmproj-F16.gguf` | Hugging Face (Apache-2.0 ağırlıklar; lisansı kendiniz doğrulayın · verify the licence yourself) |
| `rec\run1`, `rec\run2` | `rec-main.js` çıktıları (kareler, `meta.json`, `truth.json`, `rec.mp4`) | betik üretir · produced by the scripts |
| `coco_vlm\` | COCO val2017 test fotoğrafları + `tasks.json`, `tasks_refer.json` | `fetch_coco_vlm.py`, `fetch_coco_refer.py` |
| `work\` | Çıktı günlükleri ve JSON sonuçlar (`work\vlm`, `work\bench`) | betikler üretir · produced by the scripts |

Bu belgedeki sayıların ham günlükleri `results\` altındadır (bkz. `results\README.md`). The raw logs behind the document's numbers are in `results\`.

ffmpeg yolu: projenin kendi sabitlenmiş ikilisi (`vendor\ffmpeg\bin`; önce proje kökünde `npm install` ve `npm run ffmpeg:fetch`).
ffmpeg path: the project's own pinned binary (`vendor\ffmpeg\bin`; run `npm install` and `npm run ffmpeg:fetch` in the project root first).

## Çalıştırma sırası · Run order

```powershell
cd tests\pilot

# 0) Sunucu başlatma denemesi · try the server launcher (Ctrl+C ile durdurun · stop with Ctrl+C)
node llm-srv.js --model=models\Qwen3.5-4B-Q4_K_M.gguf --mmproj=models\Qwen3.5-4B-mmproj-F16.gguf --backend=vk

# 1) Metin komut kıyaslaması (v2'nin gerçek ajan kodu) · text command benchmark (real v2 agent code)
node bench-all.js qwen3.5-4b,qwen3.5-2b        # çıktı · output: work\bench\*.json|log

# 2) Doğal fotoğraf test setleri · natural-photo test sets
python fetch_coco_vlm.py
python fetch_coco_refer.py

# 3) Görsel model testleri (CPU ve Vulkan) · vision-model tests (CPU and Vulkan)
node vlm-all.js q4b-cpu,g4e4b-cpu,q4b-vk,g4e4b-vk     # var/yok, kutu, olmayan nesne, ekran karesi
node vlm-extra.js q4b-vk,g4e4b-vk                     # soldaki/sağdaki + TR→EN sorgu
$env:VLM_EXTRA_STEPS = 'translate2'; node vlm-extra.js q4b-vk,g4e4b-vk   # katı yapılandırılmış sorgu

# 4) Ekran olayları (gerçek sohbet arayüzü kaydı; Electron gerekir) · screen events (needs Electron)
node llm-srv.js --model=models\Qwen3.5-4B-Q4_K_M.gguf --port=18090      # ayrı pencerede · in another window
npx electron rec-main.js --out=rec\run2 --url=http://127.0.0.1:18090/
node truth.js rec\run2
node build-video.js rec\run2
node screen-events.js activity rec\run2\rec.mp4 rec\run2\truth.json 10
$env:TNEG = '7.0'; node screen-events.js region rec\run2\rec.mp4 rec\run2\truth.json 13 991,651,40,40 10
node locate.js rec\run2\rec.mp4 <sablon.png> 40 40 13,25,45
```

Notlar · Notes

- Süreler, 12 çekirdekli AMD Ryzen AI 9 HX PRO 375 + Radeon 890M üzerinde alınmıştır; başka makinede farklı olur. Times were taken on that machine; other machines differ.
- Kutu biçimi modele özgüdür: Qwen3.5 `[x1,y1,x2,y2]` (0–1000), Gemma 4 `[y1,x1,y2,x2]` (0–1000). `vlm-coco.js` beş biçimi puanlar ve verinin gösterdiğini seçer. The box format is model-specific; `vlm-coco.js` scores five formats and picks the one the data shows.
- `llama-server` yalnızca `127.0.0.1`'e bağlanır; testler bu adrese konuşur. `llama-server` binds to `127.0.0.1` only.
- Bir sunucuyu durdururken yalnızca kendi başlattığınız süreci sonlandırın (PID ile).

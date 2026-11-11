# Ham ölçüm günlükleri · raw measurement logs

`docs\internal\V3-COZUM-ONERILERI-SOLUTION-PROPOSALS.md` içindeki sayıların kaynağı. Source of the numbers in that document. Makine · machine: AMD Ryzen AI 9 HX PRO 375 (12 çekirdek · cores), 31 GB RAM, Radeon 890M, Windows 11; llama.cpp b12212; modeller · models Q4_K_M.

| Dosya · File | İçerik · Content | Belge bölümü · Doc section |
|--------------|------------------|----------------------------|
| `vlm\<model>-<cpu\|vk>.coco.log` | Doğal fotoğraf: var/yok, kutu, olmayan nesne, hız · natural photos: yes/no, box, absent object, speed (`q4b` = Qwen3.5-4B, `g4e4b` = Gemma-4-E4B; `vk` = Vulkan iGPU) | 4.2 |
| `vlm\<model>-vk.refer.log` | "Soldaki / sağdaki" (26 soru) · left/right (26 questions) | 4.2 |
| `vlm\<model>-vk.translate.log` | Sözden İngilizce sorguya, serbest metin, hoşgörülü puan · free-text query, lenient scoring | 4.3 |
| `vlm\<model>-vk.translate2.log` | Aynısı, yapılandırılmış ve katı puan · structured, strict scoring | 4.2, 4.3 |
| `vlm\<model>-<cpu\|vk>.screen.log` | Ekran kaydı karelerinde durum sorusu + Stop düğmesini bulma · state question + finding the Stop button on screen-recording frames | 4.2 |
| `bench\qwen3.5-4b.log`, `qwen3.5-2b.log` | Metin komut kıyaslaması (temel + olay komutları) · text command benchmark (core + event commands) | 5.1, 5.3 |
| `bench\qwen3.5-4b.core-and-oldfacts.log`, `…facts-events-iv.log`, `…facts-ref-v1.log` | Olguların veriliş biçimi denemeleri (m:ss, aralık listesi, düz saniye, durum+oluşum v1) · fact-format trials | 5.3 |

Bilinen not · Known caveat: `vlm\q4b-cpu.screen.log` içindeki "WHERE" (Stop düğmesini bulma) satırları, kutu ayrıştırıcısındaki bir hata (`bbox_2d` içindeki "2"yi sayı sanıyordu) yüzünden yanlış puanlandı ("0/5"). Düzeltilmiş betikle alınan sonuç `vlm\q4b-vk.screen.log` içindedir (IoU ≥ 0,5: 3/5, merkez 5/5). The "WHERE" lines in `q4b-cpu.screen.log` were mis-scored by a parser bug (it read the "2" in `bbox_2d` as a number); the corrected result is in `q4b-vk.screen.log`. Ayrıca `g4e4b-cpu.coco.log` içindeki "GROUNDING" özeti, y-önce kutu biçimi o sırada puanlanmadığı için 3/12 gösterir; doğru değer (k1000yx) 12/12'dir ve `g4e4b-vk.coco.log` içinde bulunur. The "GROUNDING" summary in `g4e4b-cpu.coco.log` shows 3/12 because the y-first box format was not scored at that time; the correct value (k1000yx) is 12/12, shown in `g4e4b-vk.coco.log`.

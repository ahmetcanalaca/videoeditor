(function () {
  'use strict';
  // Strings that only exist in (or read differently in) the web edition; merged over the desktop dictionary.
  var dict = window.VE.i18n.dict;
  Object.assign(dict.tr, {
    'empty.sub': 'MP4, MOV, MKV, WebM ve daha fazlası',
    'err.import.PROBE_FAILED': 'Dosya okunamadı veya biçimi desteklenmiyor',
    'err.import.UNSUPPORTED_CODEC': 'Tarayıcınız bu videonun biçimini çözemiyor (ör. HEVC/H.265, AVI, WMV). MP4 (H.264), MOV veya WebM kullanın.',
    'proj.relinkMsg': 'Bu proje {n} videoya başvuruyor. Tarayıcılar dosya yollarını bilmediği için videoları yeniden seçmeniz gerekir (adı ve boyutu eşleşenler otomatik bağlanır).',
    'proj.relinkPick': 'Videoları seç',
    'proj.relinkSkip': 'Atla',
    'about.engine': 'Tarayıcı',
    'about.ffmpeg': 'Video motoru',
    'about.offline': '<b>Düzenleme tamamen tarayıcınızda çalışır</b>: videolarınız bilgisayarınızdan çıkmaz ve hiçbir sunucuya yüklenmez; API anahtarı, hesap veya kurulum gerekmez. Uygulama dosyaları yalnızca ilk açılışta indirilir, sonrasında çevrimdışı da çalışır. Telemetri / kullanım verisi toplanmaz.',
    'about.license': 'Video işleme tarayıcının WebCodecs desteği ve Mediabunny (MPL-2.0) ile yapılır.',
    'exerr.ENCODER': 'Video kodlayıcı başlatılamadı. Tarayıcınız bu boyutta H.264 kodlamayı desteklemiyor olabilir; çözünürlüğü düşürmeyi veya Chrome / Edge\'in güncel sürümünü deneyin.',
    'exerr.MEMORY': 'Bellek yetersiz. Daha düşük çözünürlük veya daha az klip deneyin.',
    'exerr.BUSY': 'Zaten bir dışa aktarma çalışıyor.',
    'exerr.AUDIO': 'Bir videonun sesi çözülemedi. O klibi sessize alıp tekrar deneyin.',
  });
  Object.assign(dict.en, {
    'empty.sub': 'MP4, MOV, MKV, WebM and more',
    'err.import.PROBE_FAILED': 'The file could not be read or its format is not supported',
    'err.import.UNSUPPORTED_CODEC': 'Your browser cannot decode this video format (e.g. HEVC/H.265, AVI, WMV). Use MP4 (H.264), MOV or WebM.',
    'proj.relinkMsg': 'This project refers to {n} video(s). Browsers do not know file paths, so you need to choose the videos again (files with the same name and size are linked automatically).',
    'proj.relinkPick': 'Choose videos',
    'proj.relinkSkip': 'Skip',
    'about.engine': 'Browser',
    'about.ffmpeg': 'Video engine',
    'about.offline': '<b>Editing runs entirely in your browser</b>: your videos never leave your computer and are not uploaded to any server; no API key, account or installation is needed. The app files are downloaded only on the first visit and afterwards it also works offline. No telemetry or usage data is collected.',
    'about.license': 'Video processing uses the browser\'s WebCodecs support and Mediabunny (MPL-2.0).',
    'exerr.ENCODER': 'The video encoder could not be started. Your browser may not support H.264 encoding at this size; try a lower resolution or a current Chrome / Edge.',
    'exerr.MEMORY': 'Not enough memory. Try a lower resolution or fewer clips.',
    'exerr.BUSY': 'An export is already running.',
    'exerr.AUDIO': 'The audio of a video could not be decoded. Mute that clip and try again.',
  });
})();

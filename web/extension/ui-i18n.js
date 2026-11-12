'use strict';
// The texts of the extension's own windows (popup, approval window); Turkish and English like the app. The language is the one of the page that talked to the
// extension last (so the windows follow the app's language setting), else the browser's.
(function () {
  const TEXT = {
    tr: {
      'pop.title': 'Foundry Local köprüsü',
      'pop.checking': 'Foundry Local aranıyor…',
      'pop.found': 'Foundry Local bulundu: {addr}',
      'pop.notFound': 'Foundry Local bulunamadı.',
      'pop.notFoundHelp': 'Çalışmıyor olabilir. Komut isteminde “foundry server start” yazın; sonra “Yeniden denetle”ye basın.',
      'pop.recheck': 'Yeniden denetle',
      'pop.scan': 'Otomatik bul',
      'pop.scanning': 'Taranıyor…',
      'pop.scanHint': '“Otomatik bul”, bu bilgisayarın 49152–65535 arasındaki portlarını (yalnızca 127.0.0.1) yoklar; ancak siz basınca çalışır.',
      'pop.port': 'Port',
      'pop.usePort': 'Kullan',
      'pop.portBad': 'Geçersiz port (1024–65535).',
      'pop.portNone': 'Bu portta Foundry Local yok.',
      'pop.portOther': 'Bu portta başka bir program var; Foundry Local değil.',
      'pop.portOk': 'Bağlandı.',
      'pop.fixHint': 'Kalıcı çözüm: portu sabitleyin, bir daha aramak gerekmez:',
      'pop.sites': 'İzin verilen siteler',
      'pop.noSites': 'Henüz izin verilen site yok.',
      'pop.remove': 'Kaldır',
      'pop.foot': 'Yalnızca 127.0.0.1 ile konuşur. İstemler, kareler ve yanıtlar saklanmaz.',
      'con.title': 'Video Editör, bu bilgisayardaki Foundry Local’i kullanmak istiyor',
      'con.site': 'Site:',
      'con.body': 'İzin verirseniz bu site, yalnızca bu bilgisayardaki Foundry Local sunucusuna (127.0.0.1) istek gönderebilir: modelleri ve yüklü modeli görmek, model yüklemek ve yapay zekâ asistanının komutlarını modele iletmek için. Başka hiçbir adrese bir şey gönderilmez.',
      'con.note': 'Foundry Local anahtar istemez: izin verdiğiniz site yüklü modeli kullanabilir. İzin, yukarıda görünen kökenin tamamına aittir, tek bir sayfaya değil. İzni istediğiniz zaman eklenti simgesinden kaldırabilirsiniz.',
      'con.allow': 'İzin ver',
      'con.deny': 'Vazgeç',
      'con.expired': 'Bu istek artık geçerli değil. Siteye dönüp yeniden deneyin.',
    },
    en: {
      'pop.title': 'Foundry Local bridge',
      'pop.checking': 'Looking for Foundry Local…',
      'pop.found': 'Foundry Local found: {addr}',
      'pop.notFound': 'Foundry Local was not found.',
      'pop.notFoundHelp': 'It may not be running. Type “foundry server start” in a command prompt, then press “Check again”.',
      'pop.recheck': 'Check again',
      'pop.scan': 'Find automatically',
      'pop.scanning': 'Scanning…',
      'pop.scanHint': '“Find automatically” tries the ports 49152–65535 of this computer (127.0.0.1 only); it runs only when you press it.',
      'pop.port': 'Port',
      'pop.usePort': 'Use',
      'pop.portBad': 'Not a valid port (1024–65535).',
      'pop.portNone': 'Foundry Local is not on this port.',
      'pop.portOther': 'Another program is on this port; it is not Foundry Local.',
      'pop.portOk': 'Connected.',
      'pop.fixHint': 'Permanent fix: set a fixed port, then nothing has to be searched again:',
      'pop.sites': 'Allowed sites',
      'pop.noSites': 'No site has been allowed yet.',
      'pop.remove': 'Remove',
      'pop.foot': 'Talks to 127.0.0.1 only. Prompts, pictures and answers are not stored.',
      'con.title': 'Video Editor wants to use Foundry Local on this computer',
      'con.site': 'Site:',
      'con.body': 'If you allow it, this site can send requests only to the Foundry Local server on this computer (127.0.0.1): to see its models and which one is loaded, to load a model and to pass the AI assistant’s commands to the model. Nothing is sent to any other address.',
      'con.note': 'Foundry Local takes no key: a site you allow can use the loaded model. The permission belongs to the whole origin shown above, not to one page. You can withdraw it at any time from the extension icon.',
      'con.allow': 'Allow',
      'con.deny': 'Deny',
      'con.expired': 'This request is no longer valid. Go back to the site and try again.',
    },
  };
  let lang = /^tr/i.test(chrome.i18n.getUILanguage()) ? 'tr' : 'en';
  const api = {
    set(l) { if (l === 'tr' || l === 'en') lang = l; document.documentElement.lang = lang; },
    t(key, vars) {
      let s = (TEXT[lang] && TEXT[lang][key]) || TEXT.en[key] || key;
      if (vars) Object.keys(vars).forEach((k) => { s = s.split('{' + k + '}').join(String(vars[k])); });
      return s;
    },
    // every element with data-t gets its text
    apply(root) { (root || document).querySelectorAll('[data-t]').forEach((n) => { n.textContent = api.t(n.getAttribute('data-t')); }); },
  };
  window.VEUI = api;
})();

/**
 * Omnia platform i18n — UI chrome translation (EN default / ITA).
 *
 * English lives in the markup; this file only carries the Italian strings.
 * Switching language goes through the confirm modal in brain-dock.js and
 * reloads the page, so `apply()` only ever has to translate EN → IT once,
 * at load.
 *
 * Static chrome:   annotate elements with
 *   data-i18n="key"        → textContent (innerHTML when the IT string has tags)
 *   data-i18n-ph="key"     → placeholder
 *   data-i18n-title="key"  → title attribute
 *   data-i18n-q="key"      → data-q attribute (chat suggestion chips)
 *
 * JS-generated strings:   window.OmniaI18n.t('key', 'English fallback')
 *
 * Technical vocabulary stays untouched everywhere: part numbers/SKUs,
 * station ids (ST100), step refs (S07), MES/UNICOMM/TIMKEN, file formats.
 */
(() => {
  'use strict';

  const lang = localStorage.getItem('omnia.lang') === 'it' ? 'it' : 'en';

  const IT = {
    /* ── Home ─────────────────────────────────────────────── */
    'home.topbarTitle': 'Omnia · Piattaforma Comer',
    'home.heroTitle': "L'intelligenza dello stabilimento, in un unico posto",
    'home.heroSub': 'Chiedi della linea, delle procedure o del materiale di addestramento — oppure apri uno dei servizi qui sotto.',
    'home.chatPh': 'Chiedi a Comer AI: “errori più comuni sul pinion guide?”, “coppia per il dado del pignone?”…',
    'home.ask': 'Chiedi',
    'home.attachTitle': 'Allega la foto di un componente',
    'home.removeImage': 'Rimuovi immagine',
    'home.chip1': 'Errori più comuni sul pinion guide?',
    'home.chip1q': 'Quali sono gli errori più comuni sul pinion guide?',
    'home.chip2': 'Consigli degli operatori sullo shim pack?',
    'home.chip2q': 'Cosa dicono gli operatori sulla fase dello shim pack?',
    'home.chip3': 'Coppia di serraggio del dado del pignone?',
    'home.chip3q': 'Che coppia per il dado del pignone?',
    'home.chip4': 'Cosa succede in linea adesso?',
    'home.chip4q': 'Cosa succede in linea adesso?',
    'home.chip5': 'Report avvisi occhiali',
    'home.chip5q': 'Mostrami il report degli avvisi degli occhiali',
    'home.showServices': '▾ mostra i servizi',
    'home.svcTag1': '01 · Servizio',
    'home.svcTag2': '02 · Servizio',
    'home.svcTag3': '03 · Servizio',
    'home.svc1h': 'Riconoscimento componenti e rilevamento errori',
    'home.svc1p': 'La knowledge base dello stabilimento — ogni stazione ha il proprio grafo. Carica materiale di addestramento e immagini di riferimento dei componenti, mappate sulla tassonomia degli errori.',
    'home.svc1cta': 'Apri la knowledge base <span class="arr">→</span>',
    'home.svc2h': 'Controlla la linea con domande in linguaggio naturale',
    'home.svc2p': 'Connessione MCP al MES UNICOMM / Fargo — fase in corso, operatore al lavoro, esiti di serraggio.',
    'home.svc2cta': 'Interroga la linea <span class="arr">→</span>',
    'home.svc3h': 'Report avvisi e risparmi',
    'home.svc3p': "Per operatore e per paio di occhiali: avvisi attivati, frame d'errore catturati dal POV, errori evitati — e il risparmio in rilavorazioni.",
    'home.svc3cta': 'Apri il report <span class="arr">→</span>',
    'home.lfStation': 'Stazione',
    'home.lfWorker': 'Operatore',
    'home.lfStep': 'Fase',
    'home.lfSerial': 'Seriale',
    'home.rmFired': 'attivati',
    'home.rmAvoided': 'evitati',
    'home.rmSaved': 'risparmio stim.',
    'home.navPlatform': 'Piattaforma',
    'home.navLiveLine': 'Linea live',
    'home.navReports': 'Report',
    'home.navTools': 'Strumenti',
    'home.navPilot': 'Pilota Rockford',
    'home.navSettings': 'Impostazioni',
    'home.signOut': 'Esci',
    'home.connecting': 'connessione…',
    'home.mesConnected': 'MES connesso',
    'home.mesDemo': 'dati demo · bridge in arrivo',
    'home.mesOffline': 'servizio linea offline',
    'home.you': 'Tu',
    'home.thinkBrain': 'Chiedo a Comer AI',
    'home.thinkLine': 'Interrogo la linea',
    'home.thinkReport': 'Preparo il report degli avvisi',
    'home.errBrain1': 'Comer AI non è raggiungibile al momento — ',
    'home.errBrain2': '. Riprova, o controlla il backend.',
    'home.errLine': 'Servizio linea non raggiungibile — ',
    'home.errReport': 'Impossibile generare il report — ',
    'home.whatIsThis': 'Che componente è questo?',
    'home.imageError': 'Errore immagine:',
    'home.noAnswer': 'Nessuna risposta.',
    'home.liveLine': 'Linea live',
    'home.mesConnectedChip': 'MES connesso ✓',
    'home.demoData': 'dati demo',
    'home.kSession': 'Sessione',
    'home.kUnit': 'Unità',
    'home.sessActive': 'attiva',
    'home.sessIdle': 'inattiva',
    'home.outOfRange': 'FUORI TOLLERANZA',
    'home.layoutNote': ' — il layout è definitivo; il bridge MCP della linea lo popolerà.',
    'home.glassesWarnings': 'Avvisi occhiali',
    'home.warningsFired': 'avvisi attivati',
    'home.mistakesAvoided': 'errori evitati',
    'home.slippedThrough': 'sfuggiti',
    'home.reworkSaved': 'risparmio rilavorazioni',
    'home.legAvoided': 'evitati',
    'home.legMissed': 'mancati',
    'home.savingsEq': 'Risparmio = evitati × ',
    'home.avgRework': ' rilavorazione media. ',
    'home.usedIn': 'usato in',
    'home.watchedFor': 'sorvegliato per:',
    'home.ifWrong': 'se sbagliato:',
    'home.wouldFire': '(scatterebbe sugli occhiali adesso)',
    'home.noMatch': 'nessuna corrispondenza a catalogo',

    /* ── Knowledge base ───────────────────────────────────── */
    'kb.topbarTitle': '<strong>Knowledge base dello stabilimento</strong> · cosa sa Comer AI dell\'impianto',
    'kb.vtFacility': 'Stabilimento',
    'kb.vtStation': 'Stazione',
    'kb.facH1': 'La linea, come la vede Comer AI',
    'kb.facP': "Le stazioni reali di Rockford, sul disegno effettivo dell'impianto (CNH Layout 1.dwg) — ogni punto è nella sua posizione fisica con stage, controlli MES storici e contatori di conoscenza. La cattura digital-twin (con tutti i suoi punti di vista) vive dentro ST100 · Pinion Guide. Clicca una stazione per aprirla; espandi a schermo intero per il dettaglio completo del disegno.",
    'kb.legActive': 'stazione attiva — grafo completo live',
    'kb.legScaffold': 'struttura — in attesa di materiale',
    'kb.legTwin': '✓ twin — digital twin disponibile',
    'kb.legCounts': 'contatori: fasi chiave · materiale · componenti',
    'kb.legChecks': '⚠ controlli — acquisizioni MES fuori limite (Full_stations_report)',
    'kb.legUnderlay': "sfondo — il disegno 2D dell'impianto (giallo = corsie e campate) · espandi per il dettaglio completo",
    'kb.twincardOpen': 'apri il digital twin ↗',
    'kb.backFac': '← Tutte le stazioni',
    'kb.backFacTitle': 'Torna alla vista stabilimento',
    'kb.labLinkFull': 'Grafo completo + strumenti eval ↗',
    'kb.labLinkOpen': "Apri nell'eval lab ↗",
    'kb.glassesSync': '<b>Sincronizzato dalla build degli occhiali</b> — ogni componente, immagine di riferimento e avviso qui sotto è ciò che gli occhiali Rokid eseguono oggi (<a id="glasses-sync-repo" href="#" target="_blank" rel="noopener">comer-rokid-demo ↗</a>). Per ora in una sola direzione: ciò che aggiungi qui resta sulla piattaforma e non viene inviato agli occhiali.',
    'kb.procRuns': 'La stazione esegue {n} procedure',
    'kb.p01': 'Grafo di conoscenza della stazione',
    'kb.graphHint': 'procedura · materiale · componenti · POV — clicca un nodo per capire perché Comer AI lo conosce',
    'kb.p02': 'Registrazioni POV della procedura',
    'kb.povPick': '＋ Registrazione POV della procedura completa (.mp4 / .mov / .webm)',
    'kb.povCorrect': '✓ eseguita correttamente',
    'kb.povMistake': '✕ contiene errori',
    'kb.povTranscriptPh': "Trascrizione audio — cosa è stato detto / sentito nella registrazione. Per ora digitata; l'auto-trascrizione (ASR) la compilerà una volta collegata.",
    'kb.povNotePh': 'Nota operatore (opzionale) — cosa pensi sia andato storto o vada osservato…',
    'kb.povSave': 'Aggiungi registrazione',
    'kb.povEmpty': 'nessuna registrazione POV — aggiungi esecuzioni corrette e sbagliate per addestrare la logica degli avvisi',
    'kb.p03': 'Materiale di addestramento',
    'kb.dropBig': 'Trascina o clicca per aggiungere materiale',
    'kb.dropSub': 'entra a far parte del grafo di questa stazione',
    'kb.artEmpty': 'nessun materiale — Comer AI non ha nulla caricato per questa stazione',
    'kb.p04': 'Riferimenti per il riconoscimento componenti',
    'kb.compEmpty': 'nessun componente mappato',
    'kb.compNamePh': 'Nome componente — es. Cuscinetto guida, Crush sleeve…',
    'kb.compPick': '＋ Immagini di riferimento (cosa deve riconoscere la CV / VLM)',
    'kb.compSave': 'Salva componente',
    'kb.taxNote': 'Mappa sulla tassonomia degli errori — quali guasti coinvolgono questo componente?',
    'kb.p05': 'Digital twin',
    'kb.twinAvail': '✓ disponibile',
    'kb.twinLoad': 'Carica il digital twin del pinion guide',
    'kb.twinSub': "cattura gaussian-splat dell'area pinion guide · operatore + geometria stazione",
    'kb.twinFoot': 'la stessa cattura su cui verrà simulata la logica degli avvisi (Omniverse in arrivo)',
    'kb.twinOpen': 'Apri il viewer completo ↗',

    /* ── Reports ──────────────────────────────────────────── */
    'rep.topbarTitle': '<strong>Report avvisi e risparmi</strong> · flotta occhiali',
    'rep.refresh': 'Aggiorna',
    'rep.h1': 'Avvisi occhiali',
    'rep.sub': "Per operatore e per paio di occhiali: avvisi attivati in linea, i frame POV catturati al momento dell'attivazione, errori evitati dopo l'avviso — e il costo di rilavorazione evitato.",
    'rep.loading': 'caricamento del report avvisi…',
    'rep.demoData': 'dati demo',
    'rep.warningsFired': 'avvisi attivati',
    'rep.mistakesAvoided': 'errori evitati',
    'rep.slippedThrough': 'sfuggiti',
    'rep.reworkSaved': 'risparmio rilavorazioni',
    'rep.perWorker': 'Per operatore · per paio di occhiali',
    'rep.legFired': 'avvisi attivati',
    'rep.legAvoided': 'evitati',
    'rep.legMissed': 'mancati',
    'rep.note1': 'Risparmio = evitati × ',
    'rep.note2': ' rilavorazione media (manodopera + ricambi). I frame POV vengono catturati dagli occhiali nel momento in cui scatta un avviso. ',
    'rep.loadErr': 'impossibile caricare il report — ',

    /* ── Digital twin viewer ──────────────────────────────── */
    'tw.recording': 'registrazione',
    'tw.layers': 'Livelli',
    'tw.rgbPov': 'RGB · POV operatore',
    'tw.worldView': 'Vista mondo',
    'tw.slamEye': 'SLAM + sguardo',
    'tw.aiReasoner': '✦ Interprete AI',
    'tw.aiCardHead': 'Interprete AI · ',
    'tw.povBuiltin': 'PG-04 percorso · integrato',
    'tw.syncReports': '⟳ sincronizza report',
    'tw.upload': '+ carica',
    'tw.eyeLevel': 'altezza occhi',
    'tw.step': 'fase',
    'tw.observing': 'osservazione',
    'tw.sees': 'vede: ',

    /* ── Back-home links (shared) ─────────────────────────── */
    'nav.backHome': '← Home',
  };

  const t = (key, en) => {
    if (lang === 'it' && Object.prototype.hasOwnProperty.call(IT, key)) return IT[key];
    return en !== undefined ? en : key;
  };

  function apply(root) {
    if (lang !== 'it') return;
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      const v = IT[el.dataset.i18n];
      if (v == null) return;
      if (v.indexOf('<') !== -1) el.innerHTML = v;
      else el.textContent = v;
    });
    scope.querySelectorAll('[data-i18n-ph]').forEach((el) => {
      const v = IT[el.dataset.i18nPh];
      if (v != null) el.placeholder = v;
    });
    scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const v = IT[el.dataset.i18nTitle];
      if (v != null) el.title = v;
    });
    scope.querySelectorAll('[data-i18n-q]').forEach((el) => {
      const v = IT[el.dataset.i18nQ];
      if (v != null) el.dataset.q = v;
    });
    document.documentElement.lang = 'it';
  }

  window.OmniaI18n = { lang, t, apply };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => apply());
  } else {
    apply();
  }
})();

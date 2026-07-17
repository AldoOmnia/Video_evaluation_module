/**
 * Brain dock — the platform-wide chat drawer (right side, any page).
 *
 * Include with:  <script src="/lab/assets/brain-dock.js" defer></script>
 * A page can describe what's in focus by setting:
 *
 *   window.BrainDockContext = () => ({
 *     page: 'Facility knowledge base',
 *     station: 'ST100 · Pinion Guide',   // optional
 *     view: 'station graph',             // optional
 *     detail: '…',                       // optional
 *   });
 *
 * The context is read fresh on every send, so it always reflects the
 * current window in focus. Backed by POST /api/assist:
 *   text  → the same retrieval + Claude pipeline the glasses /query runs
 *   image → Gemini vision (same models + reference set as the glasses
 *           VLM-observe loop) then grounded by Claude.
 */
(() => {
  'use strict';
  if (window.__BRAIN_DOCK__) return;
  window.__BRAIN_DOCK__ = true;

  const css = `
  .bd-toggle {
    position: fixed; right: 18px; bottom: 18px; z-index: 900;
    display: flex; align-items: center; gap: 8px;
    background: #0d0d0d; color: #00E5A0;
    border: 1px solid rgba(0,229,160,0.35); border-radius: 24px;
    padding: 10px 16px; cursor: pointer;
    font-family: 'Space Grotesk', 'Inter', system-ui, sans-serif;
    font-size: 11px; letter-spacing: 0.07em; text-transform: uppercase;
    box-shadow: 0 4px 24px rgba(0,0,0,0.5);
    transition: background 140ms ease, transform 140ms ease;
  }
  .bd-toggle:hover { background: rgba(0,229,160,0.08); transform: translateY(-1px); }
  .bd-toggle .dot { width: 7px; height: 7px; border-radius: 50%; background: #00E5A0; box-shadow: 0 0 8px rgba(0,229,160,0.8); }
  .bd-drawer {
    position: fixed; top: 0; right: 0; bottom: 0; z-index: 950;
    width: min(400px, 92vw);
    background: #0a0a0a; border-left: 1px solid #2a2a2a;
    box-shadow: -12px 0 40px rgba(0,0,0,0.55);
    display: flex; flex-direction: column;
    transform: translateX(102%); transition: transform 220ms ease;
    font-family: 'Inter', -apple-system, system-ui, sans-serif;
    color: #f5f5f5;
  }
  .bd-drawer.is-open { transform: translateX(0); }
  .bd-head {
    display: flex; align-items: center; gap: 10px;
    padding: 14px 16px; border-bottom: 1px solid #1f1f1f; flex: none;
  }
  .bd-head .t { font-size: 12.5px; font-weight: 600; letter-spacing: -0.01em; }
  .bd-head .ctx {
    font-family: 'Space Grotesk', 'Inter', system-ui, sans-serif; font-size: 9px;
    color: #6b6b6b; letter-spacing: 0.05em; text-transform: uppercase;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0;
  }
  .bd-close {
    background: none; border: none; color: #6b6b6b; font-size: 16px;
    cursor: pointer; padding: 2px 6px; flex: none;
  }
  .bd-close:hover { color: #f5f5f5; }
  .bd-msgs { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
  .bd-msg { max-width: 94%; font-size: 12.5px; line-height: 1.55; }
  .bd-msg.user {
    align-self: flex-end; background: rgba(0,229,160,0.09);
    border: 1px solid rgba(0,229,160,0.25); border-radius: 12px 12px 3px 12px;
    padding: 8px 12px; color: #e8fff6;
  }
  .bd-msg.user img { max-width: 140px; border-radius: 8px; display: block; margin-top: 6px; border: 1px solid rgba(0,229,160,0.3); }
  .bd-msg.brain {
    align-self: flex-start; background: #111; border: 1px solid #242424;
    border-radius: 12px 12px 12px 3px; padding: 10px 13px; color: #d9d9d9;
  }
  .bd-msg.brain b { color: #f5f5f5; }
  .bd-msg.brain ul { margin: 6px 0 0 16px; padding: 0; }
  .bd-msg.brain li { margin-bottom: 3px; }
  .bd-vision {
    border: 1px solid rgba(96,165,250,0.35); background: rgba(96,165,250,0.06);
    border-radius: 9px; padding: 8px 11px; margin-bottom: 8px; font-size: 12px;
  }
  .bd-vision .vh {
    font-family: 'Space Grotesk', 'Inter', system-ui, sans-serif; font-size: 8.5px;
    letter-spacing: 0.08em; text-transform: uppercase; color: #60a5fa; margin-bottom: 4px;
  }
  .bd-vision .conf { color: #6b6b6b; font-size: 11px; }
  .bd-vision .warn { color: #f59e0b; font-size: 11.5px; margin-top: 4px; }
  .bd-vision .warn b { color: inherit; font-weight: 600; }
  .bd-meta {
    font-family: 'Space Grotesk', 'Inter', system-ui, sans-serif; font-size: 8.5px;
    color: #6b6b6b; letter-spacing: 0.04em; margin-top: 8px; line-height: 1.7;
  }
  .bd-empty { color: #6b6b6b; font-size: 12px; line-height: 1.7; margin: auto 0; text-align: center; padding: 0 18px; }
  .bd-empty b { color: #a3a3a3; }
  .bd-thinking { color: #6b6b6b; font-family: 'Space Grotesk', 'Inter', system-ui, sans-serif; font-size: 10px; letter-spacing: 0.06em; }
  .bd-thinking::after { content: '…'; animation: bd-pulse 1.2s infinite; }
  @keyframes bd-pulse { 0%,100%{opacity:0.3} 50%{opacity:1} }
  .bd-inrow { border-top: 1px solid #1f1f1f; padding: 12px 14px; flex: none; }
  .bd-attach-preview {
    display: none; align-items: center; gap: 8px; margin-bottom: 8px;
    font-family: 'Space Grotesk', 'Inter', system-ui, sans-serif; font-size: 10px; color: #a3a3a3;
  }
  .bd-attach-preview.is-on { display: flex; }
  .bd-attach-preview img { width: 42px; height: 42px; object-fit: cover; border-radius: 6px; border: 1px solid #2a2a2a; }
  .bd-attach-preview button { background: none; border: none; color: #6b6b6b; cursor: pointer; font-size: 13px; }
  .bd-inflex { display: flex; gap: 8px; align-items: flex-end; }
  .bd-input {
    flex: 1; background: #111; border: 1px solid #2a2a2a; border-radius: 10px;
    color: #f5f5f5; font-family: inherit; font-size: 12.5px; line-height: 1.5;
    /* Two lines tall so the full "Ask… or attach a photo…" hint shows unclipped. */
    padding: 9px 12px; resize: none; min-height: 57px; max-height: 110px; outline: none;
  }
  .bd-input:focus { border-color: rgba(0,229,160,0.45); }
  .bd-btn {
    flex: none; border-radius: 10px; border: 1px solid #2a2a2a; background: #111;
    color: #a3a3a3; cursor: pointer; font-size: 14px; width: 38px; height: 38px;
    display: flex; align-items: center; justify-content: center;
    transition: border-color 120ms ease, color 120ms ease;
  }
  .bd-btn:hover { border-color: rgba(0,229,160,0.4); color: #00E5A0; }
  .bd-btn.send { background: rgba(0,229,160,0.12); border-color: rgba(0,229,160,0.4); color: #00E5A0; }
  .bd-btn:disabled { opacity: 0.4; cursor: default; }
  .bd-foot {
    font-family: 'Space Grotesk', 'Inter', system-ui, sans-serif; font-size: 8px; color: #4a4a4a;
    letter-spacing: 0.05em; text-transform: uppercase; text-align: center; margin-top: 8px;
  }`;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  /* ── DOM ── */
  const toggle = document.createElement('button');
  toggle.className = 'bd-toggle';
  toggle.type = 'button';
  toggle.innerHTML = '<span class="dot"></span> Ask Comer AI';
  document.body.appendChild(toggle);

  const drawer = document.createElement('aside');
  drawer.className = 'bd-drawer';
  drawer.setAttribute('aria-label', 'Comer AI chat');
  drawer.innerHTML = `
    <div class="bd-head">
      <span class="t">Comer AI</span>
      <span class="ctx" id="bd-ctx"></span>
      <button class="bd-close" type="button" title="Close (Esc)">✕</button>
    </div>
    <div class="bd-msgs" id="bd-msgs">
      <div class="bd-empty" id="bd-empty">
        Ask about <b>what's on screen</b> — procedures, tolerances, common mistakes —
        or attach a <b>photo of a component</b> and ask what it is.<br/><br/>
        Same models as the glasses: Gemini for vision, Claude for the knowledge base.
      </div>
    </div>
    <div class="bd-inrow">
      <div class="bd-attach-preview" id="bd-preview">
        <img id="bd-preview-img" alt=""/>
        <span id="bd-preview-name"></span>
        <button type="button" id="bd-preview-x" title="Remove image">✕</button>
      </div>
      <div class="bd-inflex">
        <button class="bd-btn" type="button" id="bd-attach" title="Attach a component photo" aria-label="Attach a component photo">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
          </svg>
        </button>
        <textarea class="bd-input" id="bd-input" rows="1"
          placeholder="Ask… or attach a photo and ask “what is this?”"></textarea>
        <button class="bd-btn send" type="button" id="bd-send" title="Send" aria-label="Send">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
      <input type="file" id="bd-file" accept="image/*" hidden />
      <div class="bd-foot">gemini vision + claude retrieval · mirrors the glasses 1:1</div>
    </div>`;
  document.body.appendChild(drawer);

  const $ = (id) => drawer.querySelector('#' + id);
  const msgs = $('bd-msgs');
  const input = $('bd-input');
  let attached = null; // { name, dataBase64, mimeType, previewUrl }
  let busy = false;

  /* ── Context ── */
  function getContext() {
    try {
      const c = typeof window.BrainDockContext === 'function'
        ? window.BrainDockContext()
        : window.BrainDockContext;
      if (c && typeof c === 'object') return c;
    } catch { /* page hook failed — fall through */ }
    return { page: document.title || location.pathname };
  }
  function refreshCtxLabel() {
    const c = getContext();
    $('bd-ctx').textContent = [c.page, c.station, c.view].filter(Boolean).join(' · ');
  }

  /* ── Open / close ── */
  function open() { drawer.classList.add('is-open'); refreshCtxLabel(); setTimeout(() => input.focus(), 220); }
  function close() { drawer.classList.remove('is-open'); }
  toggle.addEventListener('click', () => drawer.classList.contains('is-open') ? close() : open());
  drawer.querySelector('.bd-close').addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer.classList.contains('is-open')) close();
  });
  // compressImage is shared with the home-page chat so both attach paths
  // send the same downscaled JPEGs to /api/assist.
  window.BrainDock = { open, close, compressImage };

  /* ── Attach ──
     Phone photos are 8–12 MB; the /api/assist schema caps dataBase64 at
     6M chars (~4.5 MB). Downscale + re-encode to JPEG client-side — same
     resolution class as the frames the glasses send to the VLM. */
  const IMG_MAX_DIM = 1600;
  const IMG_MAX_B64 = 4_500_000;

  function fileToDataUrl(f) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error || new Error('read failed'));
      r.readAsDataURL(f);
    });
  }

  async function compressImage(f) {
    const raw = await fileToDataUrl(f);
    let img;
    try {
      img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = raw; });
    } catch {
      // Browser can't decode this format (e.g. HEIC outside Safari) —
      // pass through if it fits, otherwise surface a clear error.
      if (raw.length <= IMG_MAX_B64) return { dataBase64: raw, mimeType: f.type || 'image/jpeg' };
      throw new Error('This image format is too large to send — please use a JPG or PNG.');
    }
    const scale = Math.min(1, IMG_MAX_DIM / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    if (scale === 1 && raw.length <= IMG_MAX_B64) return { dataBase64: raw, mimeType: f.type || 'image/jpeg' };
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    let q = 0.85;
    let out = canvas.toDataURL('image/jpeg', q);
    while (out.length > IMG_MAX_B64 && q > 0.35) {
      q -= 0.15;
      out = canvas.toDataURL('image/jpeg', q);
    }
    return { dataBase64: out, mimeType: 'image/jpeg' };
  }

  $('bd-attach').addEventListener('click', () => $('bd-file').click());
  $('bd-file').addEventListener('change', async () => {
    const f = $('bd-file').files[0];
    $('bd-file').value = '';
    if (!f) return;
    try {
      const { dataBase64, mimeType } = await compressImage(f);
      attached = { name: f.name, dataBase64, mimeType, previewUrl: dataBase64 };
      $('bd-preview-img').src = attached.previewUrl;
      $('bd-preview-name').textContent = f.name;
      $('bd-preview').classList.add('is-on');
      input.focus();
    } catch (e) {
      attached = null;
      $('bd-preview').classList.remove('is-on');
      push(`<b>Image error:</b> ${esc(e && e.message ? e.message : 'Could not read that image.')}`, 'brain');
    }
  });
  $('bd-preview-x').addEventListener('click', () => {
    attached = null;
    $('bd-preview').classList.remove('is-on');
  });

  /* ── Messages ── */
  function push(html, cls) {
    const el = document.createElement('div');
    el.className = 'bd-msg ' + cls;
    el.innerHTML = html;
    const empty = $('bd-empty');
    if (empty) empty.remove();
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }

  function renderAnswer(d) {
    let html = '';
    if (d.vision) {
      const v = d.vision;
      const comp = v.component;
      html += `<div class="bd-vision"><div class="vh">vision · ${esc(v.model)}</div>`;
      if (v.stubbed) {
        html += `<b>${esc(v.className)}</b><div class="conf">${esc(v.reasoning)}</div>`;
      } else if (v.sku) {
        html += `<b>${esc(comp ? comp.name : v.className)}</b> <span class="conf">· SKU ${esc(v.sku)} · ${(v.confidence * 100).toFixed(0)}%</span>`;
        if (comp && comp.steps && comp.steps.length) html += `<div class="conf">used in ${comp.steps.map(esc).join(' · ')}</div>`;
        if (comp && comp.errorCodes && comp.errorCodes.length) html += `<div class="conf">watched for: ${comp.errorCodes.map(esc).join(' · ')}</div>`;
        if (v.flipped && comp && comp.warning && comp.warning.headline) {
          // Same overlay the glasses fire when the VLM resolves a FLIP decoy.
          html += `<div class="warn"><b>${esc(comp.warning.headline)}</b> — ${esc(comp.warning.action)} <span class="conf">(would fire on the glasses now)</span></div>`;
        } else if (comp && comp.warning && comp.warning.headline) {
          html += `<div class="conf">if wrong: ${esc(comp.warning.headline)} — ${esc(comp.warning.action)}</div>`;
        }
        if (v.reasoning) html += `<div class="conf" style="margin-top:4px;">${esc(v.reasoning)}</div>`;
      } else {
        html += `<b>${esc(v.className)}</b> <span class="conf">· no catalogue match</span>` +
          (v.reasoning ? `<div class="conf">${esc(v.reasoning)}</div>` : '');
      }
      html += '</div>';
    }
    const brief = d.labBrief || {};
    html += `<b>${esc(brief.headline || d.answer || '—')}</b>`;
    if (brief.bullets && brief.bullets.length) {
      html += '<ul>' + brief.bullets.map((b) => `<li>${esc(b)}</li>`).join('') + '</ul>';
    }
    const srcs = (d.retrieved || []).slice(0, 4).map((n) => esc(n.label)).join(' · ');
    html += `<div class="bd-meta">${d.stubbed ? 'STUB MODE — set ANTHROPIC_API_KEY for live answers<br/>' : ''}` +
      (srcs ? `grounded on: ${srcs}<br/>` : '') +
      `${d.latencyMs != null ? d.latencyMs + 'ms · ' : ''}${esc((d.models && d.models.vision) || '')}</div>`;
    return html;
  }

  // Map station mentions (UNICOMM table numbers or plain names) in a
  // question/answer to platform station ids, and tell the page about them —
  // the facility map listens and lights the matching rings up.
  const STATION_PATTERNS = [
    [/\bst\.?\s?-?100\b|pinion guide/i, 'pg-04'],
    [/\bst\.?\s?-?110\b|brake\s*(&|and)\s*cover/i, 'st110'],
    [/\bst\.?\s?-?13[05]\b|shimming/i, 'st130-135'],
    [/\bst\.?\s?-?140\b|brake complete/i, 'st140'],
    [/\bst\.?\s?-?150\b|pinion complete|brake test/i, 'st150'],
    [/\bst\.?\s?-?160\b|axle mount/i, 'st160'],
    [/\bst\.?\s?-?170\b/i, 'st170'],
    [/\bst\.?\s?-?1[89]0\b|test bench|prova di tenuta|leak test/i, 'st180-190'],
    [/\bst\.?\s?-?2[012]0\b|sub\s?differential/i, 'st200-220'],
    [/\bst\.?\s?-?300\b|tear drop\s?box/i, 'st300'],
    [/\bst\.?\s?-?310\b/i, 'st310'],
    [/\bst\.?\s?-?4[01]0\b|sub\s?assembly|wheel axle|quad track/i, 'st400-410'],
    [/\bst\.?\s?-?5[012]0\b|starship/i, 'st500-520'],
    [/\bst\.?\s?-?7[01]0\b|sub\s?planetary/i, 'st710'],
  ];
  function announceStations(text) {
    const ids = STATION_PATTERNS.filter(([re]) => re.test(text)).map(([, id]) => id);
    if (ids.length) {
      window.dispatchEvent(new CustomEvent('comerai:stations', { detail: { ids: [...new Set(ids)] } }));
    }
  }

  async function send() {
    if (busy) return;
    const q = input.value.trim();
    if (!q && !attached) return;
    busy = true; $('bd-send').disabled = true;

    let userHtml = esc(q || 'What is this component?');
    if (attached) userHtml += `<img src="${attached.previewUrl}" alt="${esc(attached.name)}"/>`;
    push(userHtml, 'user');
    const img = attached;
    input.value = ''; attached = null; $('bd-preview').classList.remove('is-on');

    const thinking = push(`<span class="bd-thinking">${img ? 'gemini vision + claude retrieval' : 'searching the knowledge base'}</span>`, 'brain');
    try {
      const r = await fetch('/api/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: q,
          images: img ? [{ name: img.name, dataBase64: img.dataBase64, mimeType: img.mimeType }] : [],
          context: getContext(),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      thinking.innerHTML = renderAnswer(d);
      const brief = d.labBrief || {};
      announceStations([
        q, brief.headline || d.answer || '',
        ...(brief.bullets || []),
        ...((d.retrieved || []).map((n) => n.label || '')),
      ].join(' \n '));
    } catch (e) {
      thinking.innerHTML = `<b>Something broke:</b> ${esc(e.message)}`;
    } finally {
      busy = false; $('bd-send').disabled = false;
      msgs.scrollTop = msgs.scrollHeight;
    }
  }
  $('bd-send').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(110, input.scrollHeight) + 'px';
  });
})();

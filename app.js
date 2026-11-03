/* Lister – statisk app på GitHub Pages, data som JSON i et privat GitHub-repo.
   Hver liste = én fil: lister/<id>.json i datarepoet. Se CLAUDE.md i datarepoet for formatet. */
'use strict';

const API = 'https://api.github.com';
const LS = { token: 'lister.token', repo: 'lister.repo', navn: 'lister.navn', skjul: 'lister.skjulFerdige' };
const DEFAULT_REPO = 'krishalvo-lab/lister-data';
// URL til delings-Workeren (worker/worker.js). Tom = live-deling av.
const WORKER = window.LISTER_WORKER || 'https://lister-del.krishalvo.workers.dev';
let LIVE = null; // { id, kode } når lista er åpnet via live-delelenke
const DIR = 'lister';
const STATUSES = ['Nei', 'Ja', 'Usikker'];
const POLL_LIST_MS = 12000;
const POLL_HOME_MS = 30000;

const TYPES = {
  handleliste: {
    label: 'Handleliste', flertall: 'Handlelister', status: 'Kjøpt/har hjemme', gruppe: 'Avdeling', tekst: 'Vare', butikk: true,
    avd: ['Frukt og grønt', 'Brød og bakevarer', 'Kjøtt og fisk', 'Pålegg og ost', 'Meieri og egg', 'Tørrvarer',
      'Hermetikk og sauser', 'Krydder', 'Frys', 'Drikke', 'Snacks og godteri', 'Husholdning', 'Hygiene', 'Annet']
  },
  huskeliste: { label: 'Huskeliste', flertall: 'Huskelister', status: 'Gjort', gruppe: 'Kategori', tekst: 'Punkt', butikk: false, avd: ['Generelt'] },
  pakkeliste: {
    label: 'Pakkeliste', flertall: 'Pakkelister', status: 'Pakket', gruppe: 'Kategori', tekst: 'Ting', butikk: false,
    avd: ['Klær', 'Toalettsaker', 'Elektronikk', 'Dokumenter', 'Utstyr', 'Mat og drikke', 'Annet']
  }
};
const typeOf = d => TYPES[d && d.type] || TYPES.huskeliste;
const KATEGORIER = ['Mat', 'Bygg', 'Hjem', 'Reise', 'Annet'];
const katOf = d => KATEGORIER.includes(d.kategori) ? d.kategori : '';

/* ---------- state ---------- */
const S = {
  view: 'loading',          // loading | setup | home | list
  lists: {},                // path -> { sha, data }
  homeEtag: null,
  cur: null,                // { path, sha, etag, data, pending: [] }
  saving: false,
  saveTimer: null,
  pollTimer: null
};

const ls = {
  get: k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
  set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { } }
};
const token = () => ls.get(LS.token);
const repo = () => ls.get(LS.repo) || DEFAULT_REPO;
const navn = () => ls.get(LS.navn) || 'App';
const hvem = () => (LIVE || S.view === 'shared') ? (ls.get('lister.mittNavn') || 'Gjest') : navn();
const stempel = () => ({ endret_av: hvem(), endret: new Date().toISOString() });

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 8);
const b64e = s => { const b = new TextEncoder().encode(s); let bin = ''; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(bin); };
const b64d = s => { const bin = atob(s.replace(/\s/g, '')); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); };
const slug = s => (s || 'liste').toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'liste';
const encPath = p => p.split('/').map(encodeURIComponent).join('/');
const today = () => new Date().toISOString().slice(0, 10);

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso), diff = (Date.now() - d) / 1000;
  if (diff < 60) return 'akkurat nå';
  if (diff < 3600) return Math.floor(diff / 60) + ' min siden';
  if (diff < 86400) return Math.floor(diff / 3600) + ' t siden';
  return d.toLocaleDateString('no-NO', { day: 'numeric', month: 'short' });
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}
function setSync(msg, err) { const s = $('#sync'); s.textContent = msg || ''; s.classList.toggle('err', !!err); }

function normalize(d) {
  d = d && typeof d === 'object' ? d : {};
  if (!TYPES[d.type]) d.type = 'huskeliste';
  d.navn = d.navn || 'Uten navn';
  if (!Array.isArray(d.avdelinger)) d.avdelinger = TYPES[d.type].avd.slice();
  if (!Array.isArray(d.punkter)) d.punkter = [];
  d.punkter.forEach(p => {
    if (!p.id) p.id = uid();
    if (!STATUSES.includes(p.status)) p.status = 'Nei';
    if (!p.avdeling) p.avdeling = d.avdelinger[d.avdelinger.length - 1] || 'Annet';
    ['tekst', 'mengde', 'brukes_i', 'merknad', 'butikk'].forEach(k => { if (p[k] == null) p[k] = ''; });
  });
  return d;
}
function counts(d) {
  const c = { tot: 0, Ja: 0, Nei: 0, Usikker: 0 };
  (d.punkter || []).forEach(p => { c.tot++; c[p.status] = (c[p.status] || 0) + 1; });
  return c;
}

/* ---------- GitHub API ---------- */
async function gh(path, opts = {}) {
  const headers = Object.assign({
    'Authorization': 'Bearer ' + token(),
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }, opts.headers || {});
  if (opts.body) headers['Content-Type'] = 'application/json';
  return fetch(API + path, Object.assign({}, opts, { headers, cache: 'no-store' }));
}
class HttpError extends Error { constructor(status, msg) { super(msg || ('HTTP ' + status)); this.status = status; } }

async function wFetch(method, body, etag) {
  const u = `${WORKER.replace(/\/$/, '')}/liste/${LIVE.id}` + (method === 'GET' ? `?k=${encodeURIComponent(LIVE.kode)}` : '');
  const h = {}; if (etag) h['If-None-Match'] = etag; if (body) h['Content-Type'] = 'application/json';
  return fetch(u, { method, headers: h, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
}
async function getFile(path, etag) {
  if (LIVE) {
    const r = await wFetch('GET', null, etag);
    if (r.status === 304) return { notModified: true };
    if (!r.ok) throw new HttpError(r.status);
    const j = await r.json();
    return { sha: j.sha, etag: r.headers.get('ETag'), data: normalize(j.data) };
  }
  const r = await gh(`/repos/${repo()}/contents/${encPath(path)}`, etag ? { headers: { 'If-None-Match': etag } } : {});
  if (r.status === 304) return { notModified: true };
  if (!r.ok) throw new HttpError(r.status);
  const j = await r.json();
  return { sha: j.sha, etag: r.headers.get('ETag'), data: normalize(JSON.parse(b64d(j.content))) };
}
async function putFile(path, data, sha, message) {
  if (LIVE) {
    const r = await wFetch('PUT', { k: LIVE.kode, sha, data, message });
    if (r.status === 409) throw new HttpError(409, 'konflikt');
    if (!r.ok) throw new HttpError(r.status);
    return (await r.json()).sha;
  }
  const body = { message, content: b64e(JSON.stringify(data, null, 2) + '\n') };
  if (sha) body.sha = sha;
  const r = await gh(`/repos/${repo()}/contents/${encPath(path)}`, { method: 'PUT', body: JSON.stringify(body) });
  if (r.status === 409 || r.status === 422) throw new HttpError(409, 'konflikt');
  if (!r.ok) throw new HttpError(r.status);
  const j = await r.json();
  return j.content.sha;
}
async function deleteFile(path, sha, message) {
  const r = await gh(`/repos/${repo()}/contents/${encPath(path)}`, { method: 'DELETE', body: JSON.stringify({ message, sha }) });
  if (!r.ok) throw new HttpError(r.status);
}
async function listDir(etag) {
  const r = await gh(`/repos/${repo()}/contents/${DIR}`, etag ? { headers: { 'If-None-Match': etag } } : {});
  if (r.status === 304) return { notModified: true };
  if (r.status === 404) return { files: [], etag: null };
  if (!r.ok) throw new HttpError(r.status);
  const j = await r.json();
  return { etag: r.headers.get('ETag'), files: (Array.isArray(j) ? j : []).filter(f => f.type === 'file' && f.name.endsWith('.json')) };
}

/* ---------- loading ---------- */
async function loadHome(force) {
  const res = await listDir(force ? null : S.homeEtag);
  if (res.notModified) return false;
  S.homeEtag = res.etag;
  const next = {};
  await Promise.all(res.files.map(async f => {
    const old = S.lists[f.path];
    if (old && old.sha === f.sha) { next[f.path] = old; return; }
    try { const g = await getFile(f.path); next[f.path] = { sha: g.sha, data: g.data }; }
    catch (e) { console.warn('Kunne ikke lese', f.path, e); }
  }));
  S.lists = next;
  return true;
}

function handleErr(e) {
  console.error(e);
  if (LIVE && e && (e.status === 403 || e.status === 404)) {
    clearTimeout(S.pollTimer); S.view = 'stopped';
    $('#app').innerHTML = '<div class="empty" style="margin-top:20px"><b>Delingen er stoppet.</b><br>Lista er ikke lenger delt med deg.</div>';
    setSync(''); return;
  }
  if (e && e.status === 401) { setSync('Nøkkelen virker ikke', true); go('setup'); return; }
  if (e && (e.status === 403 || e.status === 404)) { setSync('Ingen tilgang til ' + repo(), true); return; }
  setSync('Frakoblet – prøver igjen', true);
}

/* ---------- navigation ---------- */
function go(view, path) {
  S.view = view;
  clearTimeout(S.pollTimer);
  if (view === 'list') {
    const cached = S.lists[path];
    S.cur = { path, sha: cached ? cached.sha : null, etag: null, data: cached ? cached.data : null, pending: [] };
    const h = '#/' + encodeURIComponent(path.replace(DIR + '/', '').replace(/\.json$/, ''));
    if (!LIVE && location.hash !== h) history.replaceState(null, '', h);
    render();
    refreshList();
  } else {
    if (view === 'home' && S.cur && !S.cur.pending.length) S.cur = null;
    if (view === 'home' && location.hash) history.replaceState(null, '', location.pathname);
    render();
    if (view === 'home') refreshHome(true);
  }
  window.scrollTo(0, 0);
}

async function refreshHome(force) {
  clearTimeout(S.pollTimer);
  if (S.view !== 'home') return;
  try { if (await loadHome(force) || force) render(); setSync(''); }
  catch (e) { handleErr(e); if (force) render(); }
  if (S.view === 'home') S.pollTimer = setTimeout(() => refreshHome(false), POLL_HOME_MS);
}

async function refreshList() {
  clearTimeout(S.pollTimer);
  const cur = S.cur;
  if (S.view !== 'list' || !cur) return;
  if (!document.hidden && !cur.pending.length && !S.saving) {
    try {
      const g = await getFile(cur.path, cur.data ? cur.etag : null);
      if (S.cur === cur && !g.notModified && !cur.pending.length && !S.saving) {
        cur.etag = g.etag;
        if (g.sha !== cur.sha || !cur.data) { cur.sha = g.sha; cur.data = g.data; S.lists[cur.path] = { sha: g.sha, data: g.data }; render(); }
      }
      if (!S.saving && !cur.pending.length) setSync('');
    } catch (e) {
      if (e.status === 404) { toast('Lista finnes ikke lenger'); go('home'); return; }
      handleErr(e);
      if (S.view === 'stopped') return;
      if (!cur.data) render();
    }
  }
  if (S.view === 'list' && S.cur === cur) S.pollTimer = setTimeout(refreshList, POLL_LIST_MS);
}

/* ---------- mutations (op-basert, tåler samtidige endringer) ---------- */
function mutate(desc, fn) {
  const cur = S.cur; if (!cur || !cur.data) return;
  fn(cur.data);
  if (cur.shared) {
    const st = {}; cur.data.punkter.forEach(p => { if (p.status !== 'Nei') st[p.id] = p.status; });
    ls.set(cur.key, JSON.stringify({ st, extra: cur.data.punkter.filter(p => p.lokal) })); render(); return;
  }
  cur.pending.push({ desc, fn });
  S.lists[cur.path] = { sha: cur.sha, data: cur.data };
  render();
  setSync('Ikke lagret…');
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(flush, 700);
}

async function flush() {
  const cur = S.cur;
  if (S.saving || !cur || !cur.pending.length) return;
  S.saving = true; setSync('Lagrer…');
  const ops = cur.pending.splice(0);
  let tries = 0;
  for (;;) {
    try {
      cur.data.oppdatert = new Date().toISOString();
      const av = LIVE ? hvem() + ' (delt)' : hvem();
      cur.data.oppdatert_av = av;
      const d = ops.map(o => o.desc);
      const msg = `${av}: ${d.slice(0, 3).join(', ')}${d.length > 3 ? ` (+${d.length - 3})` : ''}`;
      cur.sha = await putFile(cur.path, cur.data, cur.sha, msg);
      cur.etag = null;
      S.lists[cur.path] = { sha: cur.sha, data: cur.data };
      break;
    } catch (e) {
      if (e.status === 409 && tries < 4) {
        tries++;
        try {
          const fresh = await getFile(cur.path);
          cur.sha = fresh.sha; cur.data = fresh.data;
          ops.forEach(o => o.fn(cur.data));
          cur.pending.forEach(o => o.fn(cur.data));
          continue;
        } catch (e2) { e = e2; }
      }
      cur.pending.unshift(...ops);
      S.saving = false;
      handleErr(e);
      setSync('Ikke lagret – prøver igjen', true);
      clearTimeout(S.saveTimer); S.saveTimer = setTimeout(flush, 5000);
      return;
    }
  }
  S.saving = false;
  if (S.cur === cur) render();
  if (cur.pending.length) { clearTimeout(S.saveTimer); S.saveTimer = setTimeout(flush, 300); }
  else setSync('Lagret ✓');
}

window.addEventListener('beforeunload', e => { if (S.cur && (S.cur.pending.length || S.saving)) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (S.cur && S.cur.pending.length) flush(); return; }
  if (S.view === 'list') refreshList(); else if (S.view === 'home') refreshHome(false);
});

/* ops */
const findP = (d, id) => d.punkter.find(p => p.id === id);
function ensureAvd(d, avd) { if (avd && !d.avdelinger.includes(avd)) d.avdelinger.push(avd); }
function opAdd(item) { item = Object.assign({}, item, stempel()); return d => { if (findP(d, item.id)) return; ensureAvd(d, item.avdeling); d.punkter.push(Object.assign({}, item)); }; }
function opSet(id, fields) { fields = Object.assign({}, fields, stempel()); return d => { const p = findP(d, id); if (!p) return; Object.assign(p, fields); ensureAvd(d, p.avdeling); }; }
function opDel(id) { return d => { d.punkter = d.punkter.filter(p => p.id !== id); }; }

/* ---------- rendering ---------- */
function render() {
  const app = $('#app');
  if (S.view === 'setup') app.innerHTML = viewSetup();
  else if (S.view === 'home') app.innerHTML = viewHome();
  else if (S.view === 'list' || S.view === 'shared') app.innerHTML = viewList();
  else app.innerHTML = '<p class="loading">Laster…</p>';
}

function viewSetup() {
  return `
  <p class="eyebrow">Oppsett · én gang per telefon</p>
  <h1 class="display" style="font-size:36px;margin:8px 0 18px">Koble til lister</h1>
  <div class="note">Listene ligger i det private repoet <b>${esc(repo())}</b>. Telefonen trenger en tilgangsnøkkel som bare kan lese og skrive der.
    <ol>
      <li>Åpne <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → ny fine-grained token</a>.</li>
      <li>Navn: <b>Lister – ${esc(ls.get(LS.navn) || 'iPhone')}</b>. Utløp: velg lengst mulig.</li>
      <li>Repository access: <b>Only select repositories</b> → <b>lister-data</b>.</li>
      <li>Permissions → Repository → <b>Contents: Read and write</b>.</li>
      <li>Generate token, kopier og lim inn her.</li>
    </ol>
  </div>
  <form data-form="setup">
    <div class="field"><label for="f-navn">Ditt navn (vises i historikken)</label>
      <input id="f-navn" type="text" name="navn" value="${esc(ls.get(LS.navn))}" placeholder="Kristian" required autocomplete="given-name"></div>
    <div class="field"><label for="f-token">Tilgangsnøkkel</label>
      <input id="f-token" type="password" name="token" value="${esc(token())}" placeholder="github_pat_…" required autocomplete="off" spellcheck="false"></div>
    <details><summary class="link" style="display:inline-block">Avansert</summary>
      <div class="field" style="margin-top:8px"><label for="f-repo">Datarepo</label>
        <input id="f-repo" type="text" name="repo" value="${esc(repo())}" spellcheck="false" autocapitalize="off"></div>
    </details>
    <div class="actions"><button class="btn btn-dark" type="submit">Koble til</button>
      ${token() ? '<button class="btn" type="button" data-act="home">Avbryt</button>' : ''}</div>
  </form>
  ${token() ? '<div class="actions" style="margin-top:28px"><button class="btn btn-danger" data-act="logout">Fjern nøkkel fra denne enheten</button></div>' : ''}`;
}

function viewHome() {
  const entries = Object.entries(S.lists).map(([path, v]) => ({ path, d: v.data }));
  const active = entries.filter(e => !e.d.arkivert);
  const arch = entries.filter(e => e.d.arkivert);
  const sortFn = (a, b) => String(b.d.oppdatert || b.d.opprettet || '').localeCompare(String(a.d.oppdatert || a.d.opprettet || ''));
  const card = e => {
    const c = counts(e.d), pct = c.tot ? Math.round(c.Ja / c.tot * 100) : 0;
    return `<button class="card" data-act="open" data-path="${esc(e.path)}">
      <div class="c-main"><h3>${esc(e.d.navn)}</h3>
        <p>${esc(typeOf(e.d).label)}${katOf(e.d) ? ' · ' + esc(katOf(e.d)) : ''}${e.d.oppdatert ? ' · ' + esc(when(e.d.oppdatert)) + (e.d.oppdatert_av ? ' av ' + esc(e.d.oppdatert_av) : '') : ''}</p>
        <div class="bar"><i style="width:${pct}%"></i></div></div>
      <div class="prog"><b>${c.Ja}/${c.tot}</b><small>${c.Usikker ? c.Usikker + ' usikker' : 'ferdig'}</small></div></button>`;
  };
  let html = `<div class="home-head"><div><p class="eyebrow">${esc(navn())}</p><h1 class="display">Lister</h1></div>
    <button class="btn btn-yellow" data-act="new">+ Ny liste</button></div>`;
  const kats = KATEGORIER.filter(k => active.some(e => katOf(e.d) === k));
  if (active.some(e => !katOf(e.d))) kats.push('Uten kategori');
  let hk = ls.get('lister.homeKat'); if (!kats.includes(hk)) hk = '';
  if (kats.length > 1) html += `<div class="sortbar"><button class="chip" data-act="homekat" data-val="" aria-pressed="${!hk}">Alle</button>${kats.map(k => `<button class="chip" data-act="homekat" data-val="${k}" aria-pressed="${hk === k}">${k}</button>`).join('')}</div>`;
  if (!entries.length) {
    html += `<div class="empty">Ingen lister ennå.<br>Trykk <b>+ Ny liste</b>, eller be Claude lage en.</div>`;
  } else {
    Object.keys(TYPES).forEach(t => {
      const g = active.filter(e => e.d.type === t && (!hk || (katOf(e.d) || 'Uten kategori') === hk)).sort(sortFn);
      if (!g.length) return;
      html += `<p class="eyebrow group-title">${esc(TYPES[t].flertall)}</p><div class="cards">${g.map(card).join('')}</div>`;
    });
    if (arch.length) html += `<details class="arch"><summary>Arkivert (${arch.length})</summary><div class="cards">${arch.sort(sortFn).map(card).join('')}</div></details>`;
  }
  return html;
}

function viewList() {
  const cur = S.cur;
  if (!cur || !cur.data) return '<p class="loading">Laster liste…</p>';
  const d = cur.data, T = typeOf(d), c = counts(d);
  const skjul = ls.get(LS.skjul) === '1';
  const order = d.avdelinger.slice();
  d.punkter.forEach(p => { if (!order.includes(p.avdeling)) order.push(p.avdeling); });
  const lastAvd = ls.get('lister.sistAvd.' + cur.path);
  const defAvd = order.includes(lastAvd) ? lastAvd : (T === TYPES.huskeliste ? order[0] : (order.includes('Annet') ? 'Annet' : order[order.length - 1]));

  if (cur.shared) {
    return `<div class="l-head"><div class="t"><p class="eyebrow">${esc(T.label)}${cur.fra ? ' · delt av ' + esc(cur.fra) : ''}</p><h1 class="display">${esc(d.navn)}</h1></div>
      <button class="icon-btn" data-act="m-text" aria-label="Kopier som tekst"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button></div>
      <p class="note">Trykk for å krysse av, og legg til det som mangler i feltet under. Endringene lagres på denne telefonen. Trykk «Send tilbake» når du vil at ${esc(cur.fra || 'avsenderen')} skal få dem.</p>
      <form class="quick" data-form="quick">
        <input type="text" name="tekst" placeholder="Legg til ${esc(T.tekst.toLowerCase())}…" autocomplete="off" enterkeyhint="done" aria-label="Ny ${esc(T.tekst.toLowerCase())}">
        <select name="avdeling" aria-label="${esc(T.gruppe)}">${order.map(a => `<option${a === (order.includes('Annet') ? 'Annet' : order[order.length - 1]) ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select>
        <button class="btn btn-dark" type="submit" aria-label="Legg til" style="padding:0 16px">+</button>
      </form>
      <div class="actions" style="margin:0 0 6px"><button class="btn btn-yellow" data-act="m-sendback">Send tilbake</button>
        ${token() ? `<button class="btn" data-act="m-import">Lagre i mine lister</button>` : ''}</div>
      <div class="tools"><label><input type="checkbox" data-act="skjul"${skjul ? ' checked' : ''}> Skjul det som er ${T === TYPES.handleliste ? 'kjøpt' : 'ferdig'}</label></div>`
      + listBody(d, T, order, skjul, c, true);
  }
  let html = `<div class="l-head"><div class="t"><p class="eyebrow">${esc(T.label)}${LIVE ? ' · delt med deg' : (d.del_kode ? ' · delt' : '')}</p><h1 class="display">${esc(d.navn)}</h1></div>
    <button class="icon-btn" data-act="listmenu" aria-label="Flere valg"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button></div>
  <form class="quick" data-form="quick">
    <input type="text" name="tekst" placeholder="Legg til ${esc(T.tekst.toLowerCase())}…" autocomplete="off" enterkeyhint="done" aria-label="Ny ${esc(T.tekst.toLowerCase())}">
    <select name="avdeling" aria-label="${esc(T.gruppe)}">${order.map(a => `<option${a === defAvd ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select>
    <button class="btn btn-dark" type="submit" aria-label="Legg til" style="padding:0 16px">+</button>
  </form>
  <div class="tools"><label><input type="checkbox" data-act="skjul"${skjul ? ' checked' : ''}> Skjul det som er ${T === TYPES.handleliste ? 'kjøpt' : 'ferdig'}</label>
    <button class="link" data-act="additem">Legg til med detaljer</button></div>`;
  return html + listBody(d, T, order, skjul, c, false);
}

function listBody(d, T, order, skjul, c, shared) {
  let html = '';
  let shown = 0;
  const vkey = S.cur.path || S.cur.key || 'x';
  const butikker = T.butikk ? [...new Set(d.punkter.map(p => (p.butikk || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'no')) : [];
  const harUten = d.punkter.some(p => !(p.butikk || '').trim());
  let gruppe = butikker.length ? (ls.get('lister.vis.' + vkey) || 'avdeling') : 'avdeling';
  let filt = ls.get('lister.butikk.' + vkey);
  if (filt && filt !== '__uten' && !butikker.includes(filt)) filt = '';
  const pass = p => !filt || (filt === '__uten' ? !(p.butikk || '').trim() : (p.butikk || '').trim() === filt);
  const punkter = d.punkter.filter(pass);
  if (butikker.length) {
    const chip = (val, label, on, act) => `<button class="chip" data-act="${act}" data-val="${esc(val)}" aria-pressed="${on}">${esc(label)}</button>`;
    html += `<div class="sortbar"><span class="sb-l">Grupper</span>${chip('avdeling', 'Avdeling', gruppe === 'avdeling', 'vis')}${chip('butikk', 'Butikk', gruppe === 'butikk', 'vis')}</div>
      <div class="sortbar"><span class="sb-l">Butikk</span>${chip('', 'Alle', !filt, 'bfilter')}${butikker.map(b => chip(b, b, filt === b, 'bfilter')).join('')}${harUten ? chip('__uten', 'Uten butikk', filt === '__uten', 'bfilter') : ''}</div>`;
    if (filt) c = counts({ punkter });
  }
  let groups;
  if (gruppe === 'butikk') {
    const keys = [...butikker, ''];
    groups = keys.map(k => [k || 'Uten butikk', punkter.filter(p => (p.butikk || '').trim() === k)]);
  } else groups = order.map(avd => [avd, punkter.filter(p => p.avdeling === avd)]);
  groups.forEach(([avd, items]) => {
    if (!items.length) return;
    const vis = skjul ? items.filter(p => p.status !== 'Ja') : items;
    const ferdig = items.filter(p => p.status === 'Ja').length;
    if (!vis.length) return;
    shown += vis.length;
    html += `<section class="dept"><div class="dept-h">${esc(avd)}<span>${ferdig}/${items.length}</span></div><div class="items">${vis.map(p => itemRow(p, T, shared, gruppe === 'butikk')).join('')}</div></section>`;
  });
  if (d.punkter.length && !punkter.length) html += `<div class="empty" style="margin-top:20px">Ingen punkter for denne butikken.</div>`;
  else if (!d.punkter.length) html += `<div class="empty" style="margin-top:20px">${shared ? 'Lista er tom.' : 'Tom liste. Skriv i feltet over for å legge til.'}</div>`;
  else if (!shown) html += `<div class="empty" style="margin-top:20px">Alt er ${T === TYPES.handleliste ? 'kjøpt' : 'ferdig'} 👌</div>`;

  html += `<section class="sum"><h2 class="display">Oppsummering${filt ? ' – ' + esc(filt === '__uten' ? 'uten butikk' : filt) : ''}</h2><dl>
    <dt>Antall ${T === TYPES.handleliste ? 'varer' : 'punkter'} totalt</dt><dd>${c.tot}</dd>
    <dt><span class="pill" style="background:var(--ja)"></span>Ferdig</dt><dd>${c.Ja}</dd>
    <dt><span class="pill" style="background:var(--nei)"></span>Mangler</dt><dd>${c.Nei}</dd>
    <dt><span class="pill" style="background:var(--usikker)"></span>Usikker${T === TYPES.handleliste ? ' (sjekk hjemme)' : ''}</dt><dd>${c.Usikker}</dd>
  </dl>${d.oppdatert && !shared ? `<p class="eyebrow" style="margin-top:14px;letter-spacing:.08em;text-transform:none">Sist endret ${esc(when(d.oppdatert))}${d.oppdatert_av ? ' av ' + esc(d.oppdatert_av) : ''}</p>` : ''}</section>`;
  return html;
}

function itemRow(p, T, shared, visAvd) {
  const meta = [];
  if (p.brukes_i) meta.push('<b>' + esc(p.brukes_i) + '</b>');
  if (visAvd) meta.push(esc(p.avdeling));
  else if (T.butikk && p.butikk) meta.push(esc(p.butikk));
  if (p.merknad) meta.push(esc(p.merknad));
  if (p.endret_av) meta.push(`<span class="who">${esc(p.endret_av)}${p.endret ? ' · ' + esc(when(p.endret)) : ''}</span>`);
  return `<div class="item s-${esc(p.status)}">
    <button class="st" data-act="cycle" data-id="${esc(p.id)}" aria-label="${esc(T.status)}: ${esc(p.status)}. Trykk for å endre">${esc(p.status)}<small>${esc(T.status.toUpperCase())}</small></button>
    <button class="i-main"${shared ? ' data-act="cycle"' : ' data-act="edit"'} data-id="${esc(p.id)}">
      <span class="i-top"><span class="i-name">${esc(p.tekst)}</span>${p.mengde ? `<span class="i-qty">${esc(p.mengde)}</span>` : ''}</span>
      ${meta.length ? `<span class="i-meta">${meta.join(' · ')}</span>` : ''}
    </button></div>`;
}

/* ---------- sheets ---------- */
function openSheet(html) { const s = $('#sheet'); s.innerHTML = `<div class="panel" role="dialog" aria-modal="true">${html}</div>`; s.hidden = false; const f = s.querySelector('input[autofocus]'); if (f) setTimeout(() => f.focus(), 50); }
function closeSheet() { const s = $('#sheet'); s.hidden = true; s.innerHTML = ''; }
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

function sheetItem(p) {
  const d = S.cur.data, T = typeOf(d), isNew = !p;
  p = p || { id: '', tekst: '', mengde: '', avdeling: ls.get('lister.sistAvd.' + S.cur.path) || d.avdelinger[0], brukes_i: '', merknad: '', butikk: '', status: 'Nei' };
  const order = d.avdelinger.slice(); if (!order.includes(p.avdeling)) order.push(p.avdeling);
  const butikker = [...new Set(Object.values(S.lists).flatMap(l => (l.data.punkter || []).map(x => x.butikk)).filter(Boolean))];
  openSheet(`<h2 class="display">${isNew ? 'Legg til' : 'Endre'}</h2>
  <form data-form="item" data-id="${esc(p.id)}">
    <div class="field"><label>${esc(T.status)}</label><div class="seg">${STATUSES.map(s => `<button type="button" class="v-${s}" data-act="seg" data-val="${s}" aria-pressed="${p.status === s}">${s}</button>`).join('')}</div>
      <input type="hidden" name="status" value="${esc(p.status)}"></div>
    <div class="field"><label for="i-tekst">${esc(T.tekst)}</label><input id="i-tekst" type="text" name="tekst" value="${esc(p.tekst)}" required${isNew ? ' autofocus' : ''}></div>
    <div class="row2">
      <div class="field"><label for="i-mengde">Mengde</label><input id="i-mengde" type="text" name="mengde" value="${esc(p.mengde)}" placeholder="f.eks. 2 stk, ?"></div>
      <div class="field"><label for="i-avd">${esc(T.gruppe)}</label><input id="i-avd" type="text" name="avdeling" value="${esc(p.avdeling)}" list="avd-list" required>
        <datalist id="avd-list">${order.map(a => `<option value="${esc(a)}">`).join('')}</datalist></div>
    </div>
    <div class="field"><label for="i-brukes">Brukes i</label><input id="i-brukes" type="text" name="brukes_i" value="${esc(p.brukes_i)}"></div>
    ${T.butikk ? `<div class="field"><label for="i-butikk">Butikk</label><input id="i-butikk" type="text" name="butikk" value="${esc(p.butikk)}" list="butikk-list">
      <datalist id="butikk-list">${butikker.map(b => `<option value="${esc(b)}">`).join('')}</datalist></div>` : ''}
    <div class="field"><label for="i-merknad">Merknad</label><input id="i-merknad" type="text" name="merknad" value="${esc(p.merknad)}"></div>
    <div class="actions"><button class="btn btn-dark" type="submit">${isNew ? 'Legg til' : 'Lagre'}</button><button class="btn" type="button" data-act="close">Avbryt</button></div>
    ${isNew ? '' : `<div class="actions"><button class="btn btn-danger" type="button" data-act="delitem" data-id="${esc(p.id)}">Fjern fra lista</button></div>`}
  </form>`);
}

function sheetNewList(prefill) {
  const t = (prefill && prefill.type) || 'handleliste';
  openSheet(`<h2 class="display">${prefill && prefill.copyOf ? 'Kopier liste' : 'Ny liste'}</h2>
  <form data-form="newlist">
    <div class="field"><label for="n-navn">Navn</label><input id="n-navn" type="text" name="navn" value="${esc((prefill && prefill.navn) || '')}" placeholder="f.eks. Fajitas, Hytta, Tanzania" required autofocus></div>
    <div class="field"><label>Type</label><div class="seg">${Object.entries(TYPES).map(([k, v]) => `<button type="button" class="v-type" data-act="seg" data-val="${k}" aria-pressed="${k === t}">${v.label}</button>`).join('')}</div>
      <input type="hidden" name="status" value="${t}"></div>
    <div class="field"><label>Kategori</label><div class="seg seg5">${KATEGORIER.map(x => `<button type="button" class="v-type" data-act="seg" data-val="${x}" aria-pressed="${x === ((prefill && prefill.kategori) || '')}">${x}</button>`).join('')}</div>
      <input type="hidden" name="kategori" value="${(prefill && prefill.kategori) || ''}"></div>
    ${prefill && prefill.copyOf ? `<input type="hidden" name="copyOf" value="${esc(prefill.copyOf)}"><p class="note">Alle punkter kopieres og settes til «Nei».</p>` : ''}
    <div class="actions"><button class="btn btn-dark" type="submit">Opprett</button><button class="btn" type="button" data-act="close">Avbryt</button></div>
  </form>`);
}

function sheetListMenu() {
  const d = S.cur.data;
  if (LIVE) {
    openSheet(`<h2 class="display">${esc(d.navn)}</h2><div class="menu">
      <button class="btn" data-act="m-guestname">Endre navnet ditt (${esc(ls.get('lister.mittNavn') || 'Gjest')})</button>
      <button class="btn" data-act="m-text">Kopier som tekst (til SMS)</button>
      <button class="btn" data-act="m-reset">Sett alt tilbake til «Nei»</button>
      <button class="btn" data-act="m-cleardone">Fjern alt som er «Ja»</button>
      <button class="btn" data-act="close" style="justify-content:center">Lukk</button></div>`);
    return;
  }
  openSheet(`<h2 class="display">${esc(d.navn)}</h2><div class="menu">
    ${WORKER ? `<button class="btn btn-yellow" data-act="m-live">${d.del_kode ? 'Send live-lenken på nytt' : 'Del live (redigerer samme liste)'}</button>` : ''}
    ${d.del_kode ? '<button class="btn btn-danger" data-act="m-stopshare">Stopp deling</button>' : ''}
    <button class="btn" data-act="m-rename">Gi nytt navn</button>
    <button class="btn" data-act="m-kat">Kategori: ${esc(katOf(d) || 'ikke valgt')}</button>
    <button class="btn" data-act="m-share">${WORKER ? 'Del kopi (mottakeren får sin egen)' : 'Del lenke (bare denne lista)'}</button>
    <button class="btn" data-act="m-text">Kopier som tekst (til SMS)</button>
    <button class="btn" data-act="m-reset">Sett alt tilbake til «Nei»</button>
    <button class="btn" data-act="m-cleardone">Fjern alt som er «Ja»</button>
    <button class="btn" data-act="m-copy">Lag kopi av lista</button>
    <button class="btn" data-act="m-archive">${d.arkivert ? 'Hent fra arkivet' : 'Arkiver'}</button>
    <button class="btn btn-danger" data-act="m-delete">Slett lista</button>
    <button class="btn" data-act="close" style="justify-content:center">Lukk</button></div>`);
}
function sheetConfirm(title, text, act, label) {
  openSheet(`<h2 class="display">${esc(title)}</h2><p class="note">${esc(text)}</p>
  <div class="actions"><button class="btn btn-danger" data-act="${act}">${esc(label)}</button><button class="btn" data-act="close">Avbryt</button></div>`);
}
function sheetRename() {
  openSheet(`<h2 class="display">Nytt navn</h2><form data-form="rename"><div class="field"><input type="text" name="navn" value="${esc(S.cur.data.navn)}" required autofocus></div>
  <div class="actions"><button class="btn btn-dark" type="submit">Lagre</button><button class="btn" type="button" data-act="close">Avbryt</button></div></form>`);
}

/* ---------- list creation / deletion ---------- */
async function createList(navnStr, type, copyOf, kategori) {
  const base = slug(navnStr);
  let id = base, n = 2;
  const exists = async p => { if (S.lists[p]) return true; try { await getFile(p); return true; } catch (e) { if (e.status === 404) return false; throw e; } };
  while (await exists(`${DIR}/${id}.json`)) id = `${base}-${n++}`;
  const path = `${DIR}/${id}.json`;
  const src = copyOf && S.lists[copyOf] ? S.lists[copyOf].data : null;
  const data = normalize({
    navn: navnStr, type, kategori: KATEGORIER.includes(kategori) ? kategori : (src && src.kategori) || '', opprettet: today(), arkivert: false,
    avdelinger: src ? src.avdelinger.slice() : TYPES[type].avd.slice(),
    punkter: src ? src.punkter.map(p => Object.assign({}, p, { id: uid(), status: 'Nei' })) : []
  });
  data.oppdatert = new Date().toISOString(); data.oppdatert_av = navn();
  setSync('Lagrer…');
  const sha = await putFile(path, data, null, `${navn()}: ny ${TYPES[type].label.toLowerCase()} «${navnStr}»`);
  S.lists[path] = { sha, data };
  setSync('Lagret ✓');
  return path;
}

function listAsText(d) {
  const T = typeOf(d), order = d.avdelinger.slice();
  d.punkter.forEach(p => { if (!order.includes(p.avdeling)) order.push(p.avdeling); });
  const lines = [d.navn];
  order.forEach(a => {
    const it = d.punkter.filter(p => p.avdeling === a && p.status !== 'Ja');
    if (!it.length) return;
    lines.push('', a.toUpperCase());
    it.forEach(p => lines.push(`${p.status === 'Usikker' ? '?' : '☐'} ${p.tekst}${p.mengde ? ' – ' + p.mengde : ''}${T.butikk && p.butikk ? ' (' + p.butikk + ')' : ''}`));
  });
  return lines.join('\n');
}

/* ---------- events ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;
  if (act === 'skjul') { ls.set(LS.skjul, el.checked ? '1' : ''); render(); return; }
  if (el.tagName === 'A') return;
  switch (act) {
    case 'home': if (LIVE) { if (token()) { LIVE = null; document.body.classList.remove('shared'); history.replaceState(null, '', location.pathname); go('home'); } break; }
      if (S.view === 'shared') { if (token()) { location.hash = ''; document.body.classList.remove('shared'); go('home'); } } else if (token()) go('home'); break;
    case 'settings': if (S.view !== 'shared' && !LIVE) go('setup'); break;
    case 'logout': ls.set(LS.token, ''); S.lists = {}; S.homeEtag = null; go('setup'); break;
    case 'open': go('list', el.dataset.path); break;
    case 'new': sheetNewList(); break;
    case 'close': closeSheet(); break;
    case 'seg': {
      const wrap = el.parentElement; wrap.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === el));
      wrap.parentElement.querySelector('input[type=hidden]').value = el.dataset.val; break;
    }
    case 'cycle': {
      const p = findP(S.cur.data, id); if (!p) return;
      const next = STATUSES[(STATUSES.indexOf(p.status) + 1) % STATUSES.length];
      mutate(`${p.tekst} → ${next}`, opSet(id, { status: next })); break;
    }
    case 'edit': sheetItem(findP(S.cur.data, id)); break;
    case 'additem': sheetItem(null); break;
    case 'delitem': { const p = findP(S.cur.data, id); closeSheet(); if (p) { mutate(`fjernet ${p.tekst}`, opDel(id)); toast(`Fjernet «${p.tekst}»`); } break; }
    case 'listmenu': sheetListMenu(); break;
    case 'm-rename': sheetRename(); break;
    case 'vis': ls.set('lister.vis.' + (S.cur.path || S.cur.key), el.dataset.val); render(); break;
    case 'bfilter': ls.set('lister.butikk.' + (S.cur.path || S.cur.key), el.dataset.val); render(); break;
    case 'homekat': ls.set('lister.homeKat', el.dataset.val); render(); break;
    case 'm-kat': {
      const k = katOf(S.cur.data);
      openSheet(`<h2 class="display">Kategori</h2><form data-form="kat"><div class="field"><div class="seg seg5">${KATEGORIER.map(x => `<button type="button" class="v-type" data-act="seg" data-val="${x}" aria-pressed="${x === k}">${x}</button>`).join('')}</div>
        <input type="hidden" name="kategori" value="${k}"></div><div class="actions"><button class="btn btn-dark" type="submit">Lagre</button><button class="btn" type="button" data-act="close">Avbryt</button></div></form>`);
      break;
    }
    case 'm-share': shareList(); break;
    case 'm-live': shareLive(); break;
    case 'm-stopshare': sheetConfirm('Stoppe deling?', 'Live-lenken slutter å virke med en gang. Lista blir liggende hos deg som før.', 'm-stopshare-yes', 'Stopp deling'); break;
    case 'm-stopshare-yes': closeSheet(); mutate('stoppet deling', d => { delete d.del_kode; }); toast('Deling stoppet'); break;
    case 'm-guestname': askGuestName(false); break;
    case 'm-sendback':
      openSheet(`<h2 class="display">Send tilbake</h2><form data-form="sendback"><div class="field"><label for="sb-navn">Ditt navn</label>
        <input id="sb-navn" type="text" name="navn" value="${esc(ls.get('lister.mittNavn'))}" required autofocus></div>
        <p class="note">Du får en lenke med avkrysningene og tilleggene dine. Send den tilbake på SMS.</p>
        <div class="actions"><button class="btn btn-dark" type="submit">Lag lenke</button><button class="btn" type="button" data-act="close">Avbryt</button></div></form>`);
      break;
    case 'm-import': importShared(); break;
    case 'm-merge': mergeInto(); break;
    case 'm-importnew': importNew(); break;
    case 'm-text': {
      const txt = listAsText(S.cur.data); closeSheet();
      try { await navigator.clipboard.writeText(txt); toast('Kopiert – lim inn i SMS'); }
      catch (err) { openSheet(`<h2 class="display">Kopier</h2><textarea rows="12" readonly>${esc(txt)}</textarea><div class="actions"><button class="btn" data-act="close">Lukk</button></div>`); }
      break;
    }
    case 'm-reset': { closeSheet(); const st = stempel(); mutate('alt tilbake til Nei', d => d.punkter.forEach(p => { if (p.status !== 'Nei') Object.assign(p, { status: 'Nei' }, st); })); break; }
    case 'm-cleardone': closeSheet(); mutate('fjernet alt som var Ja', d => { d.punkter = d.punkter.filter(p => p.status !== 'Ja'); }); break;
    case 'm-copy': sheetNewList({ navn: S.cur.data.navn + ' (kopi)', type: S.cur.data.type, kategori: katOf(S.cur.data), copyOf: S.cur.path }); break;
    case 'm-archive': { const a = !S.cur.data.arkivert; closeSheet(); mutate(a ? 'arkivert' : 'hentet fra arkiv', d => { d.arkivert = a; }); toast(a ? 'Arkivert' : 'Hentet fra arkivet'); break; }
    case 'm-delete': sheetConfirm('Slette lista?', `«${S.cur.data.navn}» slettes. Den kan hentes tilbake fra historikken på GitHub, men ikke herfra.`, 'm-delete-yes', 'Slett'); break;
    case 'm-delete-yes': {
      closeSheet();
      const cur = S.cur;
      try {
        clearTimeout(S.saveTimer); cur.pending = [];
        const g = await getFile(cur.path);
        await deleteFile(cur.path, g.sha, `${navn()}: slettet «${cur.data.navn}»`);
        delete S.lists[cur.path]; S.cur = null; toast('Lista er slettet'); go('home');
      } catch (err) { handleErr(err); toast('Kunne ikke slette'); }
      break;
    }
  }
});

document.addEventListener('submit', async e => {
  const f = e.target; if (!f.dataset.form) return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(f).entries());
  Object.keys(v).forEach(k => { v[k] = String(v[k]).trim(); });
  switch (f.dataset.form) {
    case 'setup': {
      ls.set(LS.navn, v.navn); ls.set(LS.token, v.token); ls.set(LS.repo, v.repo && v.repo !== DEFAULT_REPO ? v.repo : '');
      setSync('Sjekker…');
      try {
        const r = await gh(`/repos/${repo()}`);
        if (r.status === 401) throw new HttpError(401);
        if (!r.ok) throw new HttpError(r.status);
        S.lists = {}; S.homeEtag = null; setSync(''); toast('Tilkoblet ✓'); go('home');
      } catch (err) {
        setSync(err.status === 401 ? 'Nøkkelen virker ikke' : err.status === 404 ? 'Fant ikke repoet – sjekk at nøkkelen har tilgang til lister-data' : 'Fikk ikke kontakt', true);
      }
      break;
    }
    case 'quick': {
      if (!v.tekst) return;
      ls.set('lister.sistAvd.' + S.cur.path, v.avdeling);
      const item = { id: uid(), tekst: v.tekst, mengde: '', avdeling: v.avdeling, brukes_i: '', merknad: '', butikk: '', status: 'Nei' };
      if (S.cur.shared) { item.lokal = true; item.merknad = 'Lagt til av mottaker'; }
      mutate(`la til ${v.tekst}`, opAdd(item));
      const inp = $('form[data-form=quick] input[name=tekst]'); if (inp) inp.focus();
      break;
    }
    case 'item': {
      const fields = { tekst: v.tekst, mengde: v.mengde, avdeling: v.avdeling || 'Annet', brukes_i: v.brukes_i, merknad: v.merknad, status: v.status };
      if (typeOf(S.cur.data).butikk) fields.butikk = v.butikk || '';
      ls.set('lister.sistAvd.' + S.cur.path, fields.avdeling);
      closeSheet();
      if (f.dataset.id) mutate(`endret ${fields.tekst}`, opSet(f.dataset.id, fields));
      else mutate(`la til ${fields.tekst}`, opAdd(Object.assign({ id: uid(), butikk: '' }, fields)));
      break;
    }
    case 'newlist': {
      if (!KATEGORIER.includes(v.kategori)) { toast('Velg kategori'); return; }
      const btn = f.querySelector('[type=submit]'); btn.disabled = true; btn.textContent = 'Oppretter…';
      try { const path = await createList(v.navn, v.status, v.copyOf, v.kategori); closeSheet(); go('list', path); }
      catch (err) { handleErr(err); btn.disabled = false; btn.textContent = 'Opprett'; toast('Kunne ikke opprette lista'); }
      break;
    }
    case 'sendback': ls.set('lister.mittNavn', v.navn); shareList(v.navn); break;
    case 'guestname': ls.set('lister.mittNavn', v.navn); closeSheet(); toast('Hei, ' + v.navn); break;
    case 'kat': if (!KATEGORIER.includes(v.kategori)) { toast('Velg kategori'); return; } closeSheet(); mutate(`kategori ${v.kategori}`, d => { d.kategori = v.kategori; }); break;
    case 'rename': closeSheet(); mutate(`nytt navn ${v.navn}`, d => { d.navn = v.navn; }); break;
  }
});

/* ---------- deling: hele lista ligger i lenken (#del=...), ingen nøkkel trengs ---------- */
const b64urlE = bytes => { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const b64urlD = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s); return Uint8Array.from(bin, c => c.charCodeAt(0)); };
async function packShare(d, fra, kilde) {
  const obj = { v: 1, fra: fra || navn(), kilde: kilde || '', navn: d.navn, type: d.type, avdelinger: d.avdelinger,
    punkter: d.punkter.map(p => ({ id: p.id, tekst: p.tekst, mengde: p.mengde, avdeling: p.avdeling, brukes_i: p.brukes_i, merknad: p.merknad, butikk: p.butikk, status: p.status })) };
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if (window.CompressionStream) {
    const buf = await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
    return 'z' + b64urlE(new Uint8Array(buf));
  }
  return 'j' + b64urlE(raw);
}
async function unpackShare(code) {
  const bytes = b64urlD(code.slice(1));
  let txt;
  if (code[0] === 'z') txt = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  else txt = new TextDecoder().decode(bytes);
  return JSON.parse(txt);
}
async function shareList(fra) {
  const d = S.cur.data;
  const kilde = S.cur.shared ? S.cur.kilde : S.cur.path.replace(DIR + '/', '').replace(/\.json$/, '');
  const url = location.origin + location.pathname + '#del=' + await packShare(d, fra, kilde);
  closeSheet();
  if (navigator.share) {
    try { await navigator.share({ title: d.navn, text: d.navn, url }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Lenke kopiert'); }
  catch (e) { openSheet(`<h2 class="display">Delelenke</h2><textarea rows="6" readonly>${esc(url)}</textarea><div class="actions"><button class="btn" data-act="close">Lukk</button></div>`); }
}
async function openShared(code) {
  S.view = 'shared';
  document.body.classList.add('shared');
  try {
    const o = await unpackShare(code);
    const d = normalize({ navn: o.navn, type: o.type, avdelinger: o.avdelinger, punkter: o.punkter });
    const key = 'lister.delt.' + code.slice(-24);
    let saved = {}; try { saved = JSON.parse(ls.get(key) || '{}'); } catch (e) { }
    (saved.extra || []).forEach(p => { if (!d.punkter.some(x => x.id === p.id)) { d.punkter.push(p); if (!d.avdelinger.includes(p.avdeling)) d.avdelinger.push(p.avdeling); } });
    d.punkter.forEach(p => { if (saved.st && saved.st[p.id]) p.status = saved.st[p.id]; });
    S.cur = { path: null, shared: true, key, fra: o.fra || '', kilde: o.kilde || '', data: d, pending: [] };
  } catch (e) {
    console.error(e);
    $('#app').innerHTML = '<div class="empty">Lenken er ødelagt eller ufullstendig. Be om å få den sendt på nytt.</div>';
    return;
  }
  render();
}

function mergeShared(d, sh) {
  sh.punkter.forEach(p => {
    const o = d.punkter.find(x => x.id === p.id);
    if (!o) {
      if (!d.avdelinger.includes(p.avdeling)) d.avdelinger.push(p.avdeling);
      const n = Object.assign({}, p, { endret_av: sh.fra || 'Delt lenke', endret: new Date().toISOString() }); delete n.lokal; d.punkter.push(n);
    } else if (p.status !== 'Nei' && o.status === 'Nei') Object.assign(o, { status: p.status, endret_av: sh.fra || 'Delt lenke', endret: new Date().toISOString() });
  });
}
async function importShared() {
  const cur = S.cur, sh = cur.data, path = cur.kilde ? `${DIR}/${cur.kilde}.json` : null;
  let orig = null;
  if (path) { try { orig = await getFile(path); } catch (e) { if (e.status !== 404) { handleErr(e); return; } } }
  if (orig) {
    const nye = sh.punkter.filter(p => !orig.data.punkter.some(x => x.id === p.id)).length;
    openSheet(`<h2 class="display">Lagre</h2><p class="note">Dette er en delt versjon av «${esc(orig.data.navn)}». ${nye} nye punkter. Avkrysninger fra ${esc(cur.fra || 'mottakeren')} tas også med.</p>
      <div class="menu"><button class="btn btn-dark" data-act="m-merge">Slå inn i «${esc(orig.data.navn)}»</button>
      <button class="btn" data-act="m-importnew">Lagre som ny liste</button><button class="btn" data-act="close" style="justify-content:center">Avbryt</button></div>`);
  } else importNew();
}
async function importNew() {
  const cur = S.cur; closeSheet();
  try {
    const navnStr = cur.data.navn + (cur.fra && cur.fra !== navn() ? ` (fra ${cur.fra})` : '');
    const path = await createList(navnStr, cur.data.type, null);
    const d = S.lists[path].data;
    d.avdelinger = cur.data.avdelinger.slice();
    d.punkter = cur.data.punkter.map(p => { const n = Object.assign({}, p); delete n.lokal; return n; });
    S.lists[path].sha = await putFile(path, d, S.lists[path].sha, `${navn()}: importerte delt liste «${navnStr}»`);
    leaveShared(path);
  } catch (e) { handleErr(e); toast('Kunne ikke lagre'); }
}
async function mergeInto() {
  const cur = S.cur, path = `${DIR}/${cur.kilde}.json`; closeSheet();
  for (let i = 0; i < 3; i++) {
    try {
      const g = await getFile(path);
      mergeShared(g.data, Object.assign({}, cur.data, { fra: cur.fra }));
      g.data.oppdatert = new Date().toISOString(); g.data.oppdatert_av = navn();
      const sha = await putFile(path, g.data, g.sha, `${navn()}: slo inn endringer fra ${cur.fra || 'delt lenke'}`);
      S.lists[path] = { sha, data: g.data };
      toast('Slått sammen ✓'); leaveShared(path); return;
    } catch (e) { if (e.status !== 409) { handleErr(e); toast('Kunne ikke slå sammen'); return; } }
  }
  toast('Kunne ikke slå sammen – prøv igjen');
}
function leaveShared(path) { document.body.classList.remove('shared'); history.replaceState(null, '', location.pathname); go('list', path); }

/* ---------- live-deling via Worker ---------- */
function liveUrl(id, kode) { return location.origin + location.pathname + `#d/${id}/${kode}`; }
function newKode() { const a = new Uint8Array(18); crypto.getRandomValues(a); return b64urlE(a); }
async function waitSaved() { for (let i = 0; i < 40 && (S.saving || (S.cur && S.cur.pending.length)); i++) { if (!S.saving) flush(); await new Promise(r => setTimeout(r, 250)); } }
async function shareLive() {
  const cur = S.cur; closeSheet();
  if (!cur.data.del_kode) { const k = newKode(); mutate('delte lista live', d => { if (!d.del_kode) d.del_kode = k; }); }
  await waitSaved();
  if (cur.pending.length || !cur.data.del_kode) { toast('Fikk ikke lagret – prøv igjen'); return; }
  const id = cur.path.replace(DIR + '/', '').replace(/\.json$/, '');
  const url = liveUrl(id, cur.data.del_kode);
  if (navigator.share) { try { await navigator.share({ title: cur.data.navn, text: cur.data.navn, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(url); toast('Live-lenke kopiert'); }
  catch (e) { openSheet(`<h2 class="display">Live-lenke</h2><textarea rows="5" readonly>${esc(url)}</textarea><div class="actions"><button class="btn" data-act="close">Lukk</button></div>`); }
}
function askGuestName(first) {
  openSheet(`<h2 class="display">${first ? 'Hei!' : 'Navnet ditt'}</h2><form data-form="guestname">
    <div class="field"><label for="g-navn">Hva heter du? Det vises når du endrer noe.</label><input id="g-navn" type="text" name="navn" value="${esc(ls.get('lister.mittNavn'))}" required autofocus></div>
    <div class="actions"><button class="btn btn-dark" type="submit">OK</button>${first ? '<button class="btn" type="button" data-act="close">Hopp over</button>' : ''}</div></form>`);
}
function openLive(id, kode) {
  LIVE = { id, kode };
  document.body.classList.add('shared');
  S.view = 'list';
  S.cur = { path: `${DIR}/${id}.json`, sha: null, etag: null, data: null, pending: [] };
  render(); refreshList();
  if (!ls.get('lister.mittNavn')) askGuestName(true);
}

/* ---------- start ---------- */
function start() {
  if (location.hash.startsWith('#del=')) { openShared(location.hash.slice(5)); return; }
  const lm = location.hash.match(/^#d\/([a-z0-9-]+)\/([A-Za-z0-9_-]{16,})$/);
  if (lm) { openLive(lm[1], lm[2]); return; }
  LIVE = null;
  if (!token()) { go('setup'); return; }
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (h) go('list', `${DIR}/${h}.json`); else go('home');
}
window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#del=')) { closeSheet(); openShared(location.hash.slice(5)); return; }
  document.body.classList.remove('shared');
  closeSheet(); start();
});
start();

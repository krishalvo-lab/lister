/* Lister – statisk app på GitHub Pages, data som JSON i et privat GitHub-repo.
   Hver liste = én fil: lister/<id>.json i datarepoet. Se CLAUDE.md i datarepoet for formatet. */
'use strict';

const API = 'https://api.github.com';
const LS = { token: 'lister.token', repo: 'lister.repo', navn: 'lister.navn', skjul: 'lister.skjulFerdige' };
const DEFAULT_REPO = 'krishalvo-lab/lister-data';
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

async function getFile(path, etag) {
  const r = await gh(`/repos/${repo()}/contents/${encPath(path)}`, etag ? { headers: { 'If-None-Match': etag } } : {});
  if (r.status === 304) return { notModified: true };
  if (!r.ok) throw new HttpError(r.status);
  const j = await r.json();
  return { sha: j.sha, etag: r.headers.get('ETag'), data: normalize(JSON.parse(b64d(j.content))) };
}
async function putFile(path, data, sha, message) {
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
    if (location.hash !== h) history.replaceState(null, '', h);
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
      if (!cur.data) render();
    }
  }
  if (S.view === 'list' && S.cur === cur) S.pollTimer = setTimeout(refreshList, POLL_LIST_MS);
}

/* ---------- mutations (op-basert, tåler samtidige endringer) ---------- */
function mutate(desc, fn) {
  const cur = S.cur; if (!cur || !cur.data) return;
  fn(cur.data);
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
      cur.data.oppdatert_av = navn();
      const d = ops.map(o => o.desc);
      const msg = `${navn()}: ${d.slice(0, 3).join(', ')}${d.length > 3 ? ` (+${d.length - 3})` : ''}`;
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
function opAdd(item) { return d => { if (findP(d, item.id)) return; ensureAvd(d, item.avdeling); d.punkter.push(Object.assign({}, item)); }; }
function opSet(id, fields) { return d => { const p = findP(d, id); if (!p) return; Object.assign(p, fields); ensureAvd(d, p.avdeling); }; }
function opDel(id) { return d => { d.punkter = d.punkter.filter(p => p.id !== id); }; }

/* ---------- rendering ---------- */
function render() {
  const app = $('#app');
  if (S.view === 'setup') app.innerHTML = viewSetup();
  else if (S.view === 'home') app.innerHTML = viewHome();
  else if (S.view === 'list') app.innerHTML = viewList();
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
        <p>${esc(typeOf(e.d).label)}${e.d.oppdatert ? ' · ' + esc(when(e.d.oppdatert)) + (e.d.oppdatert_av ? ' av ' + esc(e.d.oppdatert_av) : '') : ''}</p>
        <div class="bar"><i style="width:${pct}%"></i></div></div>
      <div class="prog"><b>${c.Ja}/${c.tot}</b><small>${c.Usikker ? c.Usikker + ' usikker' : 'ferdig'}</small></div></button>`;
  };
  let html = `<div class="home-head"><div><p class="eyebrow">${esc(navn())}</p><h1 class="display">Lister</h1></div>
    <button class="btn btn-yellow" data-act="new">+ Ny liste</button></div>`;
  if (!entries.length) {
    html += `<div class="empty">Ingen lister ennå.<br>Trykk <b>+ Ny liste</b>, eller be Claude lage en.</div>`;
  } else {
    Object.keys(TYPES).forEach(t => {
      const g = active.filter(e => e.d.type === t).sort(sortFn);
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

  let html = `<div class="l-head"><div class="t"><p class="eyebrow">${esc(T.label)}</p><h1 class="display">${esc(d.navn)}</h1></div>
    <button class="icon-btn" data-act="listmenu" aria-label="Flere valg"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button></div>
  <form class="quick" data-form="quick">
    <input type="text" name="tekst" placeholder="Legg til ${esc(T.tekst.toLowerCase())}…" autocomplete="off" enterkeyhint="done" aria-label="Ny ${esc(T.tekst.toLowerCase())}">
    <select name="avdeling" aria-label="${esc(T.gruppe)}">${order.map(a => `<option${a === defAvd ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select>
    <button class="btn btn-dark" type="submit" aria-label="Legg til" style="padding:0 16px">+</button>
  </form>
  <div class="tools"><label><input type="checkbox" data-act="skjul"${skjul ? ' checked' : ''}> Skjul det som er ${T === TYPES.handleliste ? 'kjøpt' : 'ferdig'}</label>
    <button class="link" data-act="additem">Legg til med detaljer</button></div>`;

  let shown = 0;
  order.forEach(avd => {
    const items = d.punkter.filter(p => p.avdeling === avd);
    if (!items.length) return;
    const vis = skjul ? items.filter(p => p.status !== 'Ja') : items;
    const ferdig = items.filter(p => p.status === 'Ja').length;
    if (!vis.length) return;
    shown += vis.length;
    html += `<section class="dept"><div class="dept-h">${esc(avd)}<span>${ferdig}/${items.length}</span></div><div class="items">${vis.map(p => itemRow(p, T)).join('')}</div></section>`;
  });
  if (!d.punkter.length) html += `<div class="empty" style="margin-top:20px">Tom liste. Skriv i feltet over for å legge til.</div>`;
  else if (!shown) html += `<div class="empty" style="margin-top:20px">Alt er ${T === TYPES.handleliste ? 'kjøpt' : 'ferdig'} 👌</div>`;

  html += `<section class="sum"><h2 class="display">Oppsummering</h2><dl>
    <dt>Antall ${T === TYPES.handleliste ? 'varer' : 'punkter'} totalt</dt><dd>${c.tot}</dd>
    <dt><span class="pill" style="background:var(--ja)"></span>Ferdig</dt><dd>${c.Ja}</dd>
    <dt><span class="pill" style="background:var(--nei)"></span>Mangler</dt><dd>${c.Nei}</dd>
    <dt><span class="pill" style="background:var(--usikker)"></span>Usikker${T === TYPES.handleliste ? ' (sjekk hjemme)' : ''}</dt><dd>${c.Usikker}</dd>
  </dl>${d.oppdatert ? `<p class="eyebrow" style="margin-top:14px;letter-spacing:.08em;text-transform:none">Sist endret ${esc(when(d.oppdatert))}${d.oppdatert_av ? ' av ' + esc(d.oppdatert_av) : ''}</p>` : ''}</section>`;
  return html;
}

function itemRow(p, T) {
  const meta = [];
  if (p.brukes_i) meta.push('<b>' + esc(p.brukes_i) + '</b>');
  if (T.butikk && p.butikk) meta.push(esc(p.butikk));
  if (p.merknad) meta.push(esc(p.merknad));
  return `<div class="item s-${esc(p.status)}">
    <button class="st" data-act="cycle" data-id="${esc(p.id)}" aria-label="${esc(T.status)}: ${esc(p.status)}. Trykk for å endre">${esc(p.status)}<small>${esc(T.status.toUpperCase())}</small></button>
    <button class="i-main" data-act="edit" data-id="${esc(p.id)}">
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
    ${prefill && prefill.copyOf ? `<input type="hidden" name="copyOf" value="${esc(prefill.copyOf)}"><p class="note">Alle punkter kopieres og settes til «Nei».</p>` : ''}
    <div class="actions"><button class="btn btn-dark" type="submit">Opprett</button><button class="btn" type="button" data-act="close">Avbryt</button></div>
  </form>`);
}

function sheetListMenu() {
  const d = S.cur.data;
  openSheet(`<h2 class="display">${esc(d.navn)}</h2><div class="menu">
    <button class="btn" data-act="m-rename">Gi nytt navn</button>
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
async function createList(navnStr, type, copyOf) {
  const base = slug(navnStr);
  let id = base, n = 2;
  const exists = async p => { if (S.lists[p]) return true; try { await getFile(p); return true; } catch (e) { if (e.status === 404) return false; throw e; } };
  while (await exists(`${DIR}/${id}.json`)) id = `${base}-${n++}`;
  const path = `${DIR}/${id}.json`;
  const src = copyOf && S.lists[copyOf] ? S.lists[copyOf].data : null;
  const data = normalize({
    navn: navnStr, type, opprettet: today(), arkivert: false,
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
    case 'home': if (token()) go('home'); break;
    case 'settings': go('setup'); break;
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
    case 'm-text': {
      const txt = listAsText(S.cur.data); closeSheet();
      try { await navigator.clipboard.writeText(txt); toast('Kopiert – lim inn i SMS'); }
      catch (err) { openSheet(`<h2 class="display">Kopier</h2><textarea rows="12" readonly>${esc(txt)}</textarea><div class="actions"><button class="btn" data-act="close">Lukk</button></div>`); }
      break;
    }
    case 'm-reset': closeSheet(); mutate('alt tilbake til Nei', d => d.punkter.forEach(p => { p.status = 'Nei'; })); break;
    case 'm-cleardone': closeSheet(); mutate('fjernet alt som var Ja', d => { d.punkter = d.punkter.filter(p => p.status !== 'Ja'); }); break;
    case 'm-copy': sheetNewList({ navn: S.cur.data.navn + ' (kopi)', type: S.cur.data.type, copyOf: S.cur.path }); break;
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
      const btn = f.querySelector('[type=submit]'); btn.disabled = true; btn.textContent = 'Oppretter…';
      try { const path = await createList(v.navn, v.status, v.copyOf); closeSheet(); go('list', path); }
      catch (err) { handleErr(err); btn.disabled = false; btn.textContent = 'Opprett'; toast('Kunne ikke opprette lista'); }
      break;
    }
    case 'rename': closeSheet(); mutate(`nytt navn ${v.navn}`, d => { d.navn = v.navn; }); break;
  }
});

/* ---------- start ---------- */
function start() {
  if (!token()) { go('setup'); return; }
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (h) go('list', `${DIR}/${h}.json`); else go('home');
}
start();

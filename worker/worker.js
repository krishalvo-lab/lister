// Lister – delings-Worker (Cloudflare Workers)
// Holder GitHub-nøkkelen hemmelig og slipper bare gjennom én liste per lenke.
// Lenke: https://krishalvo-lab.github.io/lister/#d/<id>/<kode>
// Lista må ha "del_kode": "<kode>" i lister/<id>.json. Fjernes koden, slutter lenken å virke.
//
// Oppsett i Cloudflare: lim inn denne fila som Worker-kode, og legg inn
// secret GITHUB_TOKEN (fine-grained, kun lister-data, Contents: Read and write).

const REPO = 'krishalvo-lab/lister-data';
const DIR = 'lister';
const MAX_BYTES = 300_000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
  'Access-Control-Max-Age': '86400'
};
const json = (status, obj, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json', ...extra } });

function b64e(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64d(b) {
  const bin = atob(b.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}
function sameCode(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length < 16) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'lister-del-worker',
      ...(init.headers || {})
    }
  });
}

async function readList(env, id) {
  const r = await gh(env, `${DIR}/${id}.json`);
  if (!r.ok) return { error: r.status };
  const j = await r.json();
  return { sha: j.sha, etag: r.headers.get('ETag'), data: JSON.parse(b64d(j.content)) };
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/liste\/([a-z0-9]+(?:-[a-z0-9]+)*)$/);
    if (!m || m[1].length > 60) return json(404, { feil: 'ukjent' });
    const id = m[1];
    if (!env.GITHUB_TOKEN) return json(500, { feil: 'GITHUB_TOKEN mangler i Worker-innstillingene' });

    if (req.method === 'GET') {
      const k = url.searchParams.get('k') || '';
      // Henter alltid fersk fil, så en stoppet deling slutter å virke med en gang.
      const inm = req.headers.get('If-None-Match');
      const res = await readList(env, id);
      if (res.error) return json(res.error === 404 ? 404 : 502, { feil: 'fant ikke lista' });
      if (!sameCode(res.data.del_kode, k)) return json(403, { feil: 'deling stoppet' });
      if (inm && res.etag === inm) return new Response(null, { status: 304, headers: { ...CORS, ETag: inm } });
      const data = { ...res.data };
      delete data.del_kode;
      return json(200, { sha: res.sha, data }, res.etag ? { ETag: res.etag } : {});
    }

    if (req.method === 'PUT') {
      const raw = await req.text();
      if (raw.length > MAX_BYTES) return json(413, { feil: 'for stor' });
      let body;
      try { body = JSON.parse(raw); } catch { return json(400, { feil: 'ugyldig JSON' }); }
      const { k, sha, data, message } = body || {};
      if (!data || typeof data !== 'object' || !Array.isArray(data.punkter) || typeof sha !== 'string') return json(400, { feil: 'mangler data' });
      const cur = await readList(env, id);
      if (cur.error) return json(cur.error === 404 ? 404 : 502, { feil: 'fant ikke lista' });
      if (!sameCode(cur.data.del_kode, k)) return json(403, { feil: 'deling stoppet' });
      if (cur.sha !== sha) return json(409, { feil: 'konflikt' });
      // Mottakeren kan ikke endre eller fjerne delingen, type eller arkivstatus.
      const out = { ...data, del_kode: cur.data.del_kode, type: cur.data.type, arkivert: cur.data.arkivert };
      const msg = String(message || 'Delt lenke: endring').slice(0, 200);
      const r = await gh(env, `${DIR}/${id}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, sha, content: b64e(JSON.stringify(out, null, 2) + '\n') })
      });
      if (r.status === 409 || r.status === 422) return json(409, { feil: 'konflikt' });
      if (!r.ok) return json(502, { feil: 'GitHub svarte ' + r.status });
      const j = await r.json();
      return json(200, { sha: j.content.sha });
    }
    return json(405, { feil: 'metode' });
  }
};

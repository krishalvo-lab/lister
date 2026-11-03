import { createRequire } from 'module'; const require=createRequire(import.meta.url);
const { chromium, devices } = require('playwright'); const crypto=require('crypto');
const store={}; let ghPuts=[];
const sha=s=>crypto.createHash('sha1').update(s+Math.random()).digest('hex');
const seed=(p,o)=>{const c=JSON.stringify(o,null,2)+'\n';store[p]={content:c,sha:sha(c)};};
seed('lister/test-deling.json',{navn:'Test – deling',type:'handleliste',opprettet:'2026-11-03',avdelinger:['Frukt og grønt','Meieri og egg','Annet'],
 punkter:[{id:'b1',tekst:'Bananer',mengde:'',avdeling:'Frukt og grønt',brukes_i:'',merknad:'',butikk:'',status:'Nei'},{id:'m1',tekst:'Melk',mengde:'',avdeling:'Meieri og egg',brukes_i:'',merknad:'',butikk:'',status:'Nei'}]});
// fake GitHub for both browser (owner) and worker (node)
function ghHandle(method,path,headers,body){
  const p=decodeURIComponent(path.replace('/repos/krishalvo-lab/lister-data/contents/',''));
  if(path==='/repos/krishalvo-lab/lister-data') return {status:200,body:{}};
  if(method==='GET'){ if(p==='lister') return {status:200,body:Object.entries(store).map(([k,v])=>({type:'file',name:k.split('/')[1],path:k,sha:v.sha}))};
    const f=store[p]; if(!f) return {status:404,body:{}}; return {status:200,etag:'"'+f.sha+'"',body:{sha:f.sha,content:Buffer.from(f.content).toString('base64')}};}
  if(method==='PUT'){const b=JSON.parse(body);const f=store[p]; if((f&&b.sha!==f.sha)||(!f&&b.sha)) return {status:409,body:{}};
    const c=Buffer.from(b.content,'base64').toString('utf8'); store[p]={content:c,sha:sha(c)}; ghPuts.push(b.message); return {status:200,body:{content:{sha:store[p].sha}}};}
  if(method==='DELETE'){delete store[p];return {status:200,body:{}};}
}
const realFetch=globalThis.fetch;
globalThis.fetch=async(url,init={})=>{const u=new URL(url); if(u.host!=='api.github.com') return realFetch(url,init);
  const r=ghHandle(init.method||'GET',u.pathname,init.headers||{},init.body); const h={'content-type':'application/json'}; if(r.etag) h.etag=r.etag;
  return new Response(JSON.stringify(r.body),{status:r.status,headers:h});};
const worker=(await import(new URL('../worker/worker.js', import.meta.url).href)).default;
const env={GITHUB_TOKEN:'secret-worker'};
const C={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'GET,PUT,DELETE','access-control-expose-headers':'ETag'};
async function ghRoute(route){const q=route.request(); if(q.method()==='OPTIONS') return route.fulfill({status:204,headers:C});
  if(q.headers()['authorization']!=='Bearer good') return route.fulfill({status:401,headers:C,body:'{}'});
  const u=new URL(q.url()); const r=ghHandle(q.method(),u.pathname,q.headers(),q.postData()); const h={...C,'content-type':'application/json'}; if(r.etag) h.etag=r.etag;
  route.fulfill({status:r.status,headers:h,body:JSON.stringify(r.body)});}
async function wRoute(route){const q=route.request(); const req=new Request(q.url(),{method:q.method(),headers:q.headers(),body:['GET','HEAD','OPTIONS'].includes(q.method())?undefined:q.postData()});
  const res=await worker.fetch(req,env); const headers={}; res.headers.forEach((v,k)=>headers[k]=v); route.fulfill({status:res.status,headers,body:Buffer.from(await res.arrayBuffer())});}
const b=await chromium.launch(); const errs=[];
async function mk(withToken){const ctx=await b.newContext({...devices['iPhone 13']}); await ctx.addInitScript(()=>{window.LISTER_WORKER='https://worker.test';});
  await ctx.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''})); await ctx.route('https://api.github.com/**',withToken?ghRoute:(r=>{errs.push('guest hit github');r.abort();}));
  await ctx.route('https://worker.test/**',wRoute);
  const p=await ctx.newPage(); p.on('pageerror',e=>errs.push(e.message));
  await p.addInitScript(()=>{navigator.share=undefined;}); return p;}
const own=await mk(true);
await own.goto('http://localhost:8765/'); await own.fill('#f-navn','Kristian'); await own.fill('#f-token','good'); await own.click('button[type=submit]');
await own.waitForSelector('.card'); await own.click('.card'); await own.waitForSelector('.item');
await own.evaluate(()=>{navigator.clipboard.writeText=async t=>{window.__c=t;};});
await own.click('[data-act=listmenu]'); await own.click('[data-act=m-live]'); await own.waitForFunction(()=>window.__c,null,{timeout:15000});
const live=await own.evaluate(()=>window.__c); console.log('live url:',live);
console.log('del_kode in file:', !!JSON.parse(store['lister/test-deling.json'].content).del_kode);
const g=await mk(false);
await g.goto(live.replace(/^https?:\/\/[^/]+\/lister\//,'http://localhost:8765/'));
await g.waitForSelector('#g-navn'); await g.fill('#g-navn','Mamma'); await g.click('form[data-form=guestname] button[type=submit]');
await g.waitForSelector('.item');
await g.click('.item:has-text("Melk") .st');
await g.fill('form[data-form=quick] input[name=tekst]','Smør'); await g.selectOption('form[data-form=quick] select','Meieri og egg'); await g.press('form[data-form=quick] input[name=tekst]','Enter');
await g.waitForTimeout(2000); console.log('who:', JSON.parse(store['lister/test-deling.json'].content).punkter.map(p=>p.tekst+'/'+(p.endret_av||'-')).join(', ')); await own.waitForTimeout(13000); console.log('owner meta:', await own.$$eval('.i-meta .who', e=>e.map(x=>x.textContent).join(' | ')));
let d=JSON.parse(store['lister/test-deling.json'].content);
console.log('file after guest:',d.punkter.map(p=>p.tekst+':'+p.status).join(', '),'| del_kode kept:',!!d.del_kode,'| last msg:',ghPuts.at(-1));
// owner sees it via polling
await own.waitForFunction(()=>[...document.querySelectorAll('.i-name')].some(e=>e.textContent==='Smør'),null,{timeout:20000});
console.log('owner sees Smør via polling ✓');
// owner ticks Bananer -> guest sees
await own.click('.item:has-text("Bananer") .st'); 
await g.waitForFunction(()=>document.querySelector('.item.s-Ja .i-name')&&[...document.querySelectorAll('.item.s-Ja .i-name')].some(e=>e.textContent==='Bananer'),null,{timeout:25000});
console.log('guest sees Bananer=Ja ✓');
await g.screenshot({path:'tests/out-7-live.png'});
// wrong code
const g2=await mk(false); await g2.goto(live.replace(/^https?:\/\/[^/]+\/lister\//,'http://localhost:8765/').replace(/.{4}$/,'AAAA')); await g2.waitForTimeout(2500);
console.log('wrong code:', (await g2.textContent('#app')).trim().slice(0,40));
// stop sharing
await own.click('[data-act=listmenu]'); await own.click('[data-act=m-stopshare]'); await own.click('[data-act=m-stopshare-yes]'); await own.waitForTimeout(2000);
await g.waitForFunction(()=>document.body.innerText.includes('Delingen er stoppet'),null,{timeout:25000});
console.log('guest locked out after stop ✓; del_kode in file:', !!JSON.parse(store['lister/test-deling.json'].content).del_kode);
// try forged PUT to another file
seed('lister/hemmelig.json',{navn:'Hemmelig',type:'huskeliste',avdelinger:['Generelt'],punkter:[]});
const r=await worker.fetch(new Request('https://worker.test/liste/hemmelig?k=xxxxxxxxxxxxxxxxxxxx'),env); console.log('other list w/o code:',r.status);
console.log('errors',JSON.stringify(errs.filter(e=>!/Failed to load resource/.test(e))));
await b.close();

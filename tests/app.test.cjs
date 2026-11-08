const { chromium, devices } = require('playwright');
const crypto=require('crypto');
const store={}; let putCount=0;
const sha=s=>crypto.createHash('sha1').update(s).digest('hex');
function seed(path,obj){const c=JSON.stringify(obj,null,2)+'\n';store[path]={content:c,sha:sha(c)};}
seed('lister/fajitas.json',{navn:'Fajitas',type:'handleliste',opprettet:'2026-11-03',avdelinger:['Frukt og grønt','Kjøtt og fisk','Annet'],
 punkter:[{id:'a1',tekst:'Paprika',mengde:'3 stk',avdeling:'Frukt og grønt',brukes_i:'Fajitas',merknad:'',butikk:'Rema',status:'Nei'},
          {id:'a2',tekst:'Kyllingfilet',mengde:'?',avdeling:'Kjøtt og fisk',brukes_i:'Fajitas',merknad:'Sjekk',butikk:'',status:'Usikker'}]});
async function handler(route){
  const req=route.request(); const u=new URL(req.url()); const m=req.method();
  const C={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'GET,PUT,DELETE','access-control-expose-headers':'ETag'};
  if(m==='OPTIONS') return route.fulfill({status:204,headers:C});
  if(req.headers()['authorization']!=='Bearer good') return route.fulfill({status:401,headers:C,body:'{}'});
  if(u.pathname==='/repos/krishalvo-lab/lister-data') return route.fulfill({status:200,headers:{...C,'content-type':'application/json'},body:'{}'});
  let p=decodeURIComponent(u.pathname.replace('/repos/krishalvo-lab/lister-data/contents/',''));
  const H={...C,'content-type':'application/json'};
  if(m==='GET'){
    if(p==='lister'){const arr=Object.entries(store).map(([k,v])=>({type:'file',name:k.split('/')[1],path:k,sha:v.sha}));return route.fulfill({status:200,headers:H,body:JSON.stringify(arr)});}
    const f=store[p]; if(!f) return route.fulfill({status:404,headers:H,body:'{}'});
    return route.fulfill({status:200,headers:{...H,etag:'"'+f.sha+'"'},body:JSON.stringify({sha:f.sha,content:Buffer.from(f.content).toString('base64')})});
  }
  if(m==='PUT'){ const b=JSON.parse(req.postData()); const f=store[p];
    if(f && b.sha!==f.sha) return route.fulfill({status:409,headers:H,body:'{}'});
    if(!f && b.sha) return route.fulfill({status:409,headers:H,body:'{}'});
    const c=Buffer.from(b.content,'base64').toString('utf8'); store[p]={content:c,sha:sha(c+Math.random())}; putCount++; global.lastMsg=b.message;
    return route.fulfill({status:200,headers:H,body:JSON.stringify({content:{sha:store[p].sha}})});}
  if(m==='DELETE'){delete store[p];return route.fulfill({status:200,headers:H,body:'{}'});}
  route.fulfill({status:500});
}
(async()=>{
  const b=await chromium.launch(); const ctx=await b.newContext({...devices['iPhone 13']});
  await ctx.route('https://api.github.com/**',handler);
  await ctx.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
  const pg=await ctx.newPage(); const errs=[]; pg.on('pageerror',e=>errs.push(e.message)); pg.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
  await pg.goto('http://localhost:8765/');
  await pg.screenshot({path:require('path').join(__dirname,'out-1-setup.png')});
  await pg.fill('#f-navn','Kristian'); await pg.fill('#f-token','good'); await pg.click('button[type=submit]');
  await pg.waitForSelector('.card'); await pg.screenshot({path:require('path').join(__dirname,'out-2-home.png')});
  await pg.click('.card'); await pg.waitForSelector('.item');
  // quick add
  await pg.fill('form[data-form=quick] input[name=tekst]','Rømme'); await pg.selectOption('form[data-form=quick] select','Annet'); await pg.press('form[data-form=quick] input[name=tekst]','Enter');
  await pg.click('.item:has-text("Paprika") .st'); // Nei->Ja
  await pg.waitForTimeout(1500);
  let d=JSON.parse(store['lister/fajitas.json'].content);
  console.log('after save:',d.punkter.map(p=>p.tekst+':'+p.status).join(', '),'| msg:',global.lastMsg);
  // simulate Iris editing externally -> conflict
  d.punkter.push({id:'z9',tekst:'Tortilla',mengde:'8',avdeling:'Annet',status:'Nei'}); seed('lister/fajitas.json',d);
  await pg.click('.item:has-text("Kyllingfilet") .st'); // Usikker->Nei
  await pg.waitForTimeout(1500);
  d=JSON.parse(store['lister/fajitas.json'].content);
  console.log('after conflict merge:',d.punkter.map(p=>p.tekst+':'+p.status).join(', '));
  const shown=await pg.$$eval('.i-name',e=>e.map(x=>x.textContent)); console.log('shown:',shown.join(', '));
  // edit sheet
  await pg.click('.item:has-text("Rømme") .i-main'); await pg.fill('#i-mengde','2 bokser'); await pg.fill('#i-butikk','Kiwi'); 
  await pg.screenshot({path:require('path').join(__dirname,'out-3-edit.png')}); await pg.click('form[data-form=item] button[type=submit]');
  await pg.waitForTimeout(1200); await pg.screenshot({path:require('path').join(__dirname,'out-4-list.png'),fullPage:true});

  // --- share flow ---
  await pg.click('[data-act=listmenu]'); 
  await pg.evaluate(()=>{ navigator.share=undefined; navigator.clipboard.writeText=async(t)=>{window.__copied=t;}; });
  await pg.click('[data-act=m-share]'); await pg.waitForTimeout(500);
  const url=await pg.evaluate(()=>window.__copied); console.log('share url len',url.length);
  const ctx2=await b.newContext({...devices['iPhone 13']}); await ctx2.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
  let apiHits=0; await ctx2.route('https://api.github.com/**',r=>{apiHits++;r.abort();});
  const p2=await ctx2.newPage(); p2.on('pageerror',e=>errs.push('p2 '+e.message));
  await p2.goto(url); await p2.waitForSelector('.item');
  await p2.click('.item:has-text("Kyllingfilet") .st');
  await p2.fill('form[data-form=quick] input[name=tekst]','Lime'); await p2.selectOption('form[data-form=quick] select','Frukt og grønt'); await p2.press('form[data-form=quick] input[name=tekst]','Enter');
  await p2.reload(); await p2.waitForSelector('.item');
  console.log('recipient after reload:', (await p2.$$eval('.item',e=>e.map(x=>x.querySelector('.i-name').textContent+':'+x.querySelector('.st').childNodes[0].textContent))).join(', '));
  await p2.screenshot({path:require('path').join(__dirname,'out-6-shared.png'),fullPage:true});
  await p2.evaluate(()=>{ navigator.share=undefined; navigator.clipboard.writeText=async(t)=>{window.__copied=t;}; });
  await p2.click('[data-act=m-sendback]'); await p2.fill('#sb-navn','Mamma'); await p2.click('form[data-form=sendback] button[type=submit]'); await p2.waitForTimeout(500);
  const back=await p2.evaluate(()=>window.__copied); console.log('api hits from recipient',apiHits);
  // owner opens returned link
  await pg.goto(back); await pg.waitForSelector('[data-act=m-import]');
  await pg.click('[data-act=m-import]'); await pg.waitForSelector('[data-act=m-merge]'); console.log('merge sheet:', (await pg.textContent('.panel .note')));
  await pg.click('[data-act=m-merge]'); await pg.waitForTimeout(1500);
  d=JSON.parse(store['lister/fajitas.json'].content);
  console.log('after merge:',d.punkter.map(p=>p.tekst+':'+p.status+(p.merknad?'('+p.merknad+')':'')).join(', '), '| msg', global.lastMsg, '| url', pg.url());
  // new huskeliste
  await pg.click('[data-act=home]'); await pg.waitForSelector('.card'); await pg.click('text=+ Ny liste');
  await pg.fill('#n-navn','Hytta – før vinter'); await pg.click('.seg button:has-text("Huskeliste")'); await pg.click('.seg5 button:has-text("Hjem")'); await pg.click('form[data-form=newlist] button[type=submit]');
  await pg.waitForSelector('form[data-form=quick]'); await pg.fill('form[data-form=quick] input[name=tekst]','Tappe ut vann'); await pg.press('form[data-form=quick] input[name=tekst]','Enter');
  await pg.waitForTimeout(1200);
  console.log('files:',Object.keys(store).join(', '));
  // ønskeliste
  await pg.click('[data-act=home]'); await pg.waitForSelector('.card'); await pg.click('text=+ Ny liste');
  await pg.fill('#n-navn','Kristian – jul'); await pg.click('.seg button:has-text("Ønskeliste")'); await pg.click('.seg5 button:has-text("Annet")'); await pg.click('form[data-form=newlist] button[type=submit]');
  await pg.waitForSelector('form[data-form=quick]');
  console.log('ønske grupper:', await pg.$$eval('form[data-form=quick] option',o=>o.map(x=>x.textContent+(x.selected?'*':'')).join(', ')));
  await pg.click('[data-act=additem]'); await pg.fill('#i-tekst','Løpejakke'); await pg.fill('#i-merknad','str L, svart https://www.xxl.no/jakke-123');
  console.log('ønske-skjema: brukes_i synlig =', await pg.isVisible('#i-brukes'), '| mengde-label =', await pg.textContent('label[for=i-mengde]'));
  await pg.click('form[data-form=item] button[type=submit]'); await pg.waitForSelector('.i-link');
  console.log('lenke:', await pg.getAttribute('.i-link','href'), '| meta:', await pg.textContent('.item .i-meta'));
  console.log('ønske-status før:', await pg.textContent('.item .st'));
  await pg.click('.item .st'); await pg.waitForTimeout(1200);
  console.log('ønske-status etter:', await pg.textContent('.item .st'), '| oppsummering:', (await pg.$$eval('.sum dt',e=>e.map(x=>x.textContent.trim()))).join(', '));
  await pg.click('.item .st'); await pg.waitForTimeout(300); console.log('ønske-status tredje trykk:', await pg.textContent('.item .st'));
  await pg.click('.item .st'); await pg.waitForTimeout(1200);
  const w=JSON.parse(store['lister/kristian-jul.json'].content); console.log('ønskefil:', w.type, w.punkter.map(p=>p.tekst+':'+p.status+':'+p.avdeling).join(', '), '| skjul-tekst:', await pg.textContent('.tools label'));
  await pg.screenshot({path:require('path').join(__dirname,'out-8-onske.png'),fullPage:true});
  await pg.click('[data-act=home]'); await pg.waitForTimeout(800); await pg.screenshot({path:require('path').join(__dirname,'out-5-home.png')});
  console.log('puts',putCount,'errors',JSON.stringify(errs));
  await b.close();
})();

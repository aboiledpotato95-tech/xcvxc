/* history.js - all past answers, sorted by class and subject, with small pictures of the files that were scanned.
   Saved on this phone (IndexedDB). Optional sync between phones through your own QuickAns cloud (Cloudflare Worker + R2). Also backs up photo/video previews. */
(function(){
const DB='qa_hist',ST='recs',KEEP_THUMBS=60;
let dbp=null;const RECENT=[];
const db=()=>dbp||(dbp=new Promise((res,rej)=>{const r=indexedDB.open(DB,1);
  r.onupgradeneeded=()=>{r.result.createObjectStore(ST,{keyPath:'id'})};
  r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)}));
const tx=async(mode,f)=>{const d=await db();return new Promise((res,rej)=>{const t=d.transaction(ST,mode),s=t.objectStore(ST),r=f(s);t.oncomplete=()=>res(r&&r.result);t.onerror=()=>rej(t.error);t.onabort=()=>rej(t.error)})};
const all=()=>tx('readonly',s=>s.getAll());
const put=r=>tx('readwrite',s=>s.put(r));
const getL=k=>{try{return load(k)||''}catch(e){return ''}};
const setL=(k,v)=>{try{save(k,v)}catch(e){}};

/* ---------- class and subject ---------- */
const SUBS=[['Mathematics',/^(math|maths|mathematics|applied math)/i],['Physics',/^phys/i],['Chemistry',/^chem/i],['Biology',/^(bio|zoology|botany)/i],
  ['Accountancy',/^(account|acc\b)/i],['Business Studies',/^(business|bst)/i],['Economics',/^econ/i],['Computer Science',/^(computer|cs\b|comp)/i],
  ['Informatics Practices',/^(informatics|ip\b)/i],['English',/^eng/i],['Hindi',/^hind/i],['History',/^hist/i],['Geography',/^geo/i],['Political Science',/^(pol|civics)/i],['Physical Education',/^(phy.*ed|pe\b)/i]];
const KW={Chemistry:/\b(mol|molar|ion|bond|reaction|acid|base|oxidation|electron|orbital|alkane|alkene|enthalpy|equilibrium|isomer|valence|ph\b)\b/gi,
  Physics:/\b(velocity|force|energy|current|voltage|resistance|wavelength|momentum|acceleration|lens|magnetic|charge|gravitation|photon)\b/gi,
  Mathematics:/\b(derivative|integral|matrix|determinant|probability|sin|cos|tan|limit|equation|sequence|vector|function)\b/gi,
  Biology:/\b(cell|enzyme|dna|rna|chromosome|photosynthesis|heart|blood|species|tissue|hormone|gene)\b/gi,
  Accountancy:/\b(journal|ledger|debit|credit|partnership|goodwill|balance sheet|depreciation|capital)\b/gi,
  Economics:/\b(demand|supply|utility|elasticity|gdp|inflation|monopoly|cost)\b/gi,
  'Business Studies':/\b(management|planning|organising|marketing|staffing|directing|controlling)\b/gi,
  'Computer Science':/\b(python|sql|algorithm|array|loop|function|class|stack|queue|network)\b/gi};
function normSub(s){s=String(s||'').trim();if(!s)return'';for(const[n,re]of SUBS)if(re.test(s))return n;return s.replace(/\b\w/g,c=>c.toUpperCase()).slice(0,30)}
function normCls(c){const m=/\b(1[0-2]|[6-9]|XII|XI|X)\b/i.exec(String(c||''));if(!m)return'';const r={xii:'12',xi:'11',x:'10'}[m[1].toLowerCase()];return r||m[1]}
function guessSub(items){const t=JSON.stringify(items||[]).slice(0,6000);let best='',bn=2;for(const k in KW){const n=(t.match(KW[k])||[]).length;if(n>bn){bn=n;best=k}}return best}

/* ---------- pictures of the scanned files ----------
   Kept big enough (long side up to 640px) to be read when opened full-size on another
   phone, not just as a small list thumbnail. This makes each saved answer a bit bigger
   to store and to sync, which is the trade-off for being able to view the photo clearly
   from any phone. */
async function thumb(f){try{const b=await createImageBitmap(f),k=Math.min(1,640/Math.max(b.width,b.height)),c=document.createElement('canvas');
  c.width=Math.max(1,Math.round(b.width*k));c.height=Math.max(1,Math.round(b.height*k));c.getContext('2d').drawImage(b,0,0,c.width,c.height);return c.toDataURL('image/jpeg',.6)}catch(e){return''}}
let idSeq=0;
const dev=()=>{let d=getL('qah_dev');if(!d){d='Phone-'+Math.random().toString(36).slice(2,5).toUpperCase();setL('qah_dev',d)}return d};

/* ---------- save ---------- */
async function saveRec(o){
  try{
    const files=[];
    for(const x of(o.files||[])){
      if(x.kind==='img'&&x.f)files.push({name:x.name||'Photo '+(files.length+1),kind:'img',thumb:await thumb(x.f)});
      else files.push({name:x.name||'File',kind:x.kind||'file',thumb:''})}
    const rec={id:Date.now().toString(36)+Math.random().toString(36).slice(2,10)+(++idSeq).toString(36),ts:Date.now(),mode:o.mode,
      cls:normCls(o.cls)||'Other',sub:normSub(o.sub)||guessSub(o.items)||'Unsorted',items:o.items||[],via:o.via||'',note:o.note||'',files,dev:dev(),syn:{}};
    await put(rec);RECENT.push(rec);if(RECENT.length>20)RECENT.shift();autoSync();return rec}
  catch(e){return null}}

// a diagram picture or figure that finishes after the answer was saved is added to the saved copy
let tt={};async function touch(x){const r=RECENT.find(z=>(z.items||[]).includes(x));if(!r)return;clearTimeout(tt[r.id]);
  tt[r.id]=setTimeout(async()=>{try{r.syn={};await put(r);autoSync()}catch(e){}},800)}

/* ---------- screen ---------- */
const h=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e};
const css=document.createElement('style');
css.textContent='.hm{width:38px;height:38px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font-size:22px;line-height:1;padding:0;margin-right:10px;vertical-align:middle}'
+'#hd,#hv{position:fixed;inset:0;z-index:60;display:none}#hd.on,#hv.on{display:block}'
+'#hd .bg,#hv .bg{position:absolute;inset:0;background:rgba(0,0,0,.6)}'
+'#hd .pn{position:absolute;top:0;bottom:0;left:0;width:min(90vw,400px);background:var(--bg);border-right:1px solid var(--line);overflow:auto;padding:14px;box-sizing:border-box}'
+'#hv .pn{position:absolute;inset:0;background:var(--bg);overflow:auto;padding:14px;box-sizing:border-box}'
+'.hr{display:flex;align-items:center;gap:8px;margin-bottom:10px}.hr h2{flex:1;margin:0;font-size:18px}'
+'.he{padding:10px;border:1px solid var(--line);border-radius:8px;margin:6px 0;cursor:pointer}.he small{color:var(--mut)}.he .ts{display:flex;gap:4px;margin-top:6px;overflow:hidden}.he .ts img{width:34px;height:34px;object-fit:cover;border-radius:4px;border:1px solid var(--line)}'
+'.hg>summary{font-weight:700;padding:8px 0}.hs>summary{padding:6px 0 6px 10px;font-weight:600;color:var(--mut)}'
+'.hf{display:flex;gap:6px;overflow:auto;margin:8px 0}.hf img{height:90px;border-radius:6px;border:1px solid var(--line)}'
+'.hsy{font:12px/1.4 system-ui,sans-serif;color:var(--mut);margin:6px 0}'
+'.ts img,.hf img{cursor:pointer}'
+'h1{display:flex;align-items:center}'
+'.sdot{width:13px;height:13px;border-radius:50%;margin-left:auto;background:#555;cursor:pointer;flex:none}'
+'.sdot.g{background:#1e9e5a}.sdot.r{background:#e5534b}'
+'#lb{position:fixed;inset:0;z-index:70;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.92)}#lb.on{display:flex}'
+'#lb img{max-width:95vw;max-height:84vh;border-radius:6px;border:1px solid var(--line)}'
+'#lb .lbc{position:absolute;top:14px;right:18px;font-size:26px;color:#fff;cursor:pointer;line-height:1}'
+'#lb .lbcap{position:absolute;bottom:18px;left:0;right:0;text-align:center;color:var(--mut);font:13px system-ui,sans-serif}';
document.head.append(css);
const drawer=h('div');drawer.id='hd';const viewer=h('div');viewer.id='hv';document.body.append(drawer,viewer);

/* ---------- full-size photo viewer (works the same for a photo saved on any of your phones) ---------- */
const lb=h('div');lb.id='lb';
const lbImg=document.createElement('img'),lbCap=h('div','lbcap'),lbClose=h('div','lbc','✕');
lbClose.onclick=()=>lb.classList.remove('on');lb.onclick=e=>{if(e.target===lb)lb.classList.remove('on')};
lb.append(lbImg,lbCap,lbClose);document.body.append(lb);
function openImg(src,cap){if(!src)return;lbImg.src=src;lbCap.textContent=cap||'';lb.classList.add('on')}

const fmt=ts=>{const d=new Date(ts);return d.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'})+' '+d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})};
const clsOrder=c=>c==='12'?0:c==='11'?1:c==='Other'?9:2;

async function openDrawer(q){
  drawer.innerHTML='';drawer.classList.add('on');
  const bg=h('div','bg');bg.onclick=()=>drawer.classList.remove('on');
  const pn=h('div','pn'),top=h('div','hr'),cl=h('button',0,'✕');cl.onclick=()=>drawer.classList.remove('on');top.append(h('h2',0,'History'),cl);
  const se=h('input');se.placeholder='Search subject, class or date';se.value=q||'';se.style.cssText='width:100%;margin:0 0 8px';
  const sy=h('div','hsy'),sb=h('button','hsb',syncBtnLabel());sb.onclick=syncDialog;
  sy.textContent=syncState();
  const list=h('div');pn.append(top,se,sb,sy,list);drawer.append(bg,pn);
  let recs=[];try{recs=(await all()).sort((a,b)=>b.ts-a.ts)}catch(e){list.append(h('div','warn','This phone would not keep history saved (storage unavailable).'));return}
  const draw=()=>{list.innerHTML='';const f=se.value.trim().toLowerCase();
    const vis=recs.filter(r=>!f||(r.cls+' '+r.sub+' '+fmt(r.ts)+' '+r.mode+' '+r.dev).toLowerCase().includes(f));
    if(!vis.length){list.append(h('div','mut',recs.length?'Nothing matches.':'Nothing saved yet. Your answers will appear here after you get them.'));return}
    const by={};vis.forEach(r=>{((by[r.cls]=by[r.cls]||{})[r.sub]=by[r.cls][r.sub]||[]).push(r)});
    Object.keys(by).sort((a,b)=>clsOrder(a)-clsOrder(b)||a.localeCompare(b)).forEach(c=>{
      const n=Object.values(by[c]).reduce((a,x)=>a+x.length,0),d=h('details','hg');d.open=!!f||Object.keys(by).length<3;
      d.append(h('summary',0,(c==='Other'?'Other / unknown class':'Class '+c)+'  ('+n+')'));
      Object.keys(by[c]).sort().forEach(s=>{const sd=h('details','hs');sd.open=!!f;sd.append(h('summary',0,s+'  ('+by[c][s].length+')'));
        by[c][s].forEach(r=>{const e=h('div','he'),nq=(r.items||[]).length;
          e.append(h('div',0,fmt(r.ts)),h('small',0,(r.mode==='online'?'Online':'Offline')+' · '+nq+' answer'+(nq===1?'':'s')+' · '+r.files.length+' file'+(r.files.length===1?'':'s')+' · '+(r.dev||'')));
          const ts=h('div','ts');r.files.filter(x=>x.thumb).slice(0,6).forEach(x=>{const im=h('img');im.src=x.thumb;
            im.onclick=ev=>{ev.stopPropagation();openImg(x.thumb,x.name+' · '+fmt(r.ts)+' · '+(r.dev||''))};ts.append(im)});if(ts.children.length)e.append(ts);
          e.onclick=()=>openRec(r.id);sd.append(e)});
        d.append(sd)});
      list.append(d)})};
  se.oninput=draw;draw()}

async function openRec(id){
  const recs=await all(),r=recs.find(x=>x.id===id);if(!r)return;
  viewer.innerHTML='';viewer.classList.add('on');
  const bg=h('div','bg'),pn=h('div','pn');viewer.append(bg,pn);
  const top=h('div','hr'),back=h('button',0,'← Back');back.onclick=()=>{viewer.classList.remove('on')};
  const title=h('h2',0,(r.cls==='Other'?'':'Class '+r.cls+' · ')+r.sub);top.append(back,title);pn.append(top,h('div','mut',fmt(r.ts)+' · '+(r.mode==='online'?'Online':'Offline')+' · '+(r.dev||'')+(r.via?' · '+r.via:'')));
  const bar=h('div','row'),cp=h('button',0,'Copy'),ed=h('button',0,'Change class / subject');
  cp.onclick=()=>{try{copyTxt(cp,plain(order(r.items)))}catch(e){}};
  ed.onclick=async()=>{const c=prompt('Class (11, 12 or leave empty):',r.cls==='Other'?'':r.cls);if(c===null)return;const s=prompt('Subject:',r.sub);if(s===null)return;
    r.cls=normCls(c)||'Other';r.sub=normSub(s)||'Unsorted';r.syn={};await put(r);openRec(id);autoSync()};
  bar.append(cp,ed);pn.append(bar);
  if(r.files.length){const fs=h('div','hf');r.files.forEach(x=>{if(x.thumb){const im=h('img');im.src=x.thumb;im.alt=x.name;
      im.onclick=()=>openImg(x.thumb,x.name+' · '+fmt(r.ts)+' · '+(r.dev||''));fs.append(im)}else fs.append(h('div','chip',x.name))});
    pn.append(h('div','mut','Files you scanned - tap a photo to view it full-size'),fs)}
  const out=h('div');out.id='hout';out.style.cssText='font-family:var(--af);font-size:var(--as);line-height:1.6;color:var(--ac);white-space:pre-wrap';pn.append(out);
  try{const its=order(r.items.map(x=>Object.assign({},x,{noGen:true})));its.forEach(x=>out.append(itemEl(x,null,r.mode==='online')));
    const g=gaps(its),w=[r.note,g.length?'No answer found for question'+(g.length>1?'s ':' ')+g.join(', ')+'. Check those photos or add them again.':''].filter(Boolean).join('\n');
    if(w)out.append(h('div','warn',w))}catch(e){out.textContent=plain(r.items)}}

/* ---------- sync between phones (your own QuickAns cloud: one Cloudflare Worker + one R2 bucket) ----------
   The build puts the cloud address and key in (secrets CLOUD_URL and CLOUD_KEY), or you can type them in on the phone.
   The phone downloads the answers it does not have and uploads every saved answer. Syncing never deletes anything on the phone. */
let syncMsg='',syncing=false;
const hk=t=>{let x=5381;for(let i=0;i<t.length;i++)x=((x*33)^t.charCodeAt(i))>>>0;return x.toString(36)};
function dests(){const c=window.QA_CLOUD||{},url=String(c.url||getL('qah_url')||'').trim().replace(/\/+$/,''),tok=String(c.key||getL('qah_key')||'').trim();
  return url&&tok?[{name:'Cloud',url,token:tok,key:hk(url)}]:[]}
const baked=()=>!!(window.QA_CLOUD&&window.QA_CLOUD.url&&window.QA_CLOUD.key);
const syncState=()=>dests().length?(syncMsg||'Sync is on.'):'Not syncing. Answers are only on this phone.';
const syncBtnLabel=()=>dests().length?'Sync now':'Sync between phones';
async function api(d,path,opt){const o=opt||{};
  // a request that hangs (bad network) is cut after 45 s - otherwise the sync flag would stay "busy" forever and nothing would ever sync again
  const ac=new AbortController(),tm=setTimeout(()=>ac.abort(),45000);let r;
  try{r=await fetch(d.url+'/api/'+path,{method:o.method||'GET',body:o.body,signal:ac.signal,headers:Object.assign({'X-Key':d.token},o.headers||{})})}
  catch(e){throw new Error(e&&e.name==='AbortError'?'timed out':String(e&&e.message||e))}finally{clearTimeout(tm)}
  if(!r.ok){let m='';try{m=(await r.json()).error}catch(e){}throw new Error(r.status+' '+(m||''))}return r}
const slim=r=>{const c=Object.assign({},r);c.files=r.files.map((f,i)=>i<KEEP_THUMBS?f:{name:f.name,kind:f.kind,thumb:''});delete c.synced;delete c.syn;return c};
const info=r=>({ts:r.ts,cls:r.cls,sub:String(r.sub||'').slice(0,30),mode:r.mode,dev:String(r.dev||'').slice(0,20),via:String(r.via||'').slice(0,20),ni:(r.items||[]).length,nf:(r.files||[]).length});
async function sync(){
  const D=dests();if(!D.length||syncing)return;syncing=true;const d=D[0];
  try{
    syncMsg='Syncing…';
    // 1. what is in the cloud
    const rids=[];let cur='';
    do{const j=await(await api(d,'h?limit=1000'+(cur?'&cursor='+encodeURIComponent(cur):''))).json();j.items.forEach(x=>rids.push(x.id));cur=j.cursor}while(cur);
    // 2. download what this phone does not have yet
    let local=await all();const have=new Set(local.map(r=>r.id));let got=0;
    for(const id of rids){if(have.has(id))continue;
      try{const r=await(await api(d,'h/'+id)).json();if(r.mode!=='online')continue;r.syn={};r.syn[d.key]=true;await put(r);have.add(id);got++}catch(e){}}
    // 3. upload what is not in the cloud yet (it only ever ADDS - nothing is deleted from the cloud or from this phone)
    // one answer that keeps failing (too large, bad data, cloud full) must not block every answer behind it -
    // each upload gets its own try/catch, and the loop always moves on to the next one.
    local=await all();let sent=0,failed=0;
    for(const r of local){if(r.mode!=='online'||(r.syn&&r.syn[d.key]))continue;
      try{
        await api(d,'h/'+r.id,{method:'PUT',body:JSON.stringify(slim(r)),headers:{'Content-Type':'application/json','X-Meta':encodeURIComponent(JSON.stringify(info(r)))}});
        r.syn=r.syn||{};r.syn[d.key]=true;await put(r);sent++
      }catch(e){failed++}}
    const tm=new Date().toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
    syncMsg='Synced '+tm+' · '+got+' new, '+sent+' sent'+(failed?', '+failed+' failed (will retry)':'');
  }catch(e){syncMsg='Sync failed: '+String(e.message||e).slice(0,120)}
  finally{syncing=false;const s=drawer.querySelector('.hsy');if(s)s.textContent=syncState();updateDot()}}
let st=0;function autoSync(){updateDot();if(!dests().length)return;clearTimeout(st);st=setTimeout(sync,1500)}

/* ---------- green/red dot: is everything you've scanned uploaded to the cloud? ---------- */
async function updateDot(){
  if(!dot)return;const D=dests();
  if(!D.length){dot.className='sdot r';dot.title='Not syncing - this phone\'s answers are not visible on your other phones. Tap to set up syncing.';return}
  if(syncing){dot.title='Syncing…';return}
  try{
    const recs=await all(),pending=recs.filter(r=>r.mode==='online'&&D.some(d=>!(r.syn&&r.syn[d.key]))).length;
    if(/^Sync failed/.test(syncMsg)){dot.className='sdot r';dot.title=syncMsg}
    else if(pending){dot.className='sdot r';dot.title=pending+' answer'+(pending===1?'':'s')+' not uploaded yet. Tap to sync now.'}
    else{dot.className='sdot g';dot.title='Everything is uploaded to the cloud.'}
  }catch(e){dot.className='sdot r';dot.title='Could not check sync status.'}}
function refreshSyncUI(){const s=drawer.querySelector('.hsy');if(s)s.textContent=syncState();const b=drawer.querySelector('.hsb');if(b)b.textContent=syncBtnLabel();updateDot()}
// tell the Android side where the cloud is (it uploads the photo and video previews)
function cloudBoot(){if(!window.Cloud)return;const D=dests();try{Cloud.setup(D.length?D[0].url:'',D.length?D[0].token:'')}catch(e){}}
async function syncDialog(){
  if(baked()){sync();return}
  if(getL('qah_url')){const a=confirm('Sync now?\n\nPress Cancel to turn sync off on this phone.');if(a){sync();return}
    if(confirm('Turn sync off on this phone? Saved answers stay here and in the cloud.')){setL('qah_url','');setL('qah_key','');syncMsg='';cloudBoot();refreshSyncUI()}return}
  const u=prompt('To see the same history on all your phones, paste your QuickAns cloud address (it looks like https://quickans-cloud.yourname.workers.dev):');
  if(!u||!u.trim())return;
  const k=prompt('Now paste your cloud key (the CLOUD_KEY you chose):');
  if(k&&k.trim()){setL('qah_url',u.trim());setL('qah_key',k.trim());syncMsg='';cloudBoot();refreshSyncUI();sync()}
  updateDot()}

/* ---------- menu button + sync status dot ---------- */
const hb=h('button','hm','☰');hb.id='hmenu';hb.setAttribute('aria-label','History');hb.onclick=()=>openDrawer();
const dot=h('div','sdot');dot.id='sdot';dot.setAttribute('aria-label','Sync status');
dot.onclick=()=>{if(!dests().length)syncDialog();else sync()};
const h1=document.querySelector('h1');if(h1){h1.prepend(hb);h1.append(dot)}
refreshSyncUI();cloudBoot();setTimeout(autoSync,3000);

window.QAH={save:saveRec,touch,open:openDrawer,sync,_all:all,_normSub:normSub,_normCls:normCls,_guess:guessSub};
})();

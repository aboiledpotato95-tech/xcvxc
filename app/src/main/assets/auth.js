/* One-time gate shown the first time the app is opened: upload the ID card, or enter a pre-ID made in Drivi,
   then set a password. After that it creates "the account" in the cloud and never asks again on this phone. */
(function(){
const LS='qa_acct_ok',SS='qa_session';
const REQ=['IDENTITY CARD','STUDENT ID'];      // the photo's text must contain all of these to be accepted
function idFp(t){const m=t.match(/STUDENT ID\s*[:\-]?\s*([0-9]{4,})/i);return m?'n'+m[1]:''}      // only the student ID number is used - it is the same on every photo of the card
function idFpOld(t){return 't'+t.replace(/\s+/g,' ').trim().slice(0,400)}      // accounts made by an older version used the card text instead
const NONUM='Could not read the student ID number. Retake the photo: front side, flat, good light.';

function h(t,c,x){const e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e}
async function sha256(s){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));return[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')}
function cloud(){const c=window.QA_CLOUD||{};const u=(c.url||localStorage.getItem('qah_url')||'').trim().replace(/\/+$/,'');const k=(c.key||localStorage.getItem('qah_key')||'').trim();return u&&k?{url:u,key:k}:null}
function fileToB64(f){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result.split(',')[1]);r.onerror=rej;r.readAsDataURL(f)})}
function ocrImg(b64){return new Promise((res,rej)=>{
  if(!(window.Android&&window.Android.ocr))return rej(new Error('Reading the ID card works in the Android app only.'));
  const id='g'+Math.random().toString(36).slice(2);const old=window.ocrDone;
  const to=setTimeout(()=>{window.ocrDone=old;res('')},25000);
  window.ocrDone=(rid,t)=>{if(rid!==id)return old&&old(rid,t);clearTimeout(to);window.ocrDone=old;res(String(t||''))};
  try{window.Android.ocr(id,b64)}catch(e){clearTimeout(to);window.ocrDone=old;rej(e)}})}
function b64ToBytes(b64){const bin=atob(b64);const a=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);return a}

const css=document.createElement('style');
css.textContent='#qg{position:fixed;inset:0;z-index:999999;background:#000;color:#eef1f5;font:15px/1.5 system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:22px;text-align:center}'+
'#qg h2{margin:0 0 6px}#qg p{color:#98a3b3;font-size:13px;margin:0 0 18px;max-width:320px}'+
'#qg .card{width:100%;max-width:320px;border:1px solid #2a2f38;border-radius:12px;padding:16px;margin-bottom:12px;background:#0c0d10}'+
'#qg button{font:inherit;font-weight:700;border:0;border-radius:8px;padding:12px;width:100%;background:#7da2ff;color:#0b1220;cursor:pointer}'+
'#qg button.sec{background:#0c0d10;color:#eef1f5;border:1px solid #2a2f38;font-weight:600}'+
'#qg input{font:inherit;width:100%;padding:10px;border:1px solid #2a2f38;border-radius:8px;background:#000;color:#eef1f5;margin-bottom:8px;box-sizing:border-box}'+
'#qg .or{color:#98a3b3;font-size:12px;margin:14px 0}#qg .err{color:#e5534b;font-size:13px;margin-top:8px;min-height:16px}#qg .hide{display:none}';
document.head.appendChild(css);
const box=h('div','');box.id='qg';
function mount(){if(document.body){if(!document.body.contains(box))document.body.appendChild(box)}else document.addEventListener('DOMContentLoaded',mount)}

function screenCloud(){
  mount();box.innerHTML='';
  box.append(h('h2',0,'Connect your cloud first'),h('p',0,'This phone needs its cloud address and key before it can be set up.'));
  const u=h('input'),k=h('input'),b=h('button',0,'Continue');u.placeholder='https://your-cloud.workers.dev';k.placeholder='Cloud key';k.type='password';
  b.onclick=()=>{if(!u.value.trim()||!k.value.trim())return;localStorage.setItem('qah_url',u.value.trim());localStorage.setItem('qah_key',k.value.trim());screenStart()};
  box.append(u,k,b)}

function screenNew(){      // nothing is set up on this cloud yet: the very first account has to be created
  mount();box.innerHTML='';
  box.append(h('h2',0,'Sign up'),h('p',0,'Upload your student ID card or enter a pre-ID to create your account.'));
  const c1=h('div','card'),bU=h('button',0,'Upload ID card'),fi=h('input');fi.type='file';fi.accept='image/*';fi.className='hide';
  const err=h('div','err');
  bU.onclick=()=>fi.click();
  fi.onchange=async()=>{const f=fi.files[0];fi.value='';if(!f)return;
    err.textContent='Checking the photo…';
    try{
      const b64=await fileToB64(f);
      const t=(await ocrImg(b64)).toUpperCase();
      if(!REQ.every(w=>t.includes(w))){err.textContent="This doesn't look like your ID card. Try a clearer photo of the front.";return}
      const fp=idFp(t);if(!fp){err.textContent=NONUM;return}
      err.textContent='';screenPassword({img:b64ToBytes(b64),viaPreId:false,idFp:fp})
    }catch(e){err.textContent=String(e.message||e)}};
  c1.append(bU,fi,err);
  const or=h('div','or','— or —');
  const c2=h('div','card'),pin=h('input'),bP=h('button','sec','Enter pre-ID'),err2=h('div','err');
  pin.placeholder='Pre-ID from Drivi';
  bP.onclick=async()=>{const code=pin.value.trim();if(!code)return;err2.textContent='Checking…';
    try{const c=cloud();const r=await fetch(c.url+'/api/preid/'+encodeURIComponent(code)+'/check',{method:'POST',headers:{'X-Key':c.key}});
      if(!r.ok){const j=await r.json().catch(()=>({}));err2.textContent=j.error||('Could not check this pre-ID ('+r.status+')');return}
      err2.textContent='';screenPassword({img:null,viaPreId:true,preId:code})
    }catch(e){err2.textContent='No connection - try again'}};
  c2.append(pin,bP,err2);
  box.append(c1,or,c2,backBtn())}

async function getAcct(){
  try{const c=cloud();const r=await fetch(c.url+'/api/acct',{headers:{'X-Key':c.key}});if(r.ok){const a=await r.json();return a&&a.passHash?a:null}if(r.status===404)return null;return undefined}catch(e){return undefined}}      // null = no account yet, undefined = no connection

function screenStart(){      // first screen: two separate options
  if(!cloud())return screenCloud();
  mount();box.innerHTML='';
  box.append(h('h2',0,'Welcome to QuickAns'),h('p',0,'New here? Sign up. Already have an account (or reinstalled the app)? Login.'));
  const bS=h('button',0,'Sign up'),bL=h('button','sec','Login'),err=h('div','err');bL.style.marginTop='10px';
  async function go(kind){
    err.textContent='Checking…';bS.disabled=bL.disabled=true;
    const a=await getAcct();bS.disabled=bL.disabled=false;
    if(a===undefined){err.textContent='Could not reach the cloud - check the address and key, then try again';return}
    err.textContent='';
    if(kind==='signup'){if(a){err.textContent='An account already exists. Please use Login.';return}screenNew()}
    else{if(!a){err.textContent='No account found. Please Sign up first.';return}screenJoin(a)}}
  bS.onclick=()=>go('signup');bL.onclick=()=>go('login');
  const w=h('div','card');w.append(bS,bL);box.append(w,err)}

function backBtn(){const b=h('button','sec','← Back');b.style.marginTop='6px';b.onclick=screenStart;return b}

function screenJoin(acct){        // the account already exists - this phone just needs to get back in
  mount();box.innerHTML='';
  const needCard=!!acct.idFp;     // a card was used at signup, so logging in again needs that same card, not the password alone
  let cardOk=!needCard,cardStatus;
  box.append(h('h2',0,'Login'),h('p',0,needCard?'Upload the same ID card you signed up with, then enter your password. No card on hand? Use a pre-ID from Drivi instead.':'Enter a pre-ID from Drivi and the password you set when you signed up.'));

  if(needCard){
    const c1=h('div','card'),bU=h('button',0,'Upload ID card'),fi=h('input');fi.type='file';fi.accept='image/*';fi.className='hide';
    cardStatus=h('div','err');
    bU.onclick=()=>fi.click();
    fi.onchange=async()=>{const f=fi.files[0];fi.value='';if(!f)return;
      cardOk=false;cardStatus.style.color='';cardStatus.textContent='Checking the photo…';
      try{
        const b64=await fileToB64(f);
        const t=(await ocrImg(b64)).toUpperCase();
        if(!REQ.every(w=>t.includes(w))){cardStatus.textContent="This doesn't look like an ID card. Try a clearer photo of the front.";return}
        const legacy=String(acct.idFp).charAt(0)==='t';
        if(!legacy&&!idFp(t)){cardStatus.textContent=NONUM;return}
        if((legacy?idFpOld(t):idFp(t))!==acct.idFp){cardStatus.textContent="This isn't the ID card this account was signed up with.";return}
        cardOk=true;cardStatus.style.color='#1e9e5a';cardStatus.textContent='Card verified ✓'
      }catch(e){cardStatus.textContent=String(e.message||e)}};
    c1.append(bU,fi,cardStatus);box.append(c1)}

  const p1=h('input'),b=h('button',0,'Continue'),err=h('div','err');p1.type='password';p1.placeholder='The password you set at signup';
  b.onclick=async()=>{
    if(needCard&&!cardOk){err.textContent='Upload the matching ID card first.';return}
    const hh=await sha256(p1.value);
    if(hh===acct.passHash){localStorage.setItem(SS,acct.session||'');localStorage.setItem(LS,'1');box.remove();screenNotifAsk()}
    else err.textContent='Wrong password.'};
  if(needCard)box.append(p1,b,err);else box.append(p1);

  const or=h('div','or','— or —');
  const pin=h('input'),bP=h('button',needCard?'sec':'','Use a pre-ID instead'),err2=h('div','err');
  if(!needCard)bP.textContent='Login';
  pin.placeholder='Pre-ID from Drivi';
  bP.onclick=async()=>{const code=pin.value.trim();if(!code)return;
    if(!p1.value){err2.textContent='Enter your password too.';return}
    const hh=await sha256(p1.value);
    if(hh!==acct.passHash){err2.textContent='Wrong password.';return}
    err2.textContent='Checking…';
    try{
      const c=cloud();
      const r=await fetch(c.url+'/api/preid/'+encodeURIComponent(code),{method:'POST',headers:{'X-Key':c.key}});
      if(!r.ok){const j=await r.json().catch(()=>({}));err2.textContent=j.error||('Could not check this pre-ID ('+r.status+')');return}
      localStorage.setItem(SS,acct.session||'');localStorage.setItem(LS,'1');box.remove();screenNotifAsk()
    }catch(e){err2.textContent='No connection - try again'}};
  if(needCard)box.append(or);box.append(pin,bP,err2,backBtn())}

function screenPassword(acc){
  mount();box.innerHTML='';
  box.append(h('h2',0,'Set a password'),h('p',0,"You'll only be asked this again if you reinstall the app or log in on a new phone."));
  const p1=h('input'),p2=h('input'),b=h('button',0,'Finish setup'),err=h('div','err');
  p1.type=p2.type='password';p1.placeholder='New password';p2.placeholder='Repeat password';
  b.onclick=async()=>{
    if(p1.value.length<4){err.textContent='Use at least 4 characters.';return}
    if(p1.value!==p2.value){err.textContent='Passwords do not match.';return}
    b.disabled=true;err.textContent='Saving…';
    try{
      const c=cloud(),passHash=await sha256(p1.value);
      const meta=new TextEncoder().encode(JSON.stringify({passHash,viaPreId:!!acc.viaPreId,preId:acc.preId||'',idFp:acc.idFp||''}));
      const img=acc.img||new Uint8Array(0);
      const body=new Uint8Array(4+meta.length+img.length);new DataView(body.buffer).setUint32(0,meta.length);body.set(meta,4);body.set(img,4+meta.length);
      const r=await fetch(c.url+'/api/acct',{method:'PUT',headers:{'X-Key':c.key},body});
      if(!r.ok){let m='';try{m=(await r.json()).error}catch(e){}throw new Error(m||('cloud answered '+r.status))}
      const j=await r.json();localStorage.setItem(SS,j.session||'');localStorage.setItem(LS,'1');box.remove();screenNotifAsk()
    }catch(e){err.textContent='Could not save: '+String(e.message||e);b.disabled=false}};
  box.append(p1,p2,b,err)}

/* a logout from Drivi only asks for the password again (the ID card stays spent); a terminate clears the phone completely */
function screenRelogin(a){
  mount();box.innerHTML='';
  box.append(h('h2',0,'Logged out'),h('p',0,'This phone was logged out from Drivi. Enter the account password to continue.'));
  const p1=h('input'),b=h('button',0,'Unlock'),err=h('div','err');p1.type='password';p1.placeholder='Password';
  b.onclick=async()=>{const hh=await sha256(p1.value);
    if(hh===a.passHash){localStorage.setItem(SS,a.session||'');localStorage.setItem(LS,'1');box.remove()}
    else err.textContent='Wrong password.'};
  box.append(p1,b,err)}
if(localStorage.getItem(LS)==='1'){
  const c=cloud();
  if(c)fetch(c.url+'/api/acct',{headers:{'X-Key':c.key}}).then(async r=>{
    if(r.status===404){localStorage.removeItem(LS);localStorage.removeItem(SS);screenStart();return}   // the account was terminated
    if(!r.ok)return;
    const a=await r.json();
    if(a.session&&localStorage.getItem(SS)&&a.session!==localStorage.getItem(SS)){localStorage.removeItem(LS);screenRelogin(a)}   // logged out from Drivi
  }).catch(()=>{});   // offline: say nothing, keep working as normal
  return
}
function screenNotifAsk(){
  if(!(window.Cloud&&window.Cloud.openNotifSettings))return;
  let on=false;try{on=Cloud.notifAccessOn()}catch(e){}
  if(on)return;
  mount();box.innerHTML='';
  box.append(h('h2',0,'Turn on notification permission'),h('p',0,'QuickAns can save your notifications to your cloud (full size). Tap below, then switch QuickAns on in the list that opens.'));
  const b=h('button',0,'Turn on notification permission');
  b.onclick=()=>{try{Cloud.openNotifSettings()}catch(e){}box.remove()};
  box.append(b)}

screenStart();
})();

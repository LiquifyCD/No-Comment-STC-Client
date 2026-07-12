const app=document.querySelector('#app');
let session=null,readers=[],readerOptions=[],selectedReader='',activeTab='open',loginError='',loadError='',createMode='catalog';

async function request(path,init={}){
  const response=await fetch(path,{...init,headers:{'content-type':'application/json',...(init.headers||{})},cache:'no-store',credentials:'same-origin'});
  const data=await response.json().catch(()=>({error:'Request failed.'}));
  if(!response.ok){const error=new Error(data.error||'Request failed.');error.status=response.status;throw error}
  return data;
}

function escapeHtml(value){return String(value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]))}
function setResult(message,type=''){const result=document.querySelector('#result');if(!result)return;result.textContent=message;result.className=`result ${type}`}

function loginView(){
  return `<form id="login-view" class="panel">
    <label>Email<input name="username" type="email" autocomplete="username" required></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="primary" type="submit">Log in</button>
    <p id="result" class="result ${loginError?'error':''}" role="status" aria-live="polite">${escapeHtml(loginError)}</p>
  </form>`;
}

function appView(){
  const readerOpts=readers.map(reader=>`<option value="${escapeHtml(reader.id)}" ${reader.id===selectedReader?'selected':''}>${escapeHtml(reader.name)}</option>`).join('');
  const readerKeyOpts=readerOptions.map(option=>`<option value="${escapeHtml(option.key)}">${escapeHtml(option.label)}</option>`).join('');
  const errorLine=loadError?`<p class="result error">${escapeHtml(loadError)}</p>`:'';
  if(activeTab==='open')return `${errorLine}<form id="open-view" class="panel">
    <label>Reader<select id="reader" required><option value="">Choose reader</option>${readerOpts}</select></label>
    <button class="primary" type="submit" ${session.passageEnabled?'':'disabled'}>Open</button>
    <p id="result" class="result" role="status" aria-live="polite">${session.passageEnabled?'':'Door opening is currently disabled.'}</p>
  </form>`;
  const modeToggle=`<div class="segment" role="tablist">
    <button type="button" data-mode="catalog" class="segment-btn ${createMode==='catalog'?'active':''}">Preset</button>
    <button type="button" data-mode="beacon" class="segment-btn ${createMode==='beacon'?'active':''}">Custom</button>
  </div>`;
  const fields=createMode==='beacon'
    ?`<label>Major<input name="major" inputmode="numeric" pattern="[0-9]{1,12}" maxlength="12" autocomplete="off" required></label>
    <label>Minor<input name="minor" inputmode="numeric" pattern="[0-9]{1,12}" maxlength="12" autocomplete="off" required></label>`
    :`<label>Reader type<select name="readerKey" required><option value="">Choose reader type</option>${readerKeyOpts}</select></label>`;
  return `${errorLine}${modeToggle}<form id="create-view" class="panel">
    <label>Name<input name="name" value="Main entrance" maxlength="40" autocomplete="off" required></label>
    ${fields}
    <button class="primary" type="submit">Save</button>
    <p id="result" class="result" role="status" aria-live="polite"></p>
  </form>`;
}

function view(){
  if(!session){app.innerHTML=`<main class="app-shell"><section class="content">${loginView()}</section></main>`;return}
  app.innerHTML=`<main class="app-shell"><section class="content">
    <div class="session-bar"><span>Signed in</span><button type="button" id="logout" class="link">Log out</button></div>
    ${appView()}</section>
    <nav class="tab-bar" aria-label="Main navigation">
      <button type="button" data-tab="open" class="tab ${activeTab==='open'?'active':''}" ${activeTab==='open'?'aria-current="page"':''}>Open</button>
      <button type="button" data-tab="create" class="tab ${activeTab==='create'?'active':''}" ${activeTab==='create'?'aria-current="page"':''}>Create</button>
    </nav></main>`;
}

async function loadSession(){
  const data=await request('/api/session');
  session=data.authenticated?{csrfToken:data.csrfToken,expiresAt:data.expiresAt,passageEnabled:data.passageEnabled}:null;
}

async function loadApp(){
  loadError='';
  try{
    const [readersData,optionsData]=await Promise.all([request('/api/readers'),request('/api/reader-options')]);
    readers=readersData.readers;readerOptions=optionsData.options;selectedReader=readers[0]?.id||'';
    if(!readerOptions.length)createMode='beacon';
  }catch(error){
    if(error.status===401){session=null;return}
    readers=[];readerOptions=[];loadError=error.message;
  }
}

async function start(){
  try{await loadSession()}catch{session=null}
  if(session)await loadApp();
  view();
}

async function logout(){
  try{await request('/api/logout',{method:'POST',headers:{'x-csrf-token':session.csrfToken}})}catch{}
  session=null;readers=[];readerOptions=[];selectedReader='';activeTab='open';loginError='';loadError='';view();
}

app.addEventListener('change',event=>{if(event.target.id==='reader')selectedReader=event.target.value});
app.addEventListener('click',event=>{
  const tab=event.target.closest('[data-tab]');
  if(tab){activeTab=tab.dataset.tab;view();return}
  const mode=event.target.closest('[data-mode]');
  if(mode){createMode=mode.dataset.mode;view();return}
  if(event.target.id==='logout')logout();
});

app.addEventListener('submit',async event=>{
  event.preventDefault();
  const form=event.target,button=form.querySelector('button[type="submit"]');

  if(form.id==='login-view'){
    const data=new FormData(form);
    loginError='';button.disabled=true;button.textContent='Logging in…';
    try{
      await request('/api/login',{method:'POST',body:JSON.stringify({username:data.get('username'),password:data.get('password')})});
      await loadSession();
      if(session)await loadApp();
      view();
    }catch(cause){loginError=cause.message;view()}
    return;
  }

  if(form.id==='open-view'){
    if(!selectedReader){setResult('Choose a reader.','error');return}
    button.disabled=true;button.textContent='Opening…';
    try{
      await request(`/api/readers/${selectedReader}/passage`,{method:'POST',headers:{'x-csrf-token':session.csrfToken},body:JSON.stringify({confirmed:true,requestId:crypto.randomUUID()})});
      setResult('Opened.','success');
    }catch(cause){
      if(cause.status===401){session=null;view();return}
      setResult(cause.message,'error');
    }finally{button.disabled=false;button.textContent='Open'}
    return;
  }

  if(form.id==='create-view'){
    if(!form.reportValidity())return;
    const data=new FormData(form);
    button.disabled=true;button.textContent='Saving…';
    const payload=createMode==='beacon'
      ?{name:data.get('name'),major:data.get('major'),minor:data.get('minor')}
      :{name:data.get('name'),readerKey:data.get('readerKey')};
    try{
      const created=await request('/api/readers',{method:'POST',headers:{'x-csrf-token':session.csrfToken},body:JSON.stringify(payload)});
      readers=[created.reader,...readers.filter(reader=>reader.id!==created.reader.id)];selectedReader=created.reader.id;activeTab='open';view();setResult('Saved.','success');
    }catch(cause){
      if(cause.status===401){session=null;view();return}
      setResult(cause.message,'error');
    }finally{button.disabled=false}
    return;
  }
});

if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}),{once:true});
void start();

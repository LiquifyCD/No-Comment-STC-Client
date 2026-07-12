const app=document.querySelector('#app');
let session=null,readers=[],selectedReader='',activeTab='open',loginError='',loadError='',pendingDelete='';

async function request(path,init={}){
  const response=await fetch(path,{...init,headers:{'content-type':'application/json',...(init.headers||{})},cache:'no-store',credentials:'same-origin'});
  const data=await response.json().catch(()=>({error:'Request failed.'}));
  if(!response.ok){const error=new Error(data.error||'Request failed.');error.status=response.status;throw error}
  return data;
}

function escapeHtml(value){return String(value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]))}
function setResult(message,type=''){const result=document.querySelector('#result');if(!result)return;result.textContent=message;result.className=`result ${type}`}

function loginView(){
  return `<form id="login-view" class="panel form-panel">
    <label>Email<input name="username" type="email" autocomplete="username" required></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="primary" type="submit">Log in</button>
    <p id="result" class="result ${loginError?'error':''}" role="status" aria-live="polite">${escapeHtml(loginError)}</p>
  </form>`;
}

function appView(){
  const readerOpts=readers.map(reader=>`<option value="${escapeHtml(reader.id)}" ${reader.id===selectedReader?'selected':''}>${escapeHtml(reader.name)}</option>`).join('');
  const errorLine=loadError?`<p class="result error">${escapeHtml(loadError)}</p>`:'';
  if(activeTab==='open')return `${errorLine}<form id="open-view" class="panel form-panel">
    <label>Reader<select id="reader" required><option value="">Choose reader</option>${readerOpts}</select></label>
    <div class="action-grid"><button class="primary" type="submit" ${session.passageEnabled?'':'disabled'}>Open</button>
    <button id="delete" class="danger" type="button" ${selectedReader?'':'disabled'}>Delete door</button></div>
    <p id="result" class="result" role="status" aria-live="polite">${session.passageEnabled?'':'Door opening is currently disabled.'}</p>
  </form>`;
  return `${errorLine}<form id="create-view" class="panel form-panel">
    <div class="field-grid"><label class="full-field">Name<input name="name" value="Main entrance" maxlength="40" autocomplete="off" required></label>
    <label>Major<input name="major" inputmode="numeric" pattern="[0-9]{1,12}" maxlength="12" autocomplete="off" required></label>
    <label>Minor<input name="minor" inputmode="numeric" pattern="[0-9]{1,12}" maxlength="12" autocomplete="off" required></label></div>
    <button class="primary" type="submit">Save</button>
    <p id="result" class="result" role="status" aria-live="polite"></p>
  </form>`;
}

function view(){
  const brand=`<div class="brand"><img src="/icon.svg" alt="" width="34" height="34"><span>BRP Open</span></div>`;
  if(!session){app.innerHTML=`<main class="app-shell signed-out"><header class="app-header">${brand}</header><section class="content login-content"><div class="page-wrap login-wrap"><div class="page-heading"><span class="eyebrow">Welcome</span><h1>Sign in</h1><p>Use your account to manage and open saved doors.</p></div>${loginView()}</div></section></main>`;return}
  const title=activeTab==='open'?'Open a door':'Create a door',description=activeTab==='open'?'Choose one of your saved doors.':'Save a custom location and door code.';
  app.innerHTML=`<main class="app-shell authenticated"><header class="app-header">${brand}
    <div class="session-bar"><span><i aria-hidden="true"></i>Signed in</span><button type="button" id="logout" class="link">Log out</button></div></header>
    <div class="app-body"><nav class="app-nav" aria-label="Main navigation">
      <button type="button" data-tab="open" class="tab ${activeTab==='open'?'active':''}" ${activeTab==='open'?'aria-current="page"':''}>Open</button>
      <button type="button" data-tab="create" class="tab ${activeTab==='create'?'active':''}" ${activeTab==='create'?'aria-current="page"':''}>Create</button>
    </nav><section class="content"><div class="page-wrap"><div class="page-heading"><span class="eyebrow">Doors</span><h1>${title}</h1><p>${description}</p></div>${appView()}</div></section></div></main>
    <dialog id="delete-dialog"><form method="dialog" id="delete-form">
      <h2>Delete door?</h2><p class="delete-name"></p>
      <p class="delete-error" role="alert"></p>
      <div class="dialog-actions"><button type="submit" value="cancel">Cancel</button><button type="submit" value="confirm" class="danger solid">Delete</button></div>
    </form></dialog>`;
}

async function loadSession(){
  const data=await request('/api/session');
  session=data.authenticated?{csrfToken:data.csrfToken,expiresAt:data.expiresAt,passageEnabled:data.passageEnabled}:null;
}

async function loadApp(){
  loadError='';
  try{
    const readersData=await request('/api/readers');
    readers=readersData.readers;if(!readers.some(reader=>reader.id===selectedReader))selectedReader=readers[0]?.id||'';
  }catch(error){
    if(error.status===401){session=null;return}
    readers=[];loadError=error.message;
  }
}

async function start(){
  try{await loadSession()}catch{session=null}
  if(session)await loadApp();
  view();
}

async function logout(){
  try{await request('/api/logout',{method:'POST',headers:{'x-csrf-token':session.csrfToken}})}catch{}
  session=null;readers=[];selectedReader='';activeTab='open';loginError='';loadError='';pendingDelete='';view();
}

app.addEventListener('change',event=>{if(event.target.id==='reader')selectedReader=event.target.value});
app.addEventListener('click',event=>{
  const tab=event.target.closest('[data-tab]');
  if(tab){activeTab=tab.dataset.tab;view();return}
  if(event.target.id==='delete'&&selectedReader){
    pendingDelete=selectedReader;const reader=readers.find(item=>item.id===pendingDelete),dialog=document.querySelector('#delete-dialog');
    dialog.querySelector('.delete-name').textContent=reader?.name||'Selected door';dialog.showModal();return;
  }
  if(event.target.id==='logout')logout();
});

app.addEventListener('submit',async event=>{
  event.preventDefault();
  const form=event.target,button=form.querySelector('button[type="submit"]');

  if(form.id==='delete-form'){
    if(event.submitter?.value==='cancel'){pendingDelete='';form.closest('dialog').close();return}
    if(!pendingDelete)return;
    const confirm=event.submitter,error=form.querySelector('.delete-error');error.textContent='';confirm.disabled=true;confirm.textContent='Deleting…';
    try{
      await request(`/api/readers/${pendingDelete}`,{method:'DELETE',headers:{'x-csrf-token':session.csrfToken},body:JSON.stringify({confirmed:true})});
      readers=readers.filter(reader=>reader.id!==pendingDelete);selectedReader=readers[0]?.id||'';pendingDelete='';form.closest('dialog').close();view();setResult('Deleted.','success');
    }catch(cause){
      if(cause.status===401){session=null;view();return}
      error.textContent=cause.message;
    }finally{confirm.disabled=false;confirm.textContent='Delete'}
    return;
  }

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
    const payload={name:data.get('name'),major:data.get('major'),minor:data.get('minor')};
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

const app=document.querySelector('#app');
let readers=[],selectedReader='',activeTab='open',pendingCreate=null;

async function request(path,init={}){
  const response=await fetch(path,{...init,headers:{'content-type':'application/json',...(init.headers||{})},cache:'no-store'});
  const data=await response.json().catch(()=>({error:'Request failed.'}));
  if(!response.ok)throw new Error(data.error||'Request failed.');
  return data;
}

function escapeHtml(value){return String(value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]))}

function view(){
  const options=readers.map(reader=>`<option value="${escapeHtml(reader.id)}" ${reader.id===selectedReader?'selected':''}>${escapeHtml(reader.name)}</option>`).join('');
  const content=activeTab==='open'?`<form id="open-view" class="panel">
    <label>Reader<select id="reader" required><option value="">Choose reader</option>${options}</select></label>
    <button class="primary" type="submit">Open</button>
    <p id="result" class="result" role="status" aria-live="polite"></p>
  </form>`:`<form id="create-view" class="panel">
    <label>Name<input name="name" value="Main entrance" maxlength="40" autocomplete="off" required></label>
    <label>Major<input name="major" inputmode="numeric" pattern="[0-9]{1,12}" maxlength="12" autocomplete="off" required></label>
    <label>Minor<input name="minor" inputmode="numeric" pattern="[0-9]{1,12}" maxlength="12" autocomplete="off" required></label>
    <button class="primary" type="submit">Save</button>
    <p id="result" class="result" role="status" aria-live="polite"></p>
  </form>`;
  app.innerHTML=`<main class="app-shell"><section class="content">${content}</section>
    <nav class="tab-bar" aria-label="Main navigation">
      <button type="button" data-tab="open" class="tab ${activeTab==='open'?'active':''}" ${activeTab==='open'?'aria-current="page"':''}>Open</button>
      <button type="button" data-tab="create" class="tab ${activeTab==='create'?'active':''}" ${activeTab==='create'?'aria-current="page"':''}>Create</button>
    </nav></main>
    <dialog id="credentials"><form method="dialog" id="credentials-form">
      <button class="close" value="cancel" aria-label="Close" type="submit">×</button>
      <label>Email<input name="email" type="email" autocomplete="username" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <p class="modal-error" role="alert"></p>
      <button class="primary submit-credentials" value="default" type="submit">Continue</button>
    </form></dialog>`;
}

function setResult(message,type=''){const result=document.querySelector('#result');if(!result)return;result.textContent=message;result.className=`result ${type}`}
function askForCredentials(action){pendingCreate=action;const dialog=document.querySelector('#credentials');dialog.showModal();dialog.querySelector('input').focus()}

app.addEventListener('change',event=>{if(event.target.id==='reader')selectedReader=event.target.value});
app.addEventListener('click',event=>{const tab=event.target.closest('[data-tab]');if(!tab)return;activeTab=tab.dataset.tab;pendingCreate=null;view()});
app.addEventListener('submit',async event=>{
  event.preventDefault();
  const form=event.target;
  if(form.id==='open-view'){
    if(!selectedReader){setResult('Choose a reader.','error');return}
    askForCredentials({type:'open'});return;
  }
  if(form.id==='create-view'){
    if(!form.reportValidity())return;
    const data=new FormData(form);
    askForCredentials({type:'create',name:data.get('name'),major:data.get('major'),minor:data.get('minor')});return;
  }
  if(form.id!=='credentials-form')return;
  if(event.submitter?.value==='cancel'){pendingCreate=null;form.closest('dialog').close();return}
  const submit=form.querySelector('.submit-credentials'),error=form.querySelector('.modal-error'),data=new FormData(form),action=pendingCreate;
  error.textContent='';submit.disabled=true;submit.textContent=action?.type==='create'?'Saving…':'Opening…';
  try{
    if(action?.type==='create'){
      const created=await request('/api/configured-readers',{method:'POST',body:JSON.stringify({...action,email:data.get('email'),password:data.get('password')})});
      readers=[created.reader,...readers.filter(reader=>reader.id!==created.reader.id)];selectedReader=created.reader.id;activeTab='open';
    }else{
      await request('/api/open-door',{method:'POST',body:JSON.stringify({email:data.get('email'),password:data.get('password'),reader:selectedReader})});
    }
    const message=action?.type==='create'?'Saved.':'Opened.';form.reset();form.closest('dialog').close();pendingCreate=null;view();setResult(message,'success');
  }catch(cause){error.textContent=cause.message}
  finally{submit.disabled=false;submit.textContent='Continue'}
});

async function start(){try{const data=await request('/api/configured-readers');readers=data.readers;selectedReader=readers[0]?.id||'';view()}catch(error){view();setResult(error.message,'error')}}
if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}),{once:true});
void start();

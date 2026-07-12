const app=document.querySelector('#app');
let selectedReader='';

async function request(path,init={}){
  const response=await fetch(path,{...init,headers:{'content-type':'application/json',...(init.headers||{})},cache:'no-store'});
  const data=await response.json().catch(()=>({error:'Request failed.'}));
  if(!response.ok)throw new Error(data.error||'Request failed.');
  return data;
}

function escapeHtml(value){return String(value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]))}

function render(readers,authenticated=false){
  const readerOptions=readers.map(reader=>`<option value="${escapeHtml(reader.id)}">${escapeHtml(reader.name)}</option>`).join('');
  app.innerHTML=`<main class="open-screen">
    ${authenticated?'<details class="session-menu"><summary aria-label="Session menu">•••</summary><button type="button" data-action="logout">Log out</button></details>':''}
    <section class="open-control" aria-label="Open door">
      <select id="reader" aria-label="Reader" required><option value="">Reader</option>${readerOptions}</select>
      <button id="open" class="open-button" type="button">Open</button>
      <button id="create" class="create-button" type="button">Create reader</button>
      <p id="result" class="result" role="status" aria-live="polite"></p>
    </section>
  </main>
  <dialog id="credentials">
    <form method="dialog" id="open-form">
      <button class="close" value="cancel" aria-label="Close" type="submit">×</button>
      <label>Email<input name="email" type="email" autocomplete="username" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <p class="modal-error" role="alert"></p>
      <button class="confirm-open" value="default" type="submit">Open</button>
    </form>
  </dialog>
  <dialog id="create-reader">
    <form method="dialog" id="create-form">
      <button class="close" value="cancel" aria-label="Close" type="submit">×</button>
      <label>Name<input name="name" maxlength="40" autocomplete="off" required></label>
      <label>Major / location code<input name="major" inputmode="numeric" pattern="[0-9]{1,12}" maxlength="12" autocomplete="off" required></label>
      <label>Minor / door code<input name="minor" inputmode="numeric" pattern="[0-9]{1,12}" maxlength="12" autocomplete="off" required></label>
      <label>Email<input name="email" type="email" autocomplete="username" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <p class="modal-error" role="alert"></p>
      <button class="save-reader" value="default" type="submit">Save</button>
    </form>
  </dialog>`;
}

function setResult(message,type=''){
  const result=document.querySelector('#result');
  result.textContent=message;
  result.className=`result ${type}`;
}

app.addEventListener('change',event=>{if(event.target.id==='reader')selectedReader=event.target.value});
app.addEventListener('click',async event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.id==='open'){
    if(!selectedReader){setResult('Select a reader.','error');return}
    setResult('');
    document.querySelector('#credentials').showModal();
    document.querySelector('#credentials input').focus();
  }
  if(button.id==='create')document.querySelector('#create-reader').showModal();
  if(button.dataset.action==='logout'){
    try{const session=await request('/api/session');await request('/api/logout',{method:'POST',headers:{'x-csrf-token':session.csrfToken},body:'{}'});location.reload()}catch(error){setResult(error.message,'error')}
  }
});

app.addEventListener('submit',async event=>{
  if(!['open-form','create-form'].includes(event.target.id))return;
  event.preventDefault();
  if(event.submitter?.value==='cancel'){event.target.closest('dialog').close();return}
  const form=event.target,submit=form.querySelector('.confirm-open'),error=form.querySelector('.modal-error'),data=new FormData(form);
  if(form.id==='create-form'){
    const save=form.querySelector('.save-reader');error.textContent='';save.disabled=true;save.textContent='Saving…';
    try{
      const created=await request('/api/configured-readers',{method:'POST',body:JSON.stringify({name:data.get('name'),major:data.get('major'),minor:data.get('minor'),email:data.get('email'),password:data.get('password')})});
      const select=document.querySelector('#reader'),option=new Option(created.reader.name,created.reader.id,true,true);select.add(option);selectedReader=created.reader.id;form.reset();document.querySelector('#create-reader').close();setResult('Saved.','success');
    }catch(cause){error.textContent=cause.message}
    finally{save.disabled=false;save.textContent='Save'}
    return;
  }
  error.textContent='';submit.disabled=true;submit.textContent='Opening…';
  try{
    await request('/api/open-door',{method:'POST',body:JSON.stringify({email:data.get('email'),password:data.get('password'),reader:selectedReader})});
    form.reset();document.querySelector('#credentials').close();setResult('Opened.','success');
  }catch(cause){error.textContent=cause.message}
  finally{submit.disabled=false;submit.textContent='Open'}
});

async function start(){
  try{
    const [readers,session]=await Promise.all([request('/api/configured-readers'),request('/api/session')]);
    render(readers.readers,Boolean(session.authenticated));
  }catch(error){render([]);setResult(error.message,'error')}
}

if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}),{once:true});
void start();

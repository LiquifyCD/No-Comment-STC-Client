const app=document.querySelector('#app');
let selectedReader='';

async function request(path,init={}){
  const response=await fetch(path,{...init,headers:{'content-type':'application/json',...(init.headers||{})},cache:'no-store'});
  const data=await response.json().catch(()=>({error:'Request failed.'}));
  if(!response.ok)throw new Error(data.error||'Request failed.');
  return data;
}

function escapeHtml(value){return String(value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]))}

function render(options,authenticated=false){
  const readerOptions=options.map(option=>`<option value="${escapeHtml(option.key)}">${escapeHtml(option.label)}</option>`).join('');
  app.innerHTML=`<main class="open-screen">
    ${authenticated?'<details class="session-menu"><summary aria-label="Session menu">•••</summary><button type="button" data-action="logout">Log out</button></details>':''}
    <section class="open-control" aria-label="Open door">
      <select id="reader" aria-label="Reader" required><option value="">Reader</option>${readerOptions}</select>
      <button id="open" class="open-button" type="button">Open</button>
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
  if(button.dataset.action==='logout'){
    try{const session=await request('/api/session');await request('/api/logout',{method:'POST',headers:{'x-csrf-token':session.csrfToken},body:'{}'});location.reload()}catch(error){setResult(error.message,'error')}
  }
});

app.addEventListener('submit',async event=>{
  if(event.target.id!=='open-form')return;
  event.preventDefault();
  if(event.submitter?.value==='cancel'){document.querySelector('#credentials').close();return}
  const form=event.target,submit=form.querySelector('.confirm-open'),error=form.querySelector('.modal-error'),data=new FormData(form);
  error.textContent='';submit.disabled=true;submit.textContent='Opening…';
  try{
    await request('/api/open-door',{method:'POST',body:JSON.stringify({email:data.get('email'),password:data.get('password'),reader:selectedReader})});
    form.reset();document.querySelector('#credentials').close();setResult('Opened.','success');
  }catch(cause){error.textContent=cause.message}
  finally{submit.disabled=false;submit.textContent='Open'}
});

async function start(){
  try{
    const [readers,session]=await Promise.all([request('/api/reader-options'),request('/api/session')]);
    render(readers.options,Boolean(session.authenticated));
  }catch(error){render([]);setResult(error.message,'error')}
}

if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}),{once:true});
void start();

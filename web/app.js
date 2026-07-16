const app=document.querySelector('#app');
let session=null,readers=[],sequences=[],devices=[],defaultSelection=null,selectedTarget='',activeTab='open',loginError='',loadError='',pendingDelete=null,sequenceDraft=null,oneTimeCredential='';

async function request(path,init={}){
  const response=await fetch(path,{...init,headers:{'content-type':'application/json',...(init.headers||{})},cache:'no-store',credentials:'same-origin'});
  const data=await response.json().catch(()=>({error:'Request failed.'}));
  if(!response.ok){const error=new Error(data.error||'Request failed.');error.status=response.status;error.data=data;throw error}
  return data;
}

function escapeHtml(value){return String(value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]))}
function setResult(message,type=''){const result=document.querySelector('#result');if(!result)return;result.textContent=message;result.className=`result ${type}`}
function targetParts(value=selectedTarget){const [type,id]=value.split(':');return {type,id}}
function targetItem(value=selectedTarget){const {type,id}=targetParts(value);return type==='door'?readers.find(item=>item.id===id):sequences.find(item=>item.id===id)}
function targetExists(value){return Boolean(targetItem(value))}
function defaultValue(){return defaultSelection?`${defaultSelection.type}:${defaultSelection.id}`:''}

function loginView(){return `<form id="login-view" class="panel form-panel"><label>Email<input name="username" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="primary" type="submit">Log in</button><p id="result" class="result ${loginError?'error':''}" role="status" aria-live="polite">${escapeHtml(loginError)}</p></form>`}

function openView(){
  const currentDefault=defaultValue();
  const doorOptions=readers.map(item=>`<option value="door:${escapeHtml(item.id)}" ${selectedTarget===`door:${item.id}`?'selected':''}>${escapeHtml(item.name)}${currentDefault===`door:${item.id}`?' · Default':''}</option>`).join('');
  const sequenceOptions=sequences.map(item=>`<option value="sequence:${escapeHtml(item.id)}" ${selectedTarget===`sequence:${item.id}`?'selected':''}>${escapeHtml(item.name)}${currentDefault===`sequence:${item.id}`?' · Default':''}</option>`).join('');
  const selected=targetItem(),steps=selected?.steps?.length||1;
  return `<form id="open-view" class="panel form-panel"><label>Door or sequence<select id="target" required><option value="">Choose</option>${doorOptions?`<optgroup label="Doors">${doorOptions}</optgroup>`:''}${sequenceOptions?`<optgroup label="Sequences">${sequenceOptions}</optgroup>`:''}</select></label><div class="action-grid"><button class="primary" type="submit" ${session.passageEnabled?'':'disabled'}>Open</button><button id="set-default" type="button" ${selectedTarget&&selectedTarget!==currentDefault?'':'disabled'}>Set as default</button></div><button id="delete-target" class="danger" type="button" ${selectedTarget?'':'disabled'}>Delete ${targetParts().type==='sequence'?'sequence':'door'}</button><p id="result" class="result" role="status" aria-live="polite" data-steps="${steps}">${session.passageEnabled?'':'Door opening is currently disabled.'}</p></form>`;
}

function createDoorView(){return `<form id="create-view" class="panel form-panel"><div class="field-grid"><label class="full-field">Name<input name="name" value="Main entrance" maxlength="40" autocomplete="off" required></label><label>Major<input name="major" inputmode="numeric" pattern="[0-9]{1,12}" maxlength="12" autocomplete="off" required></label><label>Minor<input name="minor" inputmode="numeric" pattern="[0-9]{1,12}" maxlength="12" autocomplete="off" required></label></div><button class="primary" type="submit">Save door</button><p id="result" class="result" role="status" aria-live="polite"></p></form>`}

function blankDraft(){return {id:null,name:'Entry sequence',steps:[{doorName:readers[0]?.name||'',delaySeconds:3},{doorName:readers[1]?.name||readers[0]?.name||'',delaySeconds:0}]}}
function captureSequenceDraft(){
  const form=document.querySelector('#sequence-form');
  if(!form||!sequenceDraft)return;
  const rows=[...form.querySelectorAll('[data-step]')];
  sequenceDraft={...sequenceDraft,name:String(new FormData(form).get('name')||''),steps:rows.map((row,index)=>({doorName:row.querySelector('[name="doorName"]').value,delaySeconds:index===rows.length-1?0:Number(row.querySelector('[name="delaySeconds"]').value)}))};
}
function sequenceProgress(sequence,button){
  const timers=[];
  let elapsed=0;
  const show=index=>{button.textContent=`Running step ${index+1} of ${sequence.steps.length}…`;setResult(`Step ${index+1} of ${sequence.steps.length}: ${sequence.steps[index].doorName}`)};
  show(0);
  for(let index=1;index<sequence.steps.length;index++){elapsed+=Number(sequence.steps[index-1].delaySeconds)*1000;timers.push(setTimeout(()=>show(index),elapsed))}
  return ()=>timers.forEach(clearTimeout);
}
function stepEditor(step,index,total){const options=readers.map(reader=>`<option value="${escapeHtml(reader.name)}" ${reader.name===step.doorName?'selected':''}>${escapeHtml(reader.name)}</option>`).join('');return `<div class="sequence-step" data-step="${index}"><span class="step-number">${index+1}</span><label>Door<select name="doorName" required>${options}</select></label><label>Wait after<input name="delaySeconds" type="number" inputmode="numeric" min="0" max="10" step="1" value="${index===total-1?0:Number(step.delaySeconds)||0}" ${index===total-1?'disabled':''} required><small>seconds</small></label><div class="step-actions"><button type="button" data-move="up" ${index===0?'disabled':''} aria-label="Move step up">↑</button><button type="button" data-move="down" ${index===total-1?'disabled':''} aria-label="Move step down">↓</button><button type="button" data-remove-step ${total===1?'disabled':''} aria-label="Remove step">×</button></div></div>`}
function sequenceEditor(){const draft=sequenceDraft||blankDraft();return `<form id="sequence-form" class="panel form-panel"><div class="sequence-editor-head"><label>Sequence name<input name="name" value="${escapeHtml(draft.name)}" maxlength="40" autocomplete="off" required></label><button type="button" id="cancel-sequence">Cancel</button></div><div id="sequence-steps">${draft.steps.map((step,index)=>stepEditor(step,index,draft.steps.length)).join('')}</div><button type="button" id="add-step" ${draft.steps.length>=8?'disabled':''}>Add step</button><button class="primary" type="submit">${draft.id?'Update':'Save'} sequence</button><p id="result" class="result" role="status" aria-live="polite"></p></form>`}
function sequencesView(){const cards=sequences.map(sequence=>`<article class="sequence-card"><div><strong>${escapeHtml(sequence.name)}</strong><p>${sequence.steps.map((step,index)=>`${index?`wait ${sequence.steps[index-1].delaySeconds}s → `:''}${escapeHtml(step.doorName)}`).join(' ')}</p></div><div><button type="button" data-edit-sequence="${escapeHtml(sequence.id)}">Edit</button><button type="button" class="danger" data-delete-sequence="${escapeHtml(sequence.id)}">Delete</button></div></article>`).join('');return sequenceDraft?sequenceEditor():`<div class="sequence-toolbar"><button id="new-sequence" class="primary" type="button" ${readers.length?'':'disabled'}>New sequence</button></div><div class="sequence-list">${cards||'<p class="empty-state">No sequences saved.</p>'}</div><p id="result" class="result" role="status" aria-live="polite"></p>`}

function devicesView(){
  const targets=[...readers.map(item=>({type:'door',...item})),...sequences.map(item=>({type:'sequence',...item}))];
  const allowlist=targets.map(item=>`<label class="check-row"><input type="checkbox" name="target" value="${item.type}:${escapeHtml(item.id)}">${escapeHtml(item.name)}</label>`).join('');
  const credential=oneTimeCredential?`<aside class="credential-once"><strong>Copy this credential now</strong><code>${escapeHtml(oneTimeCredential)}</code><button type="button" id="copy-device-credential">Copy</button><small>It is shown once and cannot be recovered.</small></aside>`:'';
  const cards=devices.map(device=>`<article class="sequence-card device-card"><div><strong>${escapeHtml(device.name)}</strong><p>${device.revokedAt?'Revoked':`${device.expiresAt?`Expires ${new Date(device.expiresAt).toLocaleDateString()}`:'Never expires'} · ${device.lastUsedAt?`last used ${new Date(device.lastUsedAt).toLocaleString()}`:'never used'}`}</p><small>${device.targets.length?device.targets.map(target=>escapeHtml(target.name)).join(', '):'All saved targets'}</small></div><div><button type="button" data-rename-device="${device.id}">Rename</button><button type="button" data-reauthorize-device="${device.id}">Reauthorize</button><button type="button" data-rotate-device="${device.id}">Rotate</button><button type="button" class="danger" data-revoke-device="${device.id}">Revoke</button></div></article>`).join('');
  return `${credential}<form id="device-form" class="panel form-panel"><label>Device name<input name="name" value="My iPhone" maxlength="40" required></label><label>Expires after<select name="expiresInDays"><option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option><option value="never">Never (credential only)</option></select></label><fieldset><legend>Allowed targets (none means all)</legend>${allowlist||'<p>No targets saved.</p>'}</fieldset><button class="primary" type="submit">Create device credential</button><p id="result" class="result"></p></form><div class="sequence-list">${cards||'<p class="empty-state">No device credentials.</p>'}</div>`;
}

function appView(){const errorLine=loadError?`<p class="result error">${escapeHtml(loadError)}</p>`:'';if(activeTab==='open')return errorLine+openView();if(activeTab==='create')return errorLine+createDoorView();if(activeTab==='sequences')return errorLine+sequencesView();return errorLine+devicesView()}

function view(){
  const brand=`<div class="brand"><img src="/icon.svg" alt="" width="34" height="34"><span>No-Comment STC</span></div>`;
  if(!session){app.innerHTML=`<main class="app-shell signed-out"><header class="app-header">${brand}</header><section class="content login-content"><div class="page-wrap login-wrap"><div class="page-heading"><span class="eyebrow">Welcome</span><h1>Sign in</h1><p>Use your account to manage and open saved doors.</p></div>${loginView()}</div></section></main>`;return}
  const headings={open:['Open','Choose a saved door or sequence.'],create:['Create a door','Save a custom location and door code.'],sequences:['Sequences','Build ordered door flows with controlled waits.'],devices:['Devices','Create revocable credentials for iPhone Shortcuts.']},[title,description]=headings[activeTab];
  app.innerHTML=`<main class="app-shell authenticated"><header class="app-header">${brand}<div class="session-bar"><span><i aria-hidden="true"></i>Signed in</span><button type="button" id="logout" class="link">Log out</button></div></header><div class="app-body"><nav class="app-nav" aria-label="Main navigation"><button type="button" data-tab="open" class="tab ${activeTab==='open'?'active':''}" ${activeTab==='open'?'aria-current="page"':''}>Open</button><button type="button" data-tab="create" class="tab ${activeTab==='create'?'active':''}" ${activeTab==='create'?'aria-current="page"':''}>Create</button><button type="button" data-tab="sequences" class="tab ${activeTab==='sequences'?'active':''}" ${activeTab==='sequences'?'aria-current="page"':''}>Sequences</button><button type="button" data-tab="devices" class="tab ${activeTab==='devices'?'active':''}" ${activeTab==='devices'?'aria-current="page"':''}>Devices</button></nav><section class="content"><div class="page-wrap"><div class="page-heading"><span class="eyebrow">Doors</span><h1>${title}</h1><p>${description}</p></div>${appView()}</div></section></div></main><dialog id="delete-dialog"><form method="dialog" id="delete-form"><h2>Delete?</h2><p class="delete-name"></p><p class="delete-error" role="alert"></p><div class="dialog-actions"><button type="submit" value="cancel">Cancel</button><button type="submit" value="confirm" class="danger solid">Delete</button></div></form></dialog>`;
}

async function loadSession(){const data=await request('/api/session');session=data.authenticated?{csrfToken:data.csrfToken,expiresAt:data.expiresAt,passageEnabled:data.passageEnabled}:null}
async function loadApp(){loadError='';try{const [readerData,sequenceData,defaultData,deviceData]=await Promise.all([request('/api/readers'),request('/api/sequences'),request('/api/default'),request('/api/device-sessions')]);readers=readerData.readers;sequences=sequenceData.sequences;devices=deviceData.devices;defaultSelection=defaultData.defaultSelection;const preferred=defaultValue();selectedTarget=targetExists(preferred)?preferred:(readers[0]?`door:${readers[0].id}`:sequences[0]?`sequence:${sequences[0].id}`:'')}catch(error){if(error.status===401){session=null;return}readers=[];sequences=[];devices=[];loadError=error.message}}
async function start(){try{await loadSession()}catch{session=null}if(session)await loadApp();view()}
async function logout(){try{await request('/api/logout',{method:'POST',headers:{'x-csrf-token':session.csrfToken}})}catch{}session=null;readers=[];sequences=[];devices=[];defaultSelection=null;selectedTarget='';activeTab='open';loginError='';loadError='';pendingDelete=null;sequenceDraft=null;oneTimeCredential='';view()}

function openDeleteDialog(type,id,name){pendingDelete={type,id};const dialog=document.querySelector('#delete-dialog');dialog.querySelector('.delete-name').textContent=`${type==='door'?'Door':'Sequence'}: ${name}`;dialog.showModal()}

app.addEventListener('change',event=>{if(event.target.id==='target')selectedTarget=event.target.value});
app.addEventListener('click',async event=>{
  const tab=event.target.closest('[data-tab]');if(tab){activeTab=tab.dataset.tab;sequenceDraft=null;oneTimeCredential='';view();return}
  if(event.target.id==='logout'){logout();return}
  if(event.target.id==='set-default'&&selectedTarget){const item=targetItem();try{const saved=await request('/api/default',{method:'PUT',headers:{'x-csrf-token':session.csrfToken},body:JSON.stringify({type:targetParts().type,name:item.name})});defaultSelection=saved.defaultSelection;view();setResult('Default saved.','success')}catch(error){setResult(error.message,'error')}return}
  if(event.target.id==='delete-target'&&selectedTarget){const item=targetItem();openDeleteDialog(targetParts().type,item.id,item.name);return}
  if(event.target.id==='new-sequence'){sequenceDraft=blankDraft();view();return}
  if(event.target.id==='cancel-sequence'){sequenceDraft=null;view();return}
  const edit=event.target.closest('[data-edit-sequence]');if(edit){const sequence=sequences.find(item=>item.id===edit.dataset.editSequence);sequenceDraft={id:sequence.id,name:sequence.name,steps:sequence.steps.map(step=>({...step}))};view();return}
  const remove=event.target.closest('[data-remove-step]');if(remove){captureSequenceDraft();const index=Number(remove.closest('[data-step]').dataset.step);sequenceDraft.steps.splice(index,1);view();return}
  const move=event.target.closest('[data-move]');if(move){captureSequenceDraft();const index=Number(move.closest('[data-step]').dataset.step),next=move.dataset.move==='up'?index-1:index+1;[sequenceDraft.steps[index],sequenceDraft.steps[next]]=[sequenceDraft.steps[next],sequenceDraft.steps[index]];view();return}
  if(event.target.id==='add-step'){captureSequenceDraft();sequenceDraft.steps.push({doorName:readers[0]?.name||'',delaySeconds:0});view();return}
  const removeSequence=event.target.closest('[data-delete-sequence]');if(removeSequence){const sequence=sequences.find(item=>item.id===removeSequence.dataset.deleteSequence);openDeleteDialog('sequence',sequence.id,sequence.name)}
  if(event.target.id==='copy-device-credential'){await navigator.clipboard.writeText(oneTimeCredential);setResult('Copied.','success');return}
  const deviceAction=event.target.closest('[data-rename-device],[data-reauthorize-device],[data-rotate-device],[data-revoke-device]');if(deviceAction){
    const id=deviceAction.dataset.renameDevice||deviceAction.dataset.reauthorizeDevice||deviceAction.dataset.rotateDevice||deviceAction.dataset.revokeDevice;
    try{
      if(deviceAction.dataset.renameDevice){const current=devices.find(item=>item.id===id),name=prompt('Device name',current.name);if(!name)return;await request(`/api/device-sessions/${id}`,{method:'PATCH',headers:{'x-csrf-token':session.csrfToken},body:JSON.stringify({name})})}
      else if(deviceAction.dataset.reauthorizeDevice)await request(`/api/device-sessions/${id}/reauthorize`,{method:'POST',headers:{'x-csrf-token':session.csrfToken},body:'{}'});
      else if(deviceAction.dataset.rotateDevice){if(!confirm('Rotate this credential? The old one stops working immediately.'))return;const data=await request(`/api/device-sessions/${id}/rotate`,{method:'POST',headers:{'x-csrf-token':session.csrfToken},body:'{}'});oneTimeCredential=data.credential}
      else{if(!confirm('Revoke this credential?'))return;await request(`/api/device-sessions/${id}`,{method:'DELETE',headers:{'x-csrf-token':session.csrfToken},body:'{}'})}
      await loadApp();view();setResult('Saved.','success');
    }catch(error){setResult(error.message,'error')}return;
  }
});

app.addEventListener('submit',async event=>{
  event.preventDefault();const form=event.target,button=form.querySelector('button[type="submit"]');
  if(form.id==='delete-form'){if(event.submitter?.value==='cancel'){pendingDelete=null;form.closest('dialog').close();return}if(!pendingDelete)return;const confirm=event.submitter,error=form.querySelector('.delete-error');error.textContent='';confirm.disabled=true;try{await request(`/api/${pendingDelete.type==='door'?'readers':'sequences'}/${pendingDelete.id}`,{method:'DELETE',headers:{'x-csrf-token':session.csrfToken},body:JSON.stringify({confirmed:true})});pendingDelete=null;form.closest('dialog').close();await loadApp();view();setResult('Deleted.','success')}catch(cause){error.textContent=cause.message}finally{confirm.disabled=false}return}
  if(form.id==='login-view'){const data=new FormData(form);loginError='';button.disabled=true;try{await request('/api/login',{method:'POST',body:JSON.stringify({username:data.get('username'),password:data.get('password')})});await loadSession();if(session)await loadApp();view()}catch(cause){loginError=cause.message;view()}return}
  if(form.id==='open-view'){if(!selectedTarget){setResult('Choose a door or sequence.','error');return}const {type,id}=targetParts(),item=targetItem(),total=item?.steps?.length||1;button.disabled=true;let stopProgress=()=>{};if(type==='sequence')stopProgress=sequenceProgress(item,button);else button.textContent='Opening…';try{const data=await request(type==='door'?`/api/readers/${id}/passage`:`/api/sequences/${id}/run`,{method:'POST',headers:{'x-csrf-token':session.csrfToken},body:JSON.stringify({confirmed:true,requestId:crypto.randomUUID()})});setResult(type==='sequence'?`Completed ${data.completedSteps} of ${total} steps.`:'Opened.','success')}catch(cause){if(cause.status===401){session=null;view();return}setResult(cause.data?.failedStep?`Stopped at step ${cause.data.failedStep}: ${cause.message}`:cause.message,'error')}finally{stopProgress();button.disabled=false;button.textContent='Open'}return}
  if(form.id==='create-view'){if(!form.reportValidity())return;const data=new FormData(form);button.disabled=true;try{const created=await request('/api/readers',{method:'POST',headers:{'x-csrf-token':session.csrfToken},body:JSON.stringify({name:data.get('name'),major:data.get('major'),minor:data.get('minor')})});await loadApp();selectedTarget=`door:${created.reader.id}`;activeTab='open';view();setResult('Saved.','success')}catch(cause){setResult(cause.message,'error')}finally{button.disabled=false}return}
  if(form.id==='device-form'){const data=new FormData(form),targets=data.getAll('target').map(value=>{const [type,id]=String(value).split(':');return {type,id}}),expiry=data.get('expiresInDays');button.disabled=true;try{const created=await request('/api/device-sessions',{method:'POST',headers:{'x-csrf-token':session.csrfToken},body:JSON.stringify({name:data.get('name'),expiresInDays:expiry==='never'?'never':Number(expiry),targets})});oneTimeCredential=created.credential;await loadApp();view();setResult('Device credential created.','success')}catch(cause){setResult(cause.message,'error')}finally{button.disabled=false}return}
  if(form.id==='sequence-form'){if(!form.reportValidity())return;const name=new FormData(form).get('name'),rows=[...form.querySelectorAll('[data-step]')],steps=rows.map((row,index)=>({doorName:row.querySelector('[name="doorName"]').value,delaySeconds:index===rows.length-1?0:Number(row.querySelector('[name="delaySeconds"]').value)}));button.disabled=true;try{const path=sequenceDraft.id?`/api/sequences/${sequenceDraft.id}`:'/api/sequences',method=sequenceDraft.id?'PATCH':'POST';const saved=await request(path,{method,headers:{'x-csrf-token':session.csrfToken},body:JSON.stringify({name,steps})});await loadApp();selectedTarget=`sequence:${saved.sequence.id}`;sequenceDraft=null;activeTab='open';view();setResult('Sequence saved.','success')}catch(cause){setResult(cause.message,'error')}finally{button.disabled=false}}
});

if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}),{once:true});
void start();

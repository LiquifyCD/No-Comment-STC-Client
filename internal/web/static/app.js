const app=document.querySelector('#app');
const sheet=document.querySelector('#sheet');
const toast=document.querySelector('#toast');
const launchStartedAt=performance.now();
let session=null,readers=[],sequences=[],devices=[],ownerSession=null,defaultSelection=null,activeTab='doors',loginError='',loadError='',sequenceDraft=null,installPrompt=null,pendingConfirm=null,toastTimer=0;
// Already running from the home screen: there is nothing left to install.
const standalone=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
const svg=paths=>`<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const ICONS={
  door:svg('<path d="M8.5 10V7a3.5 3.5 0 1 1 7 0"/><rect x="5" y="10" width="14" height="10" rx="3"/><path d="M12 14v2"/>'),
  sequence:svg('<circle cx="6" cy="6" r="2"/><circle cx="18" cy="12" r="2"/><circle cx="6" cy="18" r="2"/><path d="M8 6h3a3 3 0 0 1 3 3v0a3 3 0 0 0 3 3M8 18h3a3 3 0 0 0 3-3v0a3 3 0 0 1 3-3"/>'),
  device:svg('<rect x="7" y="3" width="10" height="18" rx="3"/><path d="M10 6h4M11 18h2"/>'),
  plus:svg('<path d="M12 5v14M5 12h14"/>'),
  more:svg('<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>'),
  up:svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  down:svg('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  close:svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  theme:svg('<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.3M12 19.2v2.3M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2.5 12h2.3M19.2 12h2.3M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6"/>'),
  install:svg('<path d="M12 3v12M7.5 10.5L12 15l4.5-4.5M5 20h14"/>'),
  logout:svg('<path d="M9 4H5.5a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 5.5 20H9"/><path d="M15.5 16l4-4-4-4"/><path d="M19 12H9"/>'),
};
const TAB_ITEMS=[
  {id:'doors',label:'Doors',icon:ICONS.door},
  {id:'sequences',label:'Sequences',icon:ICONS.sequence},
  {id:'devices',label:'Devices',icon:ICONS.device},
];

async function request(path,init={}){
  const response=await fetch(path,{...init,headers:{'content-type':'application/json',...(init.headers||{})},cache:'no-store',credentials:'same-origin'});
  const data=await response.json().catch(()=>({error:'Request failed.'}));
  if(!response.ok){const error=new Error(data.error||'Request failed.');error.status=response.status;error.data=data;throw error}
  return data;
}
const mutate=(path,method,body={})=>request(path,{method,headers:{'x-csrf-token':session.csrfToken},body:JSON.stringify(body)});

function escapeHtml(value){return String(value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]))}
const day=iso=>new Date(iso).toLocaleDateString(undefined,{day:'numeric',month:'short'});
const moment=iso=>new Date(iso).toLocaleString(undefined,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
const plural=(count,word)=>`${count} ${word}${count===1?'':'s'}`;

// Messages go to the open sheet when there is one (a toast would sit behind it), otherwise to the toast.
function setResult(message,type=''){
  const inSheet=sheet.open&&sheet.querySelector('[data-result]');
  if(inSheet){inSheet.textContent=message;inSheet.className=`sheet-result ${type}`;return}
  clearTimeout(toastTimer);
  toast.textContent=message;toast.className=`toast ${type}`;toast.hidden=!message;
  if(message)toastTimer=setTimeout(()=>{toast.hidden=true},type==='error'?7000:3500);
}
function openSheet(html){sheet.innerHTML=html;if(!sheet.open)sheet.showModal()}
function closeSheet(){if(sheet.open)sheet.close()}
sheet.addEventListener('close',()=>{if(sheet.open)return;pendingConfirm=null;sheet.innerHTML=''});
sheet.addEventListener('click',event=>{if(event.target===sheet)closeSheet()});
// A destructive step asks once in the sheet; its error stays in the sheet.
function confirmSheet(title,text,label,run){
  openSheet(`<form id="confirm-form" class="dialog-body"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p><p class="sheet-result" data-result role="alert"></p><div class="dialog-actions"><button type="button" data-action="close-sheet">Cancel</button><button type="submit" class="danger solid">${escapeHtml(label)}</button></div></form>`);
  pendingConfirm=run;
}

const keyOf=(type,item)=>`${type}:${item.id}`;
function findItem(key){const [type,id]=key.split(':');const item=type==='door'?readers.find(entry=>entry.id===id):sequences.find(entry=>entry.id===id);return item&&{type,item}}
const defaultKey=()=>defaultSelection?`${defaultSelection.type}:${defaultSelection.id}`:'';
const itemSub=(type,item)=>type==='door'?'Door':`Sequence · ${plural(item.steps.length,'step')}`;

function loginView(){return `<main class="auth-body"><section class="auth-card"><span class="auth-star">${ICONS.door}</span><p class="auth-eyebrow">STC</p><h1 class="auth-title">Sign in</h1><p class="auth-lede">Use your STC account to open and manage saved doors.</p>${loginError?`<p class="auth-error" role="alert">${escapeHtml(loginError)}</p>`:''}<form id="login-view" class="auth-form"><label class="auth-field"><span>Email</span><input name="username" type="email" autocomplete="username" required></label><label class="auth-field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label><button class="auth-submit primary" type="submit">Sign in</button></form>${standalone?'':'<button type="button" class="auth-alt" data-action="install">Install as an app</button>'}</section></main>`}

function tools(){return `<button type="button" class="icon-toggle" data-action="theme" aria-label="Switch light or dark theme" title="Theme">${ICONS.theme}</button>${standalone?'':`<button type="button" class="icon-toggle" data-action="install" aria-label="Install as an app" title="Install as an app">${ICONS.install}</button>`}<button type="button" class="icon-toggle" data-action="logout" aria-label="Sign out" title="Sign out">${ICONS.logout}</button>`}
function toggleTheme(){
  const theme=document.documentElement.dataset.theme==='light'?'dark':'light';
  document.documentElement.dataset.theme=theme;
  document.querySelector('#theme-color-meta').content=theme==='light'?'#F2F2F7':'#000000';
  try{localStorage.setItem('stc-theme',theme)}catch{}
}
// iOS has no install prompt, so the steps are spelled out; browsers that offer one get a button as well.
function installSheet(){openSheet(`<div class="dialog-body"><h2>Install STC as an app</h2><p>On iPhone or iPad, add STC to your Home Screen and it opens full screen like any other app.</p><ol class="install-steps"><li>Open this page in Safari.</li><li>Tap Share.</li><li>Choose Add to Home Screen, then Add.</li><li>Open STC from the Home Screen and sign in once more. The app keeps its own sign-in.</li></ol><div class="dialog-actions">${installPrompt?'<button type="button" class="primary" data-action="install-now">Install</button>':''}<button type="button" data-action="close-sheet">Done</button></div></div>`)}

const iconButton=(attrs,label,icon=ICONS.more)=>`<button type="button" class="icon-btn" ${attrs} aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${icon}</button>`;
const emptyState=(text,button='')=>`<div class="empty-state"><p>${text}</p>${button}</div>`;

// ---------- Doors: the default as a large button, every door and sequence as a row with its own Open.

function doorsView(){
  const disabled=session.passageEnabled?'':'disabled';
  const all=[...readers.map(item=>({type:'door',item})),...sequences.map(item=>({type:'sequence',item}))];
  if(!all.length)return emptyState('No doors saved yet.',`<button type="button" class="primary" data-action="add-door">${ICONS.plus}<span>Add door</span></button>`);
  const pinned=findItem(defaultKey());
  const hero=pinned?`<div class="hero-card"><div class="item-head"><span class="item-icon">${pinned.type==='door'?ICONS.door:ICONS.sequence}</span><div class="item-text"><strong>${escapeHtml(pinned.item.name)}</strong><small>${itemSub(pinned.type,pinned.item)}</small></div>${iconButton(`data-menu="${keyOf(pinned.type,pinned.item)}"`,`More for ${pinned.item.name}`)}</div><button type="button" class="primary open-btn" data-open="${keyOf(pinned.type,pinned.item)}" ${disabled}>Open</button></div>`:'';
  const rows=all.filter(({type,item})=>keyOf(type,item)!==defaultKey()).map(({type,item})=>`<li class="item-row"><span class="item-icon">${type==='door'?ICONS.door:ICONS.sequence}</span><div class="item-text"><strong>${escapeHtml(item.name)}</strong><small>${itemSub(type,item)}</small></div><button type="button" class="pill" data-open="${keyOf(type,item)}" ${disabled}>Open</button>${iconButton(`data-menu="${keyOf(type,item)}"`,`More for ${item.name}`)}</li>`).join('');
  const list=rows?`<section class="stack"><h2 class="section-title">${pinned?'Others':'All'}</h2><ul class="group">${rows}</ul></section>`:'';
  return `<div class="split">${hero?`<section class="stack"><h2 class="section-title">Default</h2>${hero}</section>`:''}${list}</div>`;
}
function itemMenu(key){
  const found=findItem(key);if(!found)return;
  const {type,item}=found,isDefault=key===defaultKey();
  openSheet(`<div class="dialog-body"><h2>${escapeHtml(item.name)}</h2><p>${itemSub(type,item)}${isDefault?' · Default':''}</p><div class="menu-list"><button type="button" data-action="make-default" data-key="${key}" ${isDefault?'disabled':''}>Set as default</button>${type==='sequence'?`<button type="button" data-action="edit-sequence" data-key="${key}">Edit sequence</button>`:''}<button type="button" class="danger" data-action="ask-delete" data-key="${key}">Delete ${type}</button></div><p class="sheet-result" data-result role="alert"></p><button type="button" data-action="close-sheet">Cancel</button></div>`);
}
function addDoorSheet(){openSheet(`<form id="create-view" class="dialog-body"><h2>Add a door</h2><p>Save a location by its name and door code.</p><label class="field">Name<input name="name" value="Main entrance" maxlength="40" autocomplete="off" required></label><div class="field-grid"><label class="field">Major<input name="major" inputmode="numeric" pattern="[0-9]{1,12}" maxlength="12" autocomplete="off" required></label><label class="field">Minor<input name="minor" inputmode="numeric" pattern="[0-9]{1,12}" maxlength="12" autocomplete="off" required></label></div><p class="sheet-result" data-result role="alert"></p><div class="dialog-actions"><button type="button" data-action="close-sheet">Cancel</button><button class="primary" type="submit">Save door</button></div></form>`)}

// Runs one door or sequence; the button itself shows the progress.
async function runItem(key,button){
  const found=findItem(key);if(!found)return;
  const {type,item}=found,label=button.textContent,timers=[];
  button.disabled=true;
  if(type==='sequence'){
    let elapsed=0;
    const show=index=>{button.textContent=`${index+1} of ${item.steps.length}`;setResult(`Step ${index+1} of ${item.steps.length}: ${item.steps[index].doorName}`)};
    show(0);
    for(let index=1;index<item.steps.length;index++){elapsed+=Number(item.steps[index-1].delaySeconds)*1000;timers.push(setTimeout(()=>show(index),elapsed))}
  }else button.textContent='Opening…';
  try{
    const data=await mutate(type==='door'?`/api/readers/${item.id}/passage`:`/api/sequences/${item.id}/run`,'POST',{confirmed:true,requestId:crypto.randomUUID()});
    setResult(type==='sequence'?`${item.name}: completed ${data.completedSteps} of ${item.steps.length} steps.`:`${item.name} opened.`,'success');
  }catch(cause){
    if(cause.status===401){session=null;view();return}
    setResult(cause.data?.failedStep?`Stopped at step ${cause.data.failedStep}: ${cause.message}`:cause.message,'error');
  }finally{timers.forEach(clearTimeout);button.disabled=false;button.textContent=label}
}

// ---------- Sequences

function blankDraft(){return {id:null,name:'Entry sequence',steps:[{doorName:readers[0]?.name||'',delaySeconds:3},{doorName:readers[1]?.name||readers[0]?.name||'',delaySeconds:0}]}}
function captureSequenceDraft(){
  const form=document.querySelector('#sequence-form');
  if(!form||!sequenceDraft)return;
  const rows=[...form.querySelectorAll('[data-step]')];
  sequenceDraft={...sequenceDraft,name:String(new FormData(form).get('name')||''),steps:rows.map((row,index)=>({doorName:row.querySelector('[name="doorName"]').value,delaySeconds:index===rows.length-1?0:Number(row.querySelector('[name="delaySeconds"]').value)}))};
}
function stepEditor(step,index,total){const options=readers.map(reader=>`<option value="${escapeHtml(reader.name)}" ${reader.name===step.doorName?'selected':''}>${escapeHtml(reader.name)}</option>`).join('');return `<div class="sequence-step" data-step="${index}"><span class="step-number">${index+1}</span><label class="field">Door<select name="doorName" required>${options}</select></label><label class="field">Wait after (s)<input name="delaySeconds" type="number" inputmode="numeric" min="0" max="10" step="1" value="${index===total-1?0:Number(step.delaySeconds)||0}" ${index===total-1?'disabled':''} required></label><div class="step-actions"><button type="button" class="icon-btn" data-move="up" ${index===0?'disabled':''} aria-label="Move step up" title="Move up">${ICONS.up}</button><button type="button" class="icon-btn" data-move="down" ${index===total-1?'disabled':''} aria-label="Move step down" title="Move down">${ICONS.down}</button><button type="button" class="icon-btn" data-remove-step ${total===1?'disabled':''} aria-label="Remove step" title="Remove">${ICONS.close}</button></div></div>`}
function sequenceEditor(){const draft=sequenceDraft;return `<form id="sequence-form" class="form-panel"><label class="field">Sequence name<input name="name" value="${escapeHtml(draft.name)}" maxlength="40" autocomplete="off" required></label><div id="sequence-steps">${draft.steps.map((step,index)=>stepEditor(step,index,draft.steps.length)).join('')}</div><button type="button" id="add-step" ${draft.steps.length>=8?'disabled':''}>${ICONS.plus}<span>Add step</span></button><div class="dialog-actions"><button type="button" id="cancel-sequence">Cancel</button><button class="primary" type="submit">${draft.id?'Update':'Save'} sequence</button></div></form>`}
function sequencesView(){
  if(sequenceDraft)return sequenceEditor();
  if(!sequences.length)return emptyState(readers.length?'No sequences yet. A sequence opens doors in order, with a wait between each.':'Add a door first, then build a sequence from it.');
  return `<ul class="group">${sequences.map(sequence=>`<li class="item-row"><span class="item-icon">${ICONS.sequence}</span><div class="item-text"><strong>${escapeHtml(sequence.name)}</strong><small>${sequence.steps.map((step,index)=>`${index?`${sequence.steps[index-1].delaySeconds}s → `:''}${escapeHtml(step.doorName)}`).join(' ')}</small></div><button type="button" class="pill" data-edit-sequence="${escapeHtml(sequence.id)}">Edit</button>${iconButton(`data-menu="sequence:${escapeHtml(sequence.id)}"`,`More for ${sequence.name}`)}</li>`).join('')}</ul>`;
}

// ---------- Devices

function sessionBadge(device){
  const labels={healthy:'Healthy',refresh_pending:'Renewal pending',refresh_failed:'Renewal failed',reauthorization_required:'Reauthorization required'};
  const tone=device.sessionStatus==='healthy'?'healthy':device.sessionStatus==='refresh_pending'?'degraded':'unhealthy';
  return `<span class="health-badge ${tone}">${labels[device.sessionStatus]||'Reauthorization required'}</span>`;
}
function deviceSessionLine(device){
  const expiry=device.upstreamExpiresAt?`Gym session until ${moment(device.upstreamExpiresAt)}`:'Gym session expiry unknown';
  const renewed=device.lastReauthAt?`renewed ${moment(device.lastReauthAt)}`:device.lastRefreshAt?`refreshed ${moment(device.lastRefreshAt)}`:'not renewed yet';
  return `${expiry} · ${renewed}`;
}
function devicesView(){
  const renewal=ownerSession?.scheduledReauthEnabled;
  const sessionRows=`${ownerSession?`<li class="item-row"><div class="item-text"><strong>Shared gym session</strong><small>${escapeHtml(deviceSessionLine(ownerSession))}</small></div>${sessionBadge(ownerSession)}</li>`:''}<li class="item-row"><div class="item-text"><strong>Automatic renewal</strong><small>${renewal?`On · next full login ${ownerSession.nextReauthAt?moment(ownerSession.nextReauthAt):'pending'}`:'Off · signs in again server-side at most every three days'}</small></div><button type="button" class="pill${renewal?' danger':''}" data-action="${renewal?'renewal-off':'renewal-on'}">${renewal?'Turn off':'Turn on'}</button></li>`;
  const rows=devices.map(device=>`<li class="item-row"><span class="item-icon">${ICONS.device}</span><div class="item-text"><strong>${escapeHtml(device.name)}</strong><small>${device.revokedAt?'Revoked':`${device.expiresAt?`Expires ${day(device.expiresAt)}`:'Never expires'} · ${device.lastUsedAt?`used ${moment(device.lastUsedAt)}`:'never used'}`}</small><small>${device.targets.length?device.targets.map(target=>escapeHtml(target.name)).join(', '):'All doors and sequences'}</small></div>${device.revokedAt?'<span class="health-badge">Revoked</span>':sessionBadge(device)}${iconButton(`data-device-menu="${device.id}"`,`More for ${device.name}`)}</li>`).join('');
  return `<div class="split"><section class="stack"><h2 class="section-title">Session</h2><ul class="group">${sessionRows}</ul></section><section class="stack"><h2 class="section-title">Credentials</h2>${rows?`<ul class="group">${rows}</ul>`:emptyState('No device credentials. Create one for each iPhone that opens doors from Shortcuts.')}</section></div>`;
}
function deviceMenu(id){
  const device=devices.find(item=>item.id===id);if(!device)return;
  openSheet(`<div class="dialog-body"><h2>${escapeHtml(device.name)}</h2><p>${escapeHtml(deviceSessionLine(device))}</p><div class="menu-list"><button type="button" data-action="rename-device" data-id="${id}">Rename</button><button type="button" data-action="reauthorize-device" data-id="${id}">Reauthorize</button><button type="button" data-action="rotate-device" data-id="${id}">Rotate credential</button><button type="button" class="danger" data-action="revoke-device" data-id="${id}">Revoke</button></div><p class="sheet-result" data-result role="alert"></p><button type="button" data-action="close-sheet">Cancel</button></div>`);
}
function newDeviceSheet(){
  const targets=[...readers.map(item=>({type:'door',...item})),...sequences.map(item=>({type:'sequence',...item}))];
  const allowlist=targets.map(item=>`<label class="check-row"><input type="checkbox" name="target" value="${item.type}:${escapeHtml(item.id)}">${escapeHtml(item.name)}</label>`).join('');
  openSheet(`<form id="device-form" class="dialog-body"><h2>New credential</h2><p>For iPhone Shortcuts. It can open only what you allow here.</p><label class="field">Device name<input name="name" value="My iPhone" maxlength="40" required></label><label class="field">Expires after<select name="expiresInDays"><option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option><option value="never">Never (credential only)</option></select></label><fieldset><legend>Allowed (none means all)</legend>${allowlist||'<p>No doors saved.</p>'}</fieldset><p class="sheet-result" data-result role="alert"></p><div class="dialog-actions"><button type="button" data-action="close-sheet">Cancel</button><button class="primary" type="submit">Create</button></div></form>`);
}
function credentialSheet(credential){openSheet(`<div class="dialog-body"><h2>Copy this credential now</h2><p>It is shown once and cannot be recovered.</p><code class="credential">${escapeHtml(credential)}</code><p class="sheet-result" data-result role="status"></p><div class="dialog-actions"><button type="button" data-action="close-sheet">Done</button><button type="button" class="primary" data-action="copy-credential" data-credential="${escapeHtml(credential)}">Copy</button></div></div>`)}
function renewalSheet(){openSheet(`<form id="scheduled-reauth-form" class="dialog-body"><h2>Automatic renewal</h2><p>Your STC login is stored encrypted on the server and used for a full sign-in at most every three days.</p><label class="field">Email<input name="username" type="email" autocomplete="username" required></label><label class="field">Password<input name="password" type="password" autocomplete="current-password" required></label><p class="sheet-result" data-result role="alert"></p><div class="dialog-actions"><button type="button" data-action="close-sheet">Cancel</button><button class="primary" type="submit">Turn on</button></div></form>`)}
function renameSheet(device){openSheet(`<form id="rename-form" class="dialog-body" data-id="${device.id}"><h2>Rename</h2><label class="field">Device name<input name="name" value="${escapeHtml(device.name)}" maxlength="40" required></label><p class="sheet-result" data-result role="alert"></p><div class="dialog-actions"><button type="button" data-action="close-sheet">Cancel</button><button class="primary" type="submit">Save</button></div></form>`)}

// ---------- shell

const PAGES={
  doors:{title:'Doors',note:'Open a door, or run a sequence of them.',action:['add-door','Add door']},
  sequences:{title:'Sequences',note:'Doors opened in order, with a wait between each.',action:['new-sequence','New sequence']},
  devices:{title:'Devices',note:'Credentials for iPhone Shortcuts, and the shared gym session.',action:['new-device','New credential']},
};
function appView(){if(activeTab==='doors')return doorsView();if(activeTab==='sequences')return sequencesView();return devicesView()}
// The sidebar (desktop) and the bottom bar (phone) are the same tabs; CSS shows one of them.
function navigation(className){return TAB_ITEMS.map(item=>`<button type="button" data-tab="${item.id}" class="${className}${activeTab===item.id?' active':''}" ${activeTab===item.id?'aria-current="page"':''}>${item.icon}<span>${item.label}</span></button>`).join('')}

function view(){
  document.body.classList.toggle('signed-out',!session);
  if(!session){app.innerHTML=loginView();return}
  const page=PAGES[activeTab],[action,actionLabel]=page.action;
  const actionDisabled=action==='new-sequence'&&(!readers.length||sequenceDraft);
  const notices=`${loadError?`<p class="notice error" role="alert">${escapeHtml(loadError)}</p>`:''}${session.passageEnabled||activeTab!=='doors'?'':'<p class="notice">Door opening is turned off on the server.</p>'}`;
  app.innerHTML=`<aside class="shell-chrome"><div class="side-brand"><img src="/icon-192.png" alt="" width="28" height="28"><span>STC</span></div><nav class="side-nav" aria-label="Main navigation">${navigation('nav-link')}</nav><div class="side-foot">${tools()}</div></aside><header class="mobile-header"><span class="mobile-title">${page.title}</span>${tools()}</header><main class="page-main"><div class="page-wrap page-${activeTab}"><header class="page-head"><div><h1 class="page-title">${page.title}</h1><p class="page-note">${page.note}</p></div><button type="button" class="primary head-action" data-action="${action}" ${actionDisabled?'disabled':''}>${ICONS.plus}<span>${actionLabel}</span></button></header>${notices}${appView()}</div></main><nav class="bottom-nav" aria-label="Main navigation">${navigation('bottom-link')}</nav>`;
}

async function loadSession(){const data=await request('/api/session');session=data.authenticated?{csrfToken:data.csrfToken,expiresAt:data.expiresAt,passageEnabled:data.passageEnabled}:null}
async function loadApp(){loadError='';try{const [readerData,sequenceData,defaultData,deviceData]=await Promise.all([request('/api/readers'),request('/api/sequences'),request('/api/default'),request('/api/device-sessions')]);readers=readerData.readers;sequences=sequenceData.sequences;devices=deviceData.devices;ownerSession=deviceData.ownerSession;defaultSelection=defaultData.defaultSelection}catch(error){if(error.status===401){session=null;return}readers=[];sequences=[];devices=[];ownerSession=null;loadError=error.message}}
async function refresh(message){await loadApp();view();if(message)setResult(message,'success')}
async function start(){try{await loadSession()}catch{session=null}if(session)await loadApp();view();const remaining=Math.max(0,700-(performance.now()-launchStartedAt));setTimeout(()=>document.body.classList.remove('launching'),remaining)}
async function logout(){try{await mutate('/api/logout','POST')}catch{}closeSheet();session=null;readers=[];sequences=[];devices=[];ownerSession=null;defaultSelection=null;activeTab='doors';loginError='';loadError='';sequenceDraft=null;view()}

document.addEventListener('click',async event=>{
  const target=event.target.closest('button');if(!target||target.disabled)return;
  if(target.dataset.tab){activeTab=target.dataset.tab;sequenceDraft=null;setResult('');view();return}
  if(target.dataset.open){runItem(target.dataset.open,target);return}
  if(target.dataset.menu){itemMenu(target.dataset.menu);return}
  if(target.dataset.deviceMenu){deviceMenu(target.dataset.deviceMenu);return}
  if(target.dataset.editSequence){const sequence=sequences.find(item=>item.id===target.dataset.editSequence);sequenceDraft={id:sequence.id,name:sequence.name,steps:sequence.steps.map(step=>({...step}))};view();return}
  const step=target.closest('[data-step]');
  if(step&&target.dataset.move){captureSequenceDraft();const index=Number(step.dataset.step),next=target.dataset.move==='up'?index-1:index+1;[sequenceDraft.steps[index],sequenceDraft.steps[next]]=[sequenceDraft.steps[next],sequenceDraft.steps[index]];view();return}
  if(step&&target.hasAttribute('data-remove-step')){captureSequenceDraft();sequenceDraft.steps.splice(Number(step.dataset.step),1);view();return}
  if(target.id==='add-step'){captureSequenceDraft();sequenceDraft.steps.push({doorName:readers[0]?.name||'',delaySeconds:0});view();return}
  if(target.id==='cancel-sequence'){sequenceDraft=null;view();return}
  const action=target.dataset.action,key=target.dataset.key,id=target.dataset.id;
  if(!action)return;
  try{
    if(action==='close-sheet')closeSheet();
    else if(action==='logout')logout();
    else if(action==='theme')toggleTheme();
    else if(action==='install')installSheet();
    else if(action==='install-now'){const offer=installPrompt;installPrompt=null;closeSheet();offer?.prompt()}
    else if(action==='add-door')addDoorSheet();
    else if(action==='new-sequence'){sequenceDraft=blankDraft();view()}
    else if(action==='new-device')newDeviceSheet();
    else if(action==='renewal-on')renewalSheet();
    else if(action==='renewal-off')confirmSheet('Turn off automatic renewal?','The stored encrypted login is deleted.','Turn off',async()=>{await mutate('/api/scheduled-reauth','DELETE');await loadSession();await refresh('Automatic renewal turned off.')});
    else if(action==='make-default'){const {type,item}=findItem(key);const saved=await mutate('/api/default','PUT',{type,name:item.name});defaultSelection=saved.defaultSelection;closeSheet();view();setResult(`${item.name} is the default.`,'success')}
    else if(action==='edit-sequence'){const {item}=findItem(key);sequenceDraft={id:item.id,name:item.name,steps:item.steps.map(entry=>({...entry}))};activeTab='sequences';closeSheet();view()}
    else if(action==='ask-delete'){const {type,item}=findItem(key);confirmSheet(`Delete ${item.name}?`,type==='door'?'Sequences and credentials that use this door stop working with it.':'This sequence is removed for good.','Delete',async()=>{await mutate(`/api/${type==='door'?'readers':'sequences'}/${item.id}`,'DELETE',{confirmed:true});await refresh('Deleted.')})}
    else if(action==='rename-device')renameSheet(devices.find(item=>item.id===id));
    else if(action==='reauthorize-device'){await mutate(`/api/device-sessions/${id}/reauthorize`,'POST');closeSheet();await refresh('Reauthorized.')}
    else if(action==='rotate-device')confirmSheet('Rotate this credential?','The old one stops working immediately.','Rotate',async()=>{const data=await mutate(`/api/device-sessions/${id}/rotate`,'POST');await refresh();credentialSheet(data.credential);return true});
    else if(action==='revoke-device')confirmSheet('Revoke this credential?','The device can no longer open doors.','Revoke',async()=>{await mutate(`/api/device-sessions/${id}`,'DELETE');await refresh('Revoked.')});
    else if(action==='copy-credential'){await navigator.clipboard.writeText(target.dataset.credential);setResult('Copied.','success')}
  }catch(cause){if(cause.status===401){closeSheet();session=null;view();return}setResult(cause.message,'error')}
});

document.addEventListener('submit',async event=>{
  event.preventDefault();
  const form=event.target,button=form.querySelector('button[type="submit"]'),data=new FormData(form);
  if(!form.reportValidity())return;
  button.disabled=true;
  try{
    if(form.id==='login-view'){loginError='';try{await request('/api/login',{method:'POST',body:JSON.stringify({username:data.get('username'),password:data.get('password')})})}catch(cause){loginError=cause.message;view();return}await loadSession();if(session)await loadApp();view();return}
    if(form.id==='confirm-form'){const keepOpen=await pendingConfirm?.();if(!keepOpen)closeSheet();return}
    if(form.id==='create-view'){await mutate('/api/readers','POST',{name:data.get('name'),major:data.get('major'),minor:data.get('minor')});closeSheet();activeTab='doors';await refresh('Door saved.');return}
    if(form.id==='scheduled-reauth-form'){await mutate('/api/scheduled-reauth','POST',{username:data.get('username'),password:data.get('password')});closeSheet();await loadSession();await refresh('Automatic renewal turned on.');return}
    if(form.id==='rename-form'){await mutate(`/api/device-sessions/${form.dataset.id}`,'PATCH',{name:data.get('name')});closeSheet();await refresh('Renamed.');return}
    if(form.id==='device-form'){const targets=data.getAll('target').map(value=>{const [type,id]=String(value).split(':');return {type,id}}),expiry=data.get('expiresInDays');const created=await mutate('/api/device-sessions','POST',{name:data.get('name'),expiresInDays:expiry==='never'?'never':Number(expiry),targets});await refresh();credentialSheet(created.credential);return}
    if(form.id==='sequence-form'){const rows=[...form.querySelectorAll('[data-step]')],steps=rows.map((row,index)=>({doorName:row.querySelector('[name="doorName"]').value,delaySeconds:index===rows.length-1?0:Number(row.querySelector('[name="delaySeconds"]').value)}));await mutate(sequenceDraft.id?`/api/sequences/${sequenceDraft.id}`:'/api/sequences',sequenceDraft.id?'PATCH':'POST',{name:data.get('name'),steps});sequenceDraft=null;await refresh('Sequence saved.');return}
  }catch(cause){if(cause.status===401){closeSheet();session=null;view();return}setResult(cause.message,'error')}
  finally{if(button.isConnected)button.disabled=false}
});

window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event});
if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}),{once:true});
void start();

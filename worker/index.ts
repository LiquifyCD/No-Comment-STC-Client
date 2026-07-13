import { validatePassageAttempt } from './passage-policy.mjs';
import { validateReaderName } from './reader-model.mjs';
import { parseReaderCatalog } from './reader-catalog.mjs';
import { sendDoorRequest, lookupPassageReader } from './door-service.mjs';
import { validateReaderCreation } from './reader-request.mjs';
import { runOpenDoorFlow } from './open-door-flow.mjs';
import { runCreateReaderFlow } from './create-reader-flow.mjs';
import { encryptJson, decryptJson } from './secret-box.mjs';
import { saveConfiguredReader } from './configured-reader-store.mjs';
import { acquirePassageCooldown } from './passage-cooldown.mjs';
import { deleteOwnedReader, validateReaderDeletion } from './reader-deletion.mjs';
import { validateExternalOpenRequest } from './external-api-policy.mjs';
import { runSequenceSteps, validateSequenceInput } from './sequence-model.mjs';
import { getDefaultSelection, resolveSequenceReaders } from './sequence-store.mjs';

type Session = { accessToken:string; refreshToken?:string; customerId:string; expiresAt:number; upstreamCookie?:string; csrfToken:string };
type PassageCredentials = { accessToken:string; customerId:string; upstreamCookie?:string };
type ActiveSession = { id:string; data:Session };
type ReaderRow = { id:string; name:string; card_reader:number; created_at:string; last_opened_at:string|null };
type SequenceRow = { id:string; name:string; created_at:string; updated_at:string };
type SequenceStepRow = { sequence_id:string; position:number; reader_id:string; reader_name:string; delay_after_ms:number; config_ciphertext?:string };

const JSON_HEADERS = { 'content-type':'application/json', 'cache-control':'no-store', 'x-content-type-options':'nosniff' };
const UPSTREAM_HEADERS = { accept:'application/json', 'content-type':'application/json', 'x-request-source':'mobilityapp', 'accept-language':'sv-SE' };
const REQUEST_ID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function response(data:unknown,status=200,extra:HeadersInit={}) { return new Response(JSON.stringify(data),{status,headers:{...JSON_HEADERS,...extra,'content-security-policy':"default-src 'none'; frame-ancestors 'none'"}}); }
function errorResponse(error:string,status:number) { return response({error},status); }
function cookie(request:Request,name:string) { return (request.headers.get('cookie')??'').split(';').map(value=>value.trim()).find(value=>value.startsWith(`${name}=`))?.slice(name.length+1); }
function sessionCookie(id:string,maxAge:number) { return `brp_session=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`; }
function clearCookie() { return 'brp_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'; }
function bytesToBase64(bytes:Uint8Array) { let value=''; for(const byte of bytes)value+=String.fromCharCode(byte); return btoa(value); }
function base64ToBytes(value:string) { return Uint8Array.from(atob(value),character=>character.charCodeAt(0)); }
async function sessionKey(secret:string) { const raw=base64ToBytes(secret); if(raw.byteLength!==32)throw new Error('Invalid session key'); return crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']); }
async function encrypt(value:Session,secret:string) { const iv=crypto.getRandomValues(new Uint8Array(12)); const plain=new TextEncoder().encode(JSON.stringify(value)); const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},await sessionKey(secret),plain); return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipher))}`; }
async function decrypt(value:string,secret:string):Promise<Session> { const [iv,cipher]=value.split('.'); if(!iv||!cipher)throw new Error('Invalid session'); const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:base64ToBytes(iv)},await sessionKey(secret),base64ToBytes(cipher)); return JSON.parse(new TextDecoder().decode(plain)) as Session; }
async function getSession(request:Request,env:Env):Promise<ActiveSession|null> { const id=cookie(request,'brp_session'); if(!id)return null; const stored=await env.SESSIONS.get(id); if(!stored)return null; try{return{id,data:await decrypt(stored,env.SESSION_ENCRYPTION_KEY)}}catch{await env.SESSIONS.delete(id);return null} }
function upstreamCookie(headers:Headers) { return headers.get('set-cookie')?.split(';',1)[0]; }
function sameOrigin(request:Request) { return request.headers.get('origin')===new URL(request.url).origin; }
function passageEnabled(value:string) { return value.toLowerCase()==='true'; }
function safeEqual(a:string,b:string) { const aa=new TextEncoder().encode(a),bb=new TextEncoder().encode(b); if(aa.length!==bb.length)return false; let difference=0; for(let index=0;index<aa.length;index++)difference|=aa[index]^bb[index]; return difference===0; }
async function ownerId(customerId:string,secret:string) { const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']); return bytesToBase64(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(customerId)))).replace(/[+/=]/g,''); }
function serializeReader(row:ReaderRow) { return {id:row.id,name:row.name,createdAt:row.created_at,lastOpenedAt:row.last_opened_at}; }
function serializeSequences(rows:SequenceRow[],steps:SequenceStepRow[]) { return rows.map(row=>({id:row.id,name:row.name,createdAt:row.created_at,updatedAt:row.updated_at,steps:steps.filter(step=>step.sequence_id===row.id).sort((a,b)=>a.position-b.position).map(step=>({doorName:step.reader_name,delaySeconds:step.delay_after_ms/1000}))})).filter(sequence=>sequence.steps.length>0); }
function isUniqueError(error:unknown) { return error instanceof Error && /UNIQUE constraint failed/i.test(error.message); }
function readerCatalog(env:Env) { return parseReaderCatalog(env.READER_CATALOG,0); }

async function requireSession(request:Request,env:Env):Promise<{error:Response}|{active:ActiveSession;owner:string}> { const active=await getSession(request,env); if(!active)return {error:errorResponse('Inte inloggad.',401)}; return {active,owner:await ownerId(active.data.customerId,env.SESSION_ENCRYPTION_KEY)}; }
async function verifyMutation(request:Request,active:ActiveSession,env:Env) { if(!sameOrigin(request))return errorResponse('Otillåtet ursprung.',403); const token=request.headers.get('x-csrf-token')??'',expected=await ownerId(`csrf:${active.id}`,env.SESSION_ENCRYPTION_KEY); if(!token||!safeEqual(token,expected))return errorResponse('Ogiltig CSRF-token.',403); return null; }

async function sequenceRows(env:Env,owner:string) {
 const rows=await env.DB.prepare('SELECT id,name,created_at,updated_at FROM sequences WHERE owner_id=? ORDER BY updated_at DESC').bind(owner).all<SequenceRow>();
 const steps=await env.DB.prepare('SELECT ss.sequence_id,ss.position,ss.reader_id,r.name AS reader_name,ss.delay_after_ms FROM sequence_steps ss JOIN sequences s ON s.id=ss.sequence_id JOIN readers r ON r.id=ss.reader_id AND r.owner_id=s.owner_id WHERE s.owner_id=? ORDER BY ss.sequence_id,ss.position').bind(owner).all<SequenceStepRow>();
 return serializeSequences(rows.results,steps.results);
}

async function storedSequenceSteps(env:Env,owner:string,sequenceId:string) {
 const sequence=await env.DB.prepare('SELECT id,name FROM sequences WHERE id=? AND owner_id=?').bind(sequenceId,owner).first<{id:string;name:string}>();if(!sequence)return null;
 const steps=await env.DB.prepare('SELECT ss.sequence_id,ss.position,ss.reader_id,r.name AS reader_name,ss.delay_after_ms,r.config_ciphertext FROM sequence_steps ss JOIN readers r ON r.id=ss.reader_id WHERE ss.sequence_id=? AND r.owner_id=? ORDER BY ss.position').bind(sequenceId,owner).all<SequenceStepRow>();
 return steps.results.length?{...sequence,steps:steps.results.map(step=>({readerId:step.reader_id,delayAfterMs:step.delay_after_ms}))}:null;
}

async function ensureDefaultReader(env:Env,owner:string) {
 const migrated=await env.DB.prepare('SELECT owner_id FROM reader_migrations WHERE owner_id=?').bind(owner).first();
 if(migrated)return;
 const catalog=readerCatalog(env); if(!catalog.ok)throw new Error(catalog.error);
 const now=new Date().toISOString(),id=crypto.randomUUID(),cardReader=catalog.entries[0].code;
 await env.DB.batch([
  env.DB.prepare('INSERT OR IGNORE INTO readers(id,owner_id,name,name_key,card_reader,created_at,last_opened_at) VALUES(?,?,?,?,?,?,NULL)').bind(id,owner,'Main entrance','main entrance',cardReader,now),
  env.DB.prepare('INSERT OR IGNORE INTO reader_migrations(owner_id,migrated_at) VALUES(?,?)').bind(owner,now),
 ]);
}

async function login(request:Request,env:Env) {
 const body=await request.json() as {username?:string,password?:string}; if(!body.username?.trim()||!body.password)return errorResponse('Användarnamn och lösenord krävs.',400);
 const config=await fetch(`${env.BRP_BASE_URL}/apps/${env.BRP_APP_ID}?allowMultipleCompaniesAndBusinessUnits=true`,{headers:UPSTREAM_HEADERS}); if(!config.ok)return errorResponse('BRP-konfigurationen kunde inte hämtas.',502);
 const affinity=upstreamCookie(config.headers);
 const auth=await fetch(`${env.BRP_BASE_URL}/auth/login`,{method:'POST',headers:{...UPSTREAM_HEADERS,...(affinity?{cookie:affinity}:{})},body:JSON.stringify({username:body.username.trim(),password:body.password})});
 if(!auth.ok)return errorResponse(auth.status===401?'Fel användarnamn eller lösenord.':'Inloggningen misslyckades.',auth.status===401?401:502);
 const data=await auth.json() as {access_token:string;refresh_token?:string;username:string;expires_in:number};
 const session:Session={accessToken:data.access_token,refreshToken:data.refresh_token,customerId:data.username,expiresAt:Date.now()+data.expires_in*1000,upstreamCookie:upstreamCookie(auth.headers)??affinity,csrfToken:crypto.randomUUID()};
 const id=crypto.randomUUID(),ttl=Math.max(60,Math.min(data.expires_in,604800)); await env.SESSIONS.put(id,await encrypt(session,env.SESSION_ENCRYPTION_KEY),{expirationTtl:ttl});
 return response({authenticated:true},200,{'set-cookie':sessionCookie(id,ttl)});
}

async function sessionStatus(request:Request,env:Env) { const active=await getSession(request,env); if(!active)return response({authenticated:false}); return response({authenticated:true,expiresAt:new Date(active.data.expiresAt).toISOString(),csrfToken:await ownerId(`csrf:${active.id}`,env.SESSION_ENCRYPTION_KEY),passageEnabled:passageEnabled(env.PASSAGE_ENABLED)&&env.PASSAGE_AUTHORIZATION_ID.startsWith('APPROVED-')}); }
async function listReaders(request:Request,env:Env) { const auth=await requireSession(request,env); if('error'in auth)return auth.error; await ensureDefaultReader(env,auth.owner); const rows=await env.DB.prepare('SELECT id,name,card_reader,created_at,last_opened_at FROM readers WHERE owner_id=? ORDER BY COALESCE(last_opened_at,created_at) DESC').bind(auth.owner).all<ReaderRow>(); return response({readers:rows.results.map(serializeReader)}); }
async function listConfiguredReaders(env:Env) { const rows=await env.DB.prepare('SELECT id,name FROM readers WHERE config_ciphertext IS NOT NULL ORDER BY created_at DESC').all<{id:string;name:string}>(); return response({readers:rows.results}); }
async function executeStoredReader(env:Env,owner:string,session:PassageCredentials,readerId:string,eventType:string) {
 const reader=await env.DB.prepare('SELECT card_reader,config_ciphertext FROM readers WHERE id=? AND owner_id=? AND (config_ciphertext IS NOT NULL OR card_reader>0)').bind(readerId,owner).first<{card_reader:number;config_ciphertext:string|null}>();
 if(!reader)return {ok:false as const,status:404,error:'Dörren hittades inte.'};
 let cardReader=reader.card_reader;
 if(!cardReader){
  if(!reader.config_ciphertext)return {ok:false as const,status:404,error:'Dörren hittades inte.'};
  const beacon=await decryptJson<{major:string;minor:string}>(reader.config_ciphertext,env.SESSION_ENCRYPTION_KEY);
  const lookup=await lookupPassageReader({fetcher:fetch,baseUrl:env.BRP_BASE_URL,major:beacon.major,minor:beacon.minor,cookie:session.upstreamCookie});
  if(!lookup.ok)return {ok:false as const,status:lookup.status,error:lookup.status===404?'Dörren hittades inte hos BRP.':'Dörruppslagningen misslyckades.'};
  cardReader=lookup.cardReader;
 }
 const now=Date.now();if(!await acquirePassageCooldown({db:env.DB,owner,readerId,now}))return {ok:false as const,status:429,error:'Vänta 1 sekund innan nästa försök.'};
 const upstream=await sendDoorRequest({fetcher:fetch,baseUrl:env.BRP_BASE_URL,customerId:session.customerId,cardReader,accessToken:session.accessToken,cookie:session.upstreamCookie});
 const timestamp=new Date(now).toISOString(),auditId=crypto.randomUUID(),outcome=upstream.ok?'accepted':'rejected';
 await env.DB.prepare('INSERT INTO reader_events(id,reader_id,owner_id,event_type,data_json,created_at) VALUES(?,?,?,?,?,?)').bind(auditId,readerId,owner,eventType,JSON.stringify({outcome,status:upstream.status}),timestamp).run();
 return upstream.ok?{ok:true as const,timestamp}:{ok:false as const,status:upstream.status===401?401:502,error:'Dörrförsöket avvisades.'};
}
async function createConfiguredReader(request:Request,env:Env) {
 const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)return errorResponse('Forbidden.',403);
 const length=Number(request.headers.get('content-length')??0);if(length>2048)return errorResponse('Invalid request.',413);
 let body:unknown;try{body=await request.json()}catch{return errorResponse('Invalid request.',400)}
 const result=await runCreateReaderFlow({fetcher:fetch,baseUrl:env.BRP_BASE_URL,appId:env.BRP_APP_ID,body});if(!result.ok)return errorResponse(result.error,result.status);
 const owner=await ownerId(result.customerId,env.SESSION_ENCRYPTION_KEY),id=crypto.randomUUID(),now=new Date().toISOString();
 const ciphertext=await encryptJson({major:result.major,minor:result.minor},env.SESSION_ENCRYPTION_KEY);
 const savedId=await saveConfiguredReader({db:env.DB,id,owner,name:result.name,nameKey:result.nameKey,now,ciphertext});
 if(!savedId)return errorResponse('A reader with that name already exists.',409);
 return response({reader:{id:savedId,name:result.name}},201);
}
async function openDoor(request:Request,env:Env) {
 const url=new URL(request.url),clientKey=await ownerId(`open:${request.headers.get('cf-connecting-ip')??'unknown'}`,env.SESSION_ENCRYPTION_KEY),rateKey=`open-rate:${clientKey}`,now=Date.now(),recentRaw=await env.SESSIONS.get(rateKey);
 const access=validateExternalOpenRequest({protocol:url.protocol,origin:request.headers.get('origin'),expectedOrigin:url.origin,apiKey:request.headers.get('x-api-key')??'',expectedApiKey:env.OPEN_DOOR_API_KEY,recentAt:recentRaw?Number(recentRaw):null,now});if(!access.ok)return errorResponse(access.error,access.status);
 const length=Number(request.headers.get('content-length')??0); if(length>2048)return errorResponse('Invalid request.',413);
 let body:unknown; try{body=await request.json()}catch{return errorResponse('Invalid request.',400)}
 if(!passageEnabled(env.PASSAGE_ENABLED)||!env.PASSAGE_AUTHORIZATION_ID.startsWith('APPROVED-'))return errorResponse('Door opening is disabled.',503);
 await env.SESSIONS.put(rateKey,String(now),{expirationTtl:60});
 const resolveTarget=async(customerId:string,type:'door'|'sequence',nameKey:string)=>{const owner=await ownerId(customerId,env.SESSION_ENCRYPTION_KEY);if(type==='door'){const rows=await env.DB.prepare('SELECT id FROM readers WHERE owner_id=? AND name_key=? AND (config_ciphertext IS NOT NULL OR card_reader>0) LIMIT 2').bind(owner,nameKey).all<{id:string}>();if(rows.results.length>1)return {ambiguous:true as const};return rows.results[0]?{id:rows.results[0].id,type:'door' as const,steps:[{readerId:rows.results[0].id,delayAfterMs:0}]}:null}const rows=await env.DB.prepare('SELECT id FROM sequences WHERE owner_id=? AND name_key=? LIMIT 2').bind(owner,nameKey).all<{id:string}>();if(rows.results.length>1)return {ambiguous:true as const};if(!rows.results[0])return null;const stored=await storedSequenceSteps(env,owner,rows.results[0].id);return stored?{id:stored.id,type:'sequence' as const,steps:stored.steps}:null};
 const executeTarget=async(auth:{customerId:string;accessToken:string;cookie?:string},target:{id:string;type:'door'|'sequence';steps:Array<{readerId:string;delayAfterMs:number}>})=>{const owner=await ownerId(auth.customerId,env.SESSION_ENCRYPTION_KEY),credentials={customerId:auth.customerId,accessToken:auth.accessToken,upstreamCookie:auth.cookie};const executed=await runSequenceSteps({steps:target.steps,openStep:async step=>executeStoredReader(env,owner,credentials,step.readerId,'api_passage'),wait:ms=>new Promise(resolve=>setTimeout(resolve,ms))});if(target.type==='sequence'){const timestamp=new Date().toISOString();await env.DB.prepare('INSERT INTO sequence_events(id,sequence_id,owner_id,outcome,completed_steps,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),target.id,owner,executed.ok?'accepted':'rejected',executed.completedSteps,timestamp).run()}return executed};
 const result=await runOpenDoorFlow({fetcher:fetch,baseUrl:env.BRP_BASE_URL,appId:env.BRP_APP_ID,body,resolveTarget,executeTarget,enabled:true,authorizationId:env.PASSAGE_AUTHORIZATION_ID});
 console.log(JSON.stringify({event:'open_door_result',status:result.status,ok:result.ok}));
 if(!result.ok)return response({error:result.error,...(result.failedStep?{failedStep:result.failedStep,completedSteps:result.completedSteps}:{})},result.status);
 return response({ok:true,message:'Request completed.',completedSteps:result.completedSteps,timestamp:new Date().toISOString()},200);
}
async function createReader(request:Request,env:Env) {
 const auth=await requireSession(request,env); if('error'in auth)return auth.error;
 const invalid=await verifyMutation(request,auth.active,env); if(invalid)return invalid;
 const body=await request.json() as unknown;
 const valid=validateReaderCreation(body);
 if(!valid.ok)return errorResponse(valid.error,valid.status);
 const id=crypto.randomUUID(),now=new Date().toISOString();
 const ciphertext=await encryptJson({major:valid.major,minor:valid.minor},env.SESSION_ENCRYPTION_KEY);
 const savedId=await saveConfiguredReader({db:env.DB,id,owner:auth.owner,name:valid.name,nameKey:valid.nameKey,now,ciphertext});
 if(!savedId)return errorResponse('En läsare med samma namn finns redan.',409);
 return response({reader:{id:savedId,name:valid.name,createdAt:now,lastOpenedAt:now}},201);
}
async function listSequences(request:Request,env:Env) { const auth=await requireSession(request,env);if('error'in auth)return auth.error;return response({sequences:await sequenceRows(env,auth.owner)}); }
async function saveSequence(request:Request,env:Env,sequenceId?:string) {
 const auth=await requireSession(request,env);if('error'in auth)return auth.error;const invalid=await verifyMutation(request,auth.active,env);if(invalid)return invalid;
 let body:unknown;try{body=await request.json()}catch{return errorResponse('Ogiltig JSON.',400)}const valid=validateSequenceInput(body);if(!valid.ok)return errorResponse(valid.error,valid.status);
 const resolved=await resolveSequenceReaders({db:env.DB,owner:auth.owner,steps:valid.steps});if(!resolved.ok)return errorResponse(resolved.error,resolved.status);
 const id=sequenceId??crypto.randomUUID(),now=new Date().toISOString();
 if(sequenceId){const existing=await env.DB.prepare('SELECT id FROM sequences WHERE id=? AND owner_id=?').bind(id,auth.owner).first();if(!existing)return errorResponse('Sekvensen hittades inte.',404)}
 const statements=sequenceId
  ?[env.DB.prepare('UPDATE sequences SET name=?,name_key=?,updated_at=? WHERE id=? AND owner_id=?').bind(valid.name,valid.nameKey,now,id,auth.owner),env.DB.prepare('DELETE FROM sequence_steps WHERE sequence_id=?').bind(id)]
  :[env.DB.prepare('INSERT INTO sequences(id,owner_id,name,name_key,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind(id,auth.owner,valid.name,valid.nameKey,now,now)];
 for(const step of resolved.steps)statements.push(env.DB.prepare('INSERT INTO sequence_steps(sequence_id,position,reader_id,delay_after_ms) VALUES(?,?,?,?)').bind(id,step.position,step.readerId,step.delayAfterMs));
 try{await env.DB.batch(statements)}catch(error){if(isUniqueError(error))return errorResponse('En sekvens med samma namn finns redan.',409);throw error}
 const saved=(await sequenceRows(env,auth.owner)).find(sequence=>sequence.id===id);return response({sequence:saved},sequenceId?200:201);
}
async function deleteSequence(request:Request,env:Env,sequenceId:string) {
 const auth=await requireSession(request,env);if('error'in auth)return auth.error;const invalid=await verifyMutation(request,auth.active,env);if(invalid)return invalid;
 let body:{confirmed?:unknown};try{body=await request.json() as {confirmed?:unknown}}catch{return errorResponse('Ogiltig JSON.',400)}if(body.confirmed!==true)return errorResponse('Borttagningen måste bekräftas.',400);
 const result=await env.DB.prepare('DELETE FROM sequences WHERE id=? AND owner_id=?').bind(sequenceId,auth.owner).run();if(!result.meta.changes)return errorResponse('Sekvensen hittades inte.',404);
 await env.DB.prepare("DELETE FROM user_preferences WHERE owner_id=? AND default_type='sequence' AND default_id=?").bind(auth.owner,sequenceId).run();return response({deleted:true});
}
async function defaultSelection(request:Request,env:Env) {
 const auth=await requireSession(request,env);if('error'in auth)return auth.error;
 return response({defaultSelection:await getDefaultSelection({db:env.DB,owner:auth.owner})});
}
async function setDefaultSelection(request:Request,env:Env) {
 const auth=await requireSession(request,env);if('error'in auth)return auth.error;const invalid=await verifyMutation(request,auth.active,env);if(invalid)return invalid;
 let body:{type?:unknown;name?:unknown};try{body=await request.json() as {type?:unknown;name?:unknown}}catch{return errorResponse('Ogiltig JSON.',400)}if(body.type!=='door'&&body.type!=='sequence')return errorResponse('Ogiltig standardtyp.',400);
 const valid=validateReaderName(body.name);if(!valid.ok)return errorResponse(valid.error,400);const query=body.type==='door'?'SELECT id FROM readers WHERE owner_id=? AND name_key=? LIMIT 2':'SELECT s.id FROM sequences s WHERE s.owner_id=? AND s.name_key=? AND EXISTS(SELECT 1 FROM sequence_steps ss JOIN readers r ON r.id=ss.reader_id AND r.owner_id=s.owner_id WHERE ss.sequence_id=s.id) LIMIT 2';const rows=await env.DB.prepare(query).bind(auth.owner,valid.nameKey).all<{id:string}>();if(rows.results.length!==1)return errorResponse(rows.results.length?'Namnet är tvetydigt.':'Valet hittades inte.',rows.results.length?409:404);
 const id=rows.results[0].id,now=new Date().toISOString();await env.DB.prepare('INSERT INTO user_preferences(owner_id,default_type,default_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET default_type=excluded.default_type,default_id=excluded.default_id,updated_at=excluded.updated_at').bind(auth.owner,body.type,id,now).run();return response({defaultSelection:{type:body.type,id}});
}
async function runStoredSequence(request:Request,env:Env,sequenceId:string) {
 const auth=await requireSession(request,env);if('error'in auth)return auth.error;const invalid=await verifyMutation(request,auth.active,env);if(invalid)return invalid;
 if(!passageEnabled(env.PASSAGE_ENABLED)||!env.PASSAGE_AUTHORIZATION_ID.startsWith('APPROVED-'))return errorResponse('Passagefunktionen är inte aktiverad.',503);
 let body:{confirmed?:unknown;requestId?:unknown};try{body=await request.json() as {confirmed?:unknown;requestId?:unknown}}catch{return errorResponse('Ogiltig JSON.',400)}if(body.confirmed!==true||typeof body.requestId!=='string'||!REQUEST_ID_PATTERN.test(body.requestId))return errorResponse('Ogiltig begäran.',400);
 const stored=await storedSequenceSteps(env,auth.owner,sequenceId);if(!stored)return errorResponse('Sekvensen hittades inte eller saknar giltiga steg.',404);
 const replayKey=`replay-sequence:${auth.active.id}:${sequenceId}:${body.requestId}`;if(await env.SESSIONS.get(replayKey))return errorResponse('Begäran har redan behandlats.',409);const timestamp=new Date().toISOString();await env.SESSIONS.put(replayKey,timestamp,{expirationTtl:300});
 const result=await runSequenceSteps({steps:stored.steps,openStep:async step=>executeStoredReader(env,auth.owner,auth.active.data,step.readerId,'sequence_passage'),wait:ms=>new Promise(resolve=>setTimeout(resolve,ms))});
 await env.DB.prepare('INSERT INTO sequence_events(id,sequence_id,owner_id,outcome,completed_steps,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),sequenceId,auth.owner,result.ok?'accepted':'rejected',result.completedSteps,timestamp).run();
 if(!result.ok)return response({error:result.error,failedStep:result.failedStep,completedSteps:result.completedSteps,timestamp},result.status);return response({ok:true,completedSteps:result.completedSteps,timestamp,message:'Sekvensen slutfördes.'});
}
async function getReader(request:Request,env:Env,readerId:string) { const auth=await requireSession(request,env); if('error'in auth)return auth.error; const row=await env.DB.prepare('SELECT id,name,card_reader,created_at,last_opened_at FROM readers WHERE id=? AND owner_id=?').bind(readerId,auth.owner).first<ReaderRow>(); if(!row)return errorResponse('Läsaren hittades inte.',404); const now=new Date().toISOString(); await env.DB.prepare('UPDATE readers SET last_opened_at=? WHERE id=? AND owner_id=?').bind(now,readerId,auth.owner).run(); const events=await env.DB.prepare('SELECT id,event_type,data_json,created_at FROM reader_events WHERE reader_id=? AND owner_id=? ORDER BY created_at DESC LIMIT 20').bind(readerId,auth.owner).all<{id:string;event_type:string;data_json:string;created_at:string}>(); return response({reader:{...serializeReader(row),lastOpenedAt:now},events:events.results.map(event=>({id:event.id,type:event.event_type,data:JSON.parse(event.data_json),createdAt:event.created_at}))}); }
async function renameReader(request:Request,env:Env,readerId:string) { const auth=await requireSession(request,env); if('error'in auth)return auth.error; const invalid=await verifyMutation(request,auth.active,env); if(invalid)return invalid; const body=await request.json() as {name?:unknown}; const valid=validateReaderName(body.name); if(!valid.ok)return errorResponse(valid.error,400); try{const result=await env.DB.prepare('UPDATE readers SET name=?,name_key=? WHERE id=? AND owner_id=?').bind(valid.name,valid.nameKey,readerId,auth.owner).run(); if(!result.meta.changes)return errorResponse('Läsaren hittades inte.',404)}catch(error){if(isUniqueError(error))return errorResponse('En läsare med samma namn finns redan.',409);throw error} return response({reader:{id:readerId,name:valid.name}}); }
async function deleteReader(request:Request,env:Env,readerId:string) {
 const active=await getSession(request,env),originMatches=sameOrigin(request);
 let csrfValid=false;
 if(active){const token=request.headers.get('x-csrf-token')??'',expected=await ownerId(`csrf:${active.id}`,env.SESSION_ENCRYPTION_KEY);csrfValid=Boolean(token&&safeEqual(token,expected))}
 const access=validateReaderDeletion({authenticated:Boolean(active),originMatches,csrfValid,confirmed:true});if(!access.ok)return errorResponse(access.error,access.status);
 let body:{confirmed?:unknown};try{body=await request.json() as {confirmed?:unknown}}catch{return errorResponse('Ogiltig begäran.',400)}
 const confirmed=validateReaderDeletion({authenticated:true,originMatches:true,csrfValid:true,confirmed:body.confirmed});if(!confirmed.ok)return errorResponse(confirmed.error,confirmed.status);
 const owner=await ownerId(active!.data.customerId,env.SESSION_ENCRYPTION_KEY),deleted=await deleteOwnedReader({db:env.DB,owner,readerId});
 if(!deleted)return errorResponse('Läsaren hittades inte.',404);
 await env.DB.batch([env.DB.prepare('DELETE FROM sequences WHERE owner_id=? AND NOT EXISTS(SELECT 1 FROM sequence_steps WHERE sequence_steps.sequence_id=sequences.id)').bind(owner),env.DB.prepare("DELETE FROM user_preferences WHERE owner_id=? AND default_type='door' AND default_id=?").bind(owner,readerId),env.DB.prepare("DELETE FROM user_preferences WHERE owner_id=? AND default_type='sequence' AND NOT EXISTS(SELECT 1 FROM sequences WHERE sequences.id=user_preferences.default_id AND sequences.owner_id=user_preferences.owner_id)").bind(owner)]);
 return response({deleted:true});
}
async function passage(request:Request,env:Env,readerId:string) {
 const auth=await requireSession(request,env); if('error'in auth)return auth.error; const invalid=await verifyMutation(request,auth.active,env); if(invalid)return invalid;
 const reader=await env.DB.prepare('SELECT id,name,card_reader,config_ciphertext,created_at,last_opened_at FROM readers WHERE id=? AND owner_id=?').bind(readerId,auth.owner).first<ReaderRow&{config_ciphertext:string|null}>(); if(!reader)return errorResponse('Läsaren hittades inte.',404);
 let allowedReader=reader.card_reader;
 if(!allowedReader){
  if(!reader.config_ciphertext)return errorResponse('Ingen godkänd kortläsare är konfigurerad.',503);
  const beacon=await decryptJson<{major:string;minor:string}>(reader.config_ciphertext,env.SESSION_ENCRYPTION_KEY);
  const lookup=await lookupPassageReader({fetcher:fetch,baseUrl:env.BRP_BASE_URL,major:beacon.major,minor:beacon.minor,cookie:auth.active.data.upstreamCookie});
  if(!lookup.ok)return errorResponse(lookup.status===404?'Läsaren hittades inte hos BRP.':'Läsaruppslagningen misslyckades.',lookup.status);
  allowedReader=lookup.cardReader;
 }
 let body:Record<string,unknown>|null=null; try{body=await request.json() as Record<string,unknown>}catch{return errorResponse('Ogiltig JSON.',400)}
 const requestId=typeof body.requestId==='string'?body.requestId:''; const replayed=Boolean(requestId&&await env.SESSIONS.get(`replay:${auth.active.id}:${readerId}:${requestId}`)); const recentRaw=await env.SESSIONS.get(`rate:${auth.owner}:${readerId}`),now=Date.now();
 const result=validatePassageAttempt({originMatches:true,authenticatedCustomerId:auth.active.data.customerId,body,enabled:passageEnabled(env.PASSAGE_ENABLED),authorizationId:env.PASSAGE_AUTHORIZATION_ID,allowedReader,replayed,recentAt:recentRaw?Number(recentRaw):null,now}); if(!result.ok)return errorResponse(result.error,result.status);
 if(!await acquirePassageCooldown({db:env.DB,owner:auth.owner,readerId,now}))return errorResponse('Vänta 1 sekund innan nästa försök.',429);
 await env.SESSIONS.put(`replay:${auth.active.id}:${readerId}:${result.requestId}`,result.auditTimestamp,{expirationTtl:300}); await env.SESSIONS.put(`rate:${auth.owner}:${readerId}`,String(now),{expirationTtl:60});
 const auditId=crypto.randomUUID(); const upstream=await sendDoorRequest({fetcher:fetch,baseUrl:env.BRP_BASE_URL,customerId:result.customerId,cardReader:result.cardReader,accessToken:auth.active.data.accessToken,cookie:auth.active.data.upstreamCookie}); const outcome=upstream.ok?'accepted':'rejected';
 await env.DB.prepare('INSERT INTO reader_events(id,reader_id,owner_id,event_type,data_json,created_at) VALUES(?,?,?,?,?,?)').bind(auditId,readerId,auth.owner,'passage',JSON.stringify({outcome,status:upstream.status}),result.auditTimestamp).run(); console.log(JSON.stringify({event:'passage_attempt',auditId,readerId,timestamp:result.auditTimestamp,outcome,status:upstream.status}));
 if(!upstream.ok)return response({error:'Passageförsöket avvisades.',auditId,timestamp:result.auditTimestamp},upstream.status===401?401:502); return response({ok:true,auditId,timestamp:result.auditTimestamp,message:'Passageförsöket skickades.'});
}
async function logout(request:Request,env:Env) { const id=cookie(request,'brp_session'); if(id)await env.SESSIONS.delete(id); return response({authenticated:false},200,{'set-cookie':clearCookie()}); }

export default { async fetch(request:Request,env:Env):Promise<Response> {
 try {
  const url=new URL(request.url),path=url.pathname;
  if(path==='/api/login'&&request.method==='POST'){if(!sameOrigin(request))return errorResponse('Otillåtet ursprung.',403);return await login(request,env)}
  if(path==='/api/open-door'&&request.method==='POST')return await openDoor(request,env);
  if(path==='/api/configured-readers'&&request.method==='GET')return await listConfiguredReaders(env);
  if(path==='/api/configured-readers'&&request.method==='POST')return await createConfiguredReader(request,env);
  if(path==='/api/session'&&request.method==='GET')return await sessionStatus(request,env);
  if(path==='/api/readers'&&request.method==='GET')return await listReaders(request,env);
  if(path==='/api/readers'&&request.method==='POST')return await createReader(request,env);
  if(path==='/api/sequences'&&request.method==='GET')return await listSequences(request,env);
  if(path==='/api/sequences'&&request.method==='POST')return await saveSequence(request,env);
  if(path==='/api/default'&&request.method==='GET')return await defaultSelection(request,env);
  if(path==='/api/default'&&request.method==='PUT')return await setDefaultSelection(request,env);
  const sequenceMatch=path.match(/^\/api\/sequences\/([0-9a-f-]{36})(?:\/(run))?$/i);
  if(sequenceMatch){const sequenceId=sequenceMatch[1];if(sequenceMatch[2]==='run'&&request.method==='POST')return await runStoredSequence(request,env,sequenceId);if(!sequenceMatch[2]&&request.method==='PATCH')return await saveSequence(request,env,sequenceId);if(!sequenceMatch[2]&&request.method==='DELETE')return await deleteSequence(request,env,sequenceId)}
  const readerMatch=path.match(/^\/api\/readers\/([0-9a-f-]{36})(?:\/(door|passage))?$/i);
  if(readerMatch){const readerId=readerMatch[1];if((readerMatch[2]==='door'||readerMatch[2]==='passage')&&request.method==='POST')return await passage(request,env,readerId);if(!readerMatch[2]&&request.method==='GET')return await getReader(request,env,readerId);if(!readerMatch[2]&&request.method==='PATCH')return await renameReader(request,env,readerId);if(!readerMatch[2]&&request.method==='DELETE')return await deleteReader(request,env,readerId)}
  if(path==='/api/logout'&&request.method==='POST'){const active=await getSession(request,env);if(!active)return response({authenticated:false});const invalid=await verifyMutation(request,active,env);if(invalid)return invalid;return await logout(request,env)}
  if(path.startsWith('/api/'))return errorResponse('Not found',404);
  if(path==='/readers'||path==='/readers/new'||/^\/readers\/[0-9a-f-]{36}$/i.test(path))return env.ASSETS.fetch(new Request(new URL('/index.html',url),request));
  return env.ASSETS.fetch(request);
 } catch(error) { console.error(JSON.stringify({event:'request_failed',message:error instanceof Error?error.message:'unknown'})); return errorResponse('Ett oväntat fel inträffade.',500); }
}};

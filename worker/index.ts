import {validatePassageAttempt} from './passage-policy.mjs';
type Session={accessToken:string;refreshToken?:string;customerId:string;expiresAt:number;upstreamCookie?:string;csrfToken:string};
const JSON_HEADERS={'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'};
const UPSTREAM_HEADERS={'accept':'application/json','content-type':'application/json','x-request-source':'mobilityapp','accept-language':'sv-SE'};
function response(data:unknown,status=200,extra:HeadersInit={}){return new Response(JSON.stringify(data),{status,headers:{...JSON_HEADERS,...extra,'content-security-policy':"default-src 'none'; frame-ancestors 'none'"}})}
function cookie(request:Request,name:string){return(request.headers.get('cookie')??'').split(';').map(x=>x.trim()).find(x=>x.startsWith(`${name}=`))?.slice(name.length+1)}
function sessionCookie(id:string,maxAge:number){return`brp_session=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`}
function clearCookie(){return'brp_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'}
function bytesToBase64(bytes:Uint8Array){let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s)}
function base64ToBytes(value:string){return Uint8Array.from(atob(value),c=>c.charCodeAt(0))}
async function key(secret:string){const raw=base64ToBytes(secret);if(raw.byteLength!==32)throw new Error('Invalid session key');return crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt'])}
async function encrypt(value:Session,secret:string){const iv=crypto.getRandomValues(new Uint8Array(12));const plain=new TextEncoder().encode(JSON.stringify(value));const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(secret),plain);return`${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipher))}`}
async function decrypt(value:string,secret:string):Promise<Session>{const[a,b]=value.split('.');if(!a||!b)throw new Error('Invalid session');const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:base64ToBytes(a)},await key(secret),base64ToBytes(b));return JSON.parse(new TextDecoder().decode(plain)) as Session}
async function getSession(request:Request,env:Env){const id=cookie(request,'brp_session');if(!id)return null;const stored=await env.SESSIONS.get(id);if(!stored)return null;try{return{id,data:await decrypt(stored,env.SESSION_ENCRYPTION_KEY)}}catch{await env.SESSIONS.delete(id);return null}}
function upstreamCookie(headers:Headers){return headers.get('set-cookie')?.split(';',1)[0]}
function authorizedHeaders(session:Session){return{...UPSTREAM_HEADERS,authorization:`Bearer ${session.accessToken}`,...(session.upstreamCookie?{cookie:session.upstreamCookie}:{})}}
function sameOrigin(request:Request){return request.headers.get('origin')===new URL(request.url).origin}
function passageEnabled(value:string){return value.toLowerCase()==='true'}
function safeEqual(a:string,b:string){const aa=new TextEncoder().encode(a),bb=new TextEncoder().encode(b);if(aa.length!==bb.length)return false;let diff=0;for(let i=0;i<aa.length;i++)diff|=aa[i]^bb[i];return diff===0}
async function login(request:Request,env:Env){const body=await request.json() as{username?:string,password?:string};if(!body.username?.trim()||!body.password)return response({error:'Användarnamn och lösenord krävs.'},400);const config=await fetch(`${env.BRP_BASE_URL}/apps/${env.BRP_APP_ID}?allowMultipleCompaniesAndBusinessUnits=true`,{headers:UPSTREAM_HEADERS});if(!config.ok)return response({error:'BRP-konfigurationen kunde inte hämtas.'},502);const affinity=upstreamCookie(config.headers);const auth=await fetch(`${env.BRP_BASE_URL}/auth/login`,{method:'POST',headers:{...UPSTREAM_HEADERS,...(affinity?{cookie:affinity}:{})},body:JSON.stringify({username:body.username.trim(),password:body.password})});if(!auth.ok)return response({error:auth.status===401?'Fel användarnamn eller lösenord.':'Inloggningen misslyckades.'},auth.status===401?401:502);const data=await auth.json() as{access_token:string;refresh_token?:string;username:string;expires_in:number};const session:Session={accessToken:data.access_token,refreshToken:data.refresh_token,customerId:data.username,expiresAt:Date.now()+data.expires_in*1000,upstreamCookie:upstreamCookie(auth.headers)??affinity,csrfToken:crypto.randomUUID()};const id=crypto.randomUUID(),ttl=Math.max(60,Math.min(data.expires_in,604800));await env.SESSIONS.put(id,await encrypt(session,env.SESSION_ENCRYPTION_KEY),{expirationTtl:ttl});return response({authenticated:true},200,{'set-cookie':sessionCookie(id,ttl)})}
async function status(request:Request,env:Env){const active=await getSession(request,env);if(!active)return response({authenticated:false,passageEnabled:false});return response({authenticated:true,expiresAt:new Date(active.data.expiresAt).toISOString(),csrfToken:active.data.csrfToken,passageEnabled:passageEnabled(env.PASSAGE_ENABLED)&&env.PASSAGE_AUTHORIZATION_ID.startsWith('APPROVED-'),configuredReader:env.PASSAGE_CARD_READER})}
async function passage(request:Request,env:Env){
 const active=await getSession(request,env);
 if(active&&(!request.headers.get('x-csrf-token')||!safeEqual(request.headers.get('x-csrf-token')??'',active.data.csrfToken)))return response({error:'Ogiltig CSRF-token.'},403);
 let body:Record<string,unknown>|null=null;
 try{body=await request.json() as Record<string,unknown>}catch{return response({error:'Ogiltig JSON.'},400)}
 const requestId=typeof body.requestId==='string'?body.requestId:'';
 const replayed=Boolean(active&&requestId&&await env.SESSIONS.get(`replay:${active.id}:${requestId}`));
 const recentRaw=active?await env.SESSIONS.get(`rate:${active.id}`):null;
 const result=validatePassageAttempt({originMatches:sameOrigin(request),authenticatedCustomerId:active?.data.customerId??null,body,enabled:passageEnabled(env.PASSAGE_ENABLED),authorizationId:env.PASSAGE_AUTHORIZATION_ID,allowedReader:Number(env.PASSAGE_CARD_READER),replayed,recentAt:recentRaw?Number(recentRaw):null,now:Date.now()});
 if(!result.ok)return response({error:result.error},result.status);
 if(!active)return response({error:'Inte inloggad.'},401);
 await env.SESSIONS.put(`replay:${active.id}:${result.requestId}`,result.auditTimestamp,{expirationTtl:300});
 await env.SESSIONS.put(`rate:${active.id}`,String(Date.now()),{expirationTtl:60});
 const auditId=crypto.randomUUID();
 const upstream=await fetch(`${env.BRP_BASE_URL}/customers/${encodeURIComponent(result.customerId)}/passagetries`,{method:'POST',headers:authorizedHeaders(active.data),body:JSON.stringify({cardReader:result.cardReader,printTicket:true})});
 console.log(JSON.stringify({event:'passage_attempt',auditId,timestamp:result.auditTimestamp,reader:result.cardReader,outcome:upstream.ok?'accepted':'rejected',status:upstream.status}));
 if(!upstream.ok)return response({error:'Passageförsöket avvisades.',auditId,timestamp:result.auditTimestamp},upstream.status===401?401:502);
 return response({ok:true,auditId,timestamp:result.auditTimestamp,message:'Passageförsöket skickades.'});
}
async function logout(request:Request,env:Env){const id=cookie(request,'brp_session');if(id)await env.SESSIONS.delete(id);return response({authenticated:false},200,{'set-cookie':clearCookie()})}
export default{async fetch(request:Request,env:Env):Promise<Response>{try{const path=new URL(request.url).pathname;if(path==='/api/login'&&request.method==='POST'){if(!sameOrigin(request))return response({error:'Otillåtet ursprung.'},403);return await login(request,env)}if(path==='/api/session'&&request.method==='GET')return await status(request,env);if(path==='/api/passage'&&request.method==='POST')return await passage(request,env);if(path==='/api/logout'&&request.method==='POST'){if(!sameOrigin(request))return response({error:'Otillåtet ursprung.'},403);return await logout(request,env)}if(path.startsWith('/api/'))return response({error:'Not found'},404);return env.ASSETS.fetch(request)}catch(error){console.error(JSON.stringify({event:'request_failed',message:error instanceof Error?error.message:'unknown'}));return response({error:'Ett oväntat fel inträffade.'},500)}}};

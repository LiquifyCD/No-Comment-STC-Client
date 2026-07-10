type Session = { accessToken:string; refreshToken?:string; customerId:string; expiresAt:number; upstreamCookie?:string };
const JSON_HEADERS={'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'};
const UPSTREAM_HEADERS={'accept':'application/json','content-type':'application/json','x-request-source':'mobilityapp','accept-language':'sv-SE'};

function response(data:unknown,status=200,extra:HeadersInit={}){return new Response(JSON.stringify(data),{status,headers:{...JSON_HEADERS,...extra,'content-security-policy':"default-src 'none'; frame-ancestors 'none'"}})}
function cookie(request:Request,name:string){const raw=request.headers.get('cookie')??'';return raw.split(';').map(x=>x.trim()).find(x=>x.startsWith(`${name}=`))?.slice(name.length+1)}
function sessionCookie(id:string,maxAge:number){return `brp_session=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`}
function clearCookie(){return 'brp_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'}
function bytesToBase64(bytes:Uint8Array){let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s)}
function base64ToBytes(value:string){return Uint8Array.from(atob(value),c=>c.charCodeAt(0))}
async function key(secret:string){const raw=base64ToBytes(secret);if(raw.byteLength!==32)throw new Error('SESSION_ENCRYPTION_KEY must be 32 random bytes encoded as base64');return crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt'])}
async function encrypt(value:Session,secret:string){const iv=crypto.getRandomValues(new Uint8Array(12));const plain=new TextEncoder().encode(JSON.stringify(value));const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(secret),plain);return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipher))}`}
async function decrypt(value:string,secret:string):Promise<Session>{const [a,b]=value.split('.');if(!a||!b)throw new Error('Invalid session');const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:base64ToBytes(a)},await key(secret),base64ToBytes(b));return JSON.parse(new TextDecoder().decode(plain)) as Session}
async function getSession(request:Request,env:Env){const id=cookie(request,'brp_session');if(!id)return null;const stored=await env.SESSIONS.get(id);if(!stored)return null;try{return {id,data:await decrypt(stored,env.SESSION_ENCRYPTION_KEY)}}catch{await env.SESSIONS.delete(id);return null}}
function upstreamCookie(headers:Headers){const set=headers.get('set-cookie');return set?.split(';',1)[0]}

async function login(request:Request,env:Env){
 const body=await request.json() as {username?:string,password?:string};if(!body.username?.trim()||!body.password)return response({error:'Användarnamn och lösenord krävs.'},400);
 const config=await fetch(`${env.BRP_BASE_URL}/apps/${env.BRP_APP_ID}?allowMultipleCompaniesAndBusinessUnits=true`,{headers:UPSTREAM_HEADERS});
 const affinity=upstreamCookie(config.headers);
 const auth=await fetch(`${env.BRP_BASE_URL}/auth/login`,{method:'POST',headers:{...UPSTREAM_HEADERS,...(affinity?{cookie:affinity}:{})},body:JSON.stringify({username:body.username.trim(),password:body.password})});
 if(!auth.ok)return response({error:auth.status===401?'Fel användarnamn eller lösenord.':'Inloggningen misslyckades.'},auth.status===401?401:502);
 const data=await auth.json() as {access_token:string;refresh_token?:string;username:string;expires_in:number};
 const session:Session={accessToken:data.access_token,refreshToken:data.refresh_token,customerId:data.username,expiresAt:Date.now()+data.expires_in*1000,upstreamCookie:upstreamCookie(auth.headers)??affinity};
 const id=crypto.randomUUID();const ttl=Math.max(60,Math.min(data.expires_in,604800));await env.SESSIONS.put(id,await encrypt(session,env.SESSION_ENCRYPTION_KEY),{expirationTtl:ttl});
 return response({authenticated:true},200,{'set-cookie':sessionCookie(id,ttl)});
}
async function profile(request:Request,env:Env){const active=await getSession(request,env);if(!active)return response({error:'Inte inloggad.'},401);const s=active.data;const upstream=await fetch(`${env.BRP_BASE_URL}/customers/${encodeURIComponent(s.customerId)}`,{headers:{...UPSTREAM_HEADERS,authorization:`Bearer ${s.accessToken}`,...(s.upstreamCookie?{cookie:s.upstreamCookie}:{})}});if(upstream.status===401){await env.SESSIONS.delete(active.id);return response({error:'Sessionen har gått ut.'},401,{'set-cookie':clearCookie()})}if(!upstream.ok)return response({error:'Kunde inte läsa profilen.'},502);return new Response(upstream.body,{headers:JSON_HEADERS})}
async function logout(request:Request,env:Env){const id=cookie(request,'brp_session');if(id)await env.SESSIONS.delete(id);return response({authenticated:false},200,{'set-cookie':clearCookie()})}

export default {async fetch(request:Request,env:Env):Promise<Response>{try{const url=new URL(request.url);if(request.method==='POST'&&request.headers.get('origin')!==url.origin)return response({error:'Otillåtet ursprung.'},403);if(url.pathname==='/api/login'&&request.method==='POST')return await login(request,env);if(url.pathname==='/api/profile'&&request.method==='GET')return await profile(request,env);if(url.pathname==='/api/logout'&&request.method==='POST')return await logout(request,env);if(url.pathname.startsWith('/api/'))return response({error:'Not found'},404);return env.ASSETS.fetch(request)}catch(error){console.error(JSON.stringify({event:'request_failed',message:error instanceof Error?error.message:'unknown'}));return response({error:'Ett oväntat fel inträffade.'},500)}}};

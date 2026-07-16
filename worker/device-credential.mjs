const PREFIX='brpd_';
const NAME=/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;
const TARGET=/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;

function base64url(bytes){let value='';for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
function normalize(value){return value.trim().replace(/\s+/g,' ')}

export function createDeviceCredential(id=crypto.randomUUID()){
  const secret=base64url(crypto.getRandomValues(new Uint8Array(32)));
  return {id,secret,credential:`${PREFIX}${id}.${secret}`};
}

export function parseDeviceCredential(value){
  if(typeof value!=='string')return null;
  const match=value.match(/^brpd_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i);
  return match?{id:match[1].toLowerCase(),secret:match[2]}:null;
}

export async function hashDeviceSecret(secret,keyMaterial){
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(keyMaterial),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(secret))));
}

export function constantTimeEqual(a,b){
  const aa=new TextEncoder().encode(a),bb=new TextEncoder().encode(b);let difference=aa.length^bb.length;
  for(let index=0;index<Math.max(aa.length,bb.length);index++)difference|=(aa[index]??0)^(bb[index]??0);
  return difference===0;
}

export function validateDeviceTargetBody(body){
  if(!body||typeof body!=='object'||Array.isArray(body))return {ok:false,status:400,error:'Invalid request.'};
  const keys=Object.keys(body);if(keys.some(key=>!['doorName','sequenceName'].includes(key)))return {ok:false,status:400,error:'Invalid request.'};
  const doorName=typeof body.doorName==='string'?normalize(body.doorName):'';
  const sequenceName=typeof body.sequenceName==='string'?normalize(body.sequenceName):'';
  if(Boolean(doorName)===Boolean(sequenceName))return {ok:false,status:400,error:'Provide exactly one doorName or sequenceName.'};
  const name=doorName||sequenceName;if(!TARGET.test(name))return {ok:false,status:400,error:'Invalid target name.'};
  return {ok:true,targetType:doorName?'door':'sequence',targetName:name,targetNameKey:name.toLocaleLowerCase('sv-SE')};
}

export function validateDeviceInput(body){
  if(!body||typeof body!=='object'||Array.isArray(body))return {ok:false,status:400,error:'Invalid request.'};
  const name=typeof body.name==='string'?normalize(body.name):'';if(!NAME.test(name))return {ok:false,status:400,error:'Invalid device name.'};
  const expiresInDays=Number(body.expiresInDays??30);if(!Number.isInteger(expiresInDays)||expiresInDays<1||expiresInDays>90)return {ok:false,status:400,error:'Expiry must be 1-90 days.'};
  const targets=body.targets??[];if(!Array.isArray(targets)||targets.length>100)return {ok:false,status:400,error:'Invalid target allowlist.'};
  for(const target of targets)if(!target||!['door','sequence'].includes(target.type)||typeof target.id!=='string'||!/^[0-9a-f-]{36}$/i.test(target.id))return {ok:false,status:400,error:'Invalid target allowlist.'};
  return {ok:true,name,nameKey:name.toLocaleLowerCase('sv-SE'),expiresInDays,targets};
}

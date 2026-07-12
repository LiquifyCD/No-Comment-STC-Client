import {authenticateBrp} from './brp-auth.mjs';
import {sendDoorRequest} from './door-service.mjs';

const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEADERS={accept:'application/json','x-request-source':'mobilityapp','accept-language':'sv-SE'};

export function validateOpenDoorBody(body){
  if(!body||typeof body!=='object'||Array.isArray(body))return {ok:false,status:400,error:'Invalid request.'};
  for(const forbidden of ['major','minor','cardReader','readerCode','customerId','accessToken','refreshToken','cookie'])if(forbidden in body)return {ok:false,status:400,error:'Invalid request.'};
  if(typeof body.email!=='string'||body.email.length>254||!EMAIL.test(body.email.trim()))return {ok:false,status:400,error:'Invalid email.'};
  if(typeof body.password!=='string'||body.password.length<1||body.password.length>256)return {ok:false,status:400,error:'Invalid password.'};
  if(typeof body.reader!=='string'||!UUID.test(body.reader))return {ok:false,status:400,error:'Invalid reader.'};
  return {ok:true,email:body.email.trim(),password:body.password,reader:body.reader};
}

export async function runOpenDoorFlow({fetcher,baseUrl,appId,body,resolveReader,enabled,authorizationId}){
  const valid=validateOpenDoorBody(body);if(!valid.ok)return valid;
  if(!enabled||!authorizationId?.startsWith('APPROVED-'))return {ok:false,status:503,error:'Door opening is disabled.'};
  const auth=await authenticateBrp({fetcher,baseUrl,appId,email:valid.email,password:valid.password});if(!auth.ok)return auth;
  const reader=await resolveReader(auth.customerId,valid.reader);if(!reader)return {ok:false,status:404,error:'Reader not found.'};

  const lookupUrl=new URL(`${baseUrl}/passagereaders`);lookupUrl.searchParams.set('major',reader.major);lookupUrl.searchParams.set('minor',reader.minor);
  const lookup=await fetcher(lookupUrl.toString(),{headers:{...HEADERS,...(auth.cookie?{cookie:auth.cookie}:{})}});
  if(!lookup.ok)return {ok:false,status:lookup.status===404?404:502,error:lookup.status===404?'Reader not found.':'Door request failed.'};
  const passageReader=await lookup.json();
  if(!passageReader||!Number.isInteger(passageReader.id)||passageReader.id<=0)return {ok:false,status:502,error:'Invalid reader response.'};

  const door=await sendDoorRequest({fetcher,baseUrl,customerId:auth.customerId,cardReader:passageReader.id,accessToken:auth.accessToken,cookie:auth.cookie});
  if(!door.ok)return {ok:false,status:door.status===401?401:502,error:'Door request failed.'};
  return {ok:true,status:200,message:'Door opened.'};
}

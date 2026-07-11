import {resolveReaderCode} from './reader-catalog.mjs';
import {sendDoorRequest} from './door-service.mjs';

const EMAIL_PATTERN=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UPSTREAM_HEADERS={accept:'application/json','content-type':'application/json','x-request-source':'mobilityapp','accept-language':'sv-SE'};

export function validateOpenDoorBody(body,catalog){
  if(!body||typeof body!=='object'||Array.isArray(body))return {ok:false,status:400,error:'Invalid request.'};
  for(const forbidden of ['cardReader','readerCode','customerId','accessToken','refreshToken','cookie'])if(forbidden in body)return {ok:false,status:400,error:'Invalid request.'};
  if(typeof body.email!=='string'||body.email.length>254||!EMAIL_PATTERN.test(body.email.trim()))return {ok:false,status:400,error:'Invalid email.'};
  if(typeof body.password!=='string'||body.password.length<1||body.password.length>256)return {ok:false,status:400,error:'Invalid password.'};
  if(typeof body.reader!=='string')return {ok:false,status:400,error:'Invalid reader.'};
  const cardReader=resolveReaderCode(catalog,body.reader);
  if(cardReader===null)return {ok:false,status:400,error:'Invalid reader.'};
  return {ok:true,email:body.email.trim(),password:body.password,cardReader};
}

function upstreamCookie(headers){return headers.get('set-cookie')?.split(';',1)[0]}

export async function runOpenDoorFlow({fetcher,baseUrl,appId,body,catalog,enabled,authorizationId}){
  const valid=validateOpenDoorBody(body,catalog);
  if(!valid.ok)return valid;
  if(!enabled||!authorizationId?.startsWith('APPROVED-'))return {ok:false,status:503,error:'Door opening is disabled.'};

  const config=await fetcher(`${baseUrl}/apps/${appId}?allowMultipleCompaniesAndBusinessUnits=true`,{headers:UPSTREAM_HEADERS});
  if(!config.ok)return {ok:false,status:502,error:'Door request failed.'};
  const affinity=upstreamCookie(config.headers);
  const auth=await fetcher(`${baseUrl}/auth/login`,{method:'POST',headers:{...UPSTREAM_HEADERS,...(affinity?{cookie:affinity}:{})},body:JSON.stringify({username:valid.email,password:valid.password})});
  if(!auth.ok)return {ok:false,status:auth.status===401?401:502,error:auth.status===401?'Invalid credentials.':'Door request failed.'};
  const data=await auth.json();
  if(!data||typeof data.access_token!=='string'||typeof data.username!=='string')return {ok:false,status:502,error:'Door request failed.'};

  const door=await sendDoorRequest({fetcher,baseUrl,customerId:data.username,cardReader:valid.cardReader,accessToken:data.access_token,cookie:upstreamCookie(auth.headers)??affinity});
  if(!door.ok)return {ok:false,status:door.status===401?401:502,error:'Door request failed.'};
  return {ok:true,status:200,message:'Door opened.'};
}

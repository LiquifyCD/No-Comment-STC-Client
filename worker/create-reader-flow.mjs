import {authenticateBrp} from './brp-auth.mjs';
import {validateReaderName} from './reader-model.mjs';

const DIGITS=/^\d{1,12}$/;
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateConfiguredReader(body){
  if(!body||typeof body!=='object'||Array.isArray(body))return {ok:false,status:400,error:'Invalid request.'};
  const name=validateReaderName(body.name);if(!name.ok)return {ok:false,status:400,error:name.error};
  if(typeof body.major!=='string'||!DIGITS.test(body.major))return {ok:false,status:400,error:'Invalid major.'};
  if(typeof body.minor!=='string'||!DIGITS.test(body.minor))return {ok:false,status:400,error:'Invalid minor.'};
  if(typeof body.email!=='string'||!EMAIL.test(body.email.trim())||body.email.length>254)return {ok:false,status:400,error:'Invalid email.'};
  if(typeof body.password!=='string'||body.password.length<1||body.password.length>256)return {ok:false,status:400,error:'Invalid password.'};
  return {ok:true,name:name.name,nameKey:name.nameKey,major:body.major,minor:body.minor,email:body.email.trim(),password:body.password};
}

export async function runCreateReaderFlow({fetcher,baseUrl,appId,body}){
  const valid=validateConfiguredReader(body);if(!valid.ok)return valid;
  const auth=await authenticateBrp({fetcher,baseUrl,appId,email:valid.email,password:valid.password});if(!auth.ok)return auth;
  return {ok:true,customerId:auth.customerId,name:valid.name,nameKey:valid.nameKey,major:valid.major,minor:valid.minor};
}

import {authenticateBrp} from './brp-auth.mjs';

const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOOR_NAME=/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;

export function validateOpenDoorBody(body){
  if(!body||typeof body!=='object'||Array.isArray(body))return {ok:false,status:400,error:'Invalid request.'};
  for(const forbidden of ['reader','readerId','major','minor','cardReader','readerCode','customerId','accessToken','refreshToken','cookie'])if(forbidden in body)return {ok:false,status:400,error:'Invalid request.'};
  if(typeof body.email!=='string'||body.email.length>254||!EMAIL.test(body.email.trim()))return {ok:false,status:400,error:'Invalid email.'};
  if(typeof body.password!=='string'||body.password.length<1||body.password.length>256)return {ok:false,status:400,error:'Invalid password.'};
  const doorName=typeof body.doorName==='string'?body.doorName.trim().replace(/\s+/g,' '):'';
  const sequenceName=typeof body.sequenceName==='string'?body.sequenceName.trim().replace(/\s+/g,' '):'';
  if(Boolean(doorName)===Boolean(sequenceName))return {ok:false,status:400,error:'Provide exactly one doorName or sequenceName.'};
  const targetName=doorName||sequenceName;
  if(!DOOR_NAME.test(targetName))return {ok:false,status:400,error:'Invalid target name.'};
  return {ok:true,email:body.email.trim(),password:body.password,targetType:doorName?'door':'sequence',targetName,targetNameKey:targetName.toLocaleLowerCase('sv-SE')};
}

export async function runOpenDoorFlow({fetcher,baseUrl,appId,body,resolveTarget,executeTarget,enabled,authorizationId}){
  const valid=validateOpenDoorBody(body);if(!valid.ok)return valid;
  if(!enabled||!authorizationId?.startsWith('APPROVED-'))return {ok:false,status:503,error:'Door opening is disabled.'};
  const auth=await authenticateBrp({fetcher,baseUrl,appId,email:valid.email,password:valid.password});if(!auth.ok)return auth;
  const target=await resolveTarget(auth.customerId,valid.targetType,valid.targetNameKey);
  if(!target)return {ok:false,status:404,error:'Target not found.'};
  if(target.ambiguous)return {ok:false,status:409,error:'Target name is ambiguous.'};
  const executed=await executeTarget(auth,target);
  if(!executed.ok)return {ok:false,status:executed.status,error:executed.error,...(executed.failedStep?{failedStep:executed.failedStep,completedSteps:executed.completedSteps}:{})};
  return {ok:true,status:200,message:'Request completed.',customerId:auth.customerId,targetId:target.id,targetType:valid.targetType,completedSteps:executed.completedSteps};
}

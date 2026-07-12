import {validateReaderName} from './reader-model.mjs';

const DIGITS=/^\d{1,12}$/;

export function validateReaderCreation(body){
  if(!body||typeof body!=='object'||Array.isArray(body))return {ok:false,status:400,error:'Ogiltig begäran.'};
  if('cardReader' in body||'readerCode' in body)return {ok:false,status:400,error:'Readerkoden styrs av servern.'};
  const name=validateReaderName(body.name);
  if(!name.ok)return {ok:false,status:400,error:name.error};
  if('readerKey' in body)return {ok:false,status:400,error:'Preset readers are not supported.'};
  if(typeof body.major!=='string'||!DIGITS.test(body.major))return {ok:false,status:400,error:'Ogiltig major.'};
  if(typeof body.minor!=='string'||!DIGITS.test(body.minor))return {ok:false,status:400,error:'Ogiltig minor.'};
  return {ok:true,name:name.name,nameKey:name.nameKey,major:body.major,minor:body.minor};
}

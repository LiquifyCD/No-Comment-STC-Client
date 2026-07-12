import {validateReaderName} from './reader-model.mjs';
import {resolveReaderCode} from './reader-catalog.mjs';

const DIGITS=/^\d{1,12}$/;

export function validateReaderCreation(body,catalog){
  if(!body||typeof body!=='object'||Array.isArray(body))return {ok:false,status:400,error:'Ogiltig begäran.'};
  if('cardReader' in body||'readerCode' in body)return {ok:false,status:400,error:'Readerkoden styrs av servern.'};
  const name=validateReaderName(body.name);
  if(!name.ok)return {ok:false,status:400,error:name.error};
  const hasBeacon='major' in body||'minor' in body;
  if(hasBeacon){
    if(typeof body.major!=='string'||!DIGITS.test(body.major))return {ok:false,status:400,error:'Ogiltig major.'};
    if(typeof body.minor!=='string'||!DIGITS.test(body.minor))return {ok:false,status:400,error:'Ogiltig minor.'};
    return {ok:true,mode:'beacon',name:name.name,nameKey:name.nameKey,major:body.major,minor:body.minor};
  }
  if(typeof body.readerKey!=='string')return {ok:false,status:400,error:'Välj en serverkonfigurerad reader.'};
  if(!catalog.ok)return {ok:false,status:503,error:catalog.error};
  const cardReader=resolveReaderCode(catalog,body.readerKey);
  if(cardReader===null)return {ok:false,status:400,error:'Välj en serverkonfigurerad reader.'};
  return {ok:true,mode:'catalog',name:name.name,nameKey:name.nameKey,cardReader};
}

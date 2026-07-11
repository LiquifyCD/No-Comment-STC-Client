import {validateReaderName} from './reader-model.mjs';
import {resolveReaderCode} from './reader-catalog.mjs';

export function validateReaderCreation(body,catalog){
  if(!body||typeof body!=='object'||Array.isArray(body))return {ok:false,status:400,error:'Ogiltig begäran.'};
  if('cardReader' in body||'readerCode' in body)return {ok:false,status:400,error:'Readerkoden styrs av servern.'};
  const name=validateReaderName(body.name);
  if(!name.ok)return {ok:false,status:400,error:name.error};
  if(typeof body.readerKey!=='string')return {ok:false,status:400,error:'Välj en serverkonfigurerad reader.'};
  const cardReader=resolveReaderCode(catalog,body.readerKey);
  if(cardReader===null)return {ok:false,status:400,error:'Välj en serverkonfigurerad reader.'};
  return {ok:true,name:name.name,nameKey:name.nameKey,cardReader};
}

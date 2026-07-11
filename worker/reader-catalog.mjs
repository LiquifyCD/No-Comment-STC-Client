const KEY_PATTERN=/^[a-z0-9][a-z0-9_-]{0,31}$/;

export function parseReaderCatalog(value,fallbackCode){
  const entries=[];
  if(value){
    let parsed;
    try{parsed=JSON.parse(value)}catch{return {ok:false,error:'Reader-katalogen innehåller ogiltig JSON.'}}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return {ok:false,error:'Reader-katalogen måste vara ett objekt.'};
    for(const [key,item] of Object.entries(parsed)){
      if(!KEY_PATTERN.test(key)||!item||typeof item!=='object'||typeof item.label!=='string'||!item.label.trim()||!Number.isInteger(item.code)||item.code<=0)return {ok:false,error:'Reader-katalogen innehåller en ogiltig post.'};
      entries.push({key,label:item.label.trim(),code:item.code});
    }
  }
  if(!entries.length&&Number.isInteger(fallbackCode)&&fallbackCode>0)entries.push({key:'default',label:'Standardreader',code:fallbackCode});
  return entries.length?{ok:true,entries}:{ok:false,error:'Ingen reader är konfigurerad på servern.'};
}

export function publicReaderOptions(catalog){return catalog.entries.map(({key,label})=>({key,label}))}
export function resolveReaderCode(catalog,key){return catalog.entries.find(entry=>entry.key===key)?.code??null}

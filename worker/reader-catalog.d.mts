export type ReaderCatalog={ok:true;entries:Array<{key:string;label:string;code:number}>}|{ok:false;error:string};
export function parseReaderCatalog(value:string|undefined,fallbackCode:number):ReaderCatalog;
export function publicReaderOptions(catalog:Extract<ReaderCatalog,{ok:true}>):Array<{key:string;label:string}>;
export function resolveReaderCode(catalog:Extract<ReaderCatalog,{ok:true}>,key:string):number|null;

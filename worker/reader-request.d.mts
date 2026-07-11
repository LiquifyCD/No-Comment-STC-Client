import type {ReaderCatalog} from './reader-catalog.mjs';
export function validateReaderCreation(body:unknown,catalog:Extract<ReaderCatalog,{ok:true}>):{ok:true;name:string;nameKey:string;cardReader:number}|{ok:false;status:number;error:string};

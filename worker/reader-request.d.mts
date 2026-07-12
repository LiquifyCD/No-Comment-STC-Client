import type {ReaderCatalog} from './reader-catalog.mjs';
export function validateReaderCreation(body:unknown,catalog:ReaderCatalog):
  {ok:true;mode:'catalog';name:string;nameKey:string;cardReader:number}
  |{ok:true;mode:'beacon';name:string;nameKey:string;major:string;minor:string}
  |{ok:false;status:number;error:string};

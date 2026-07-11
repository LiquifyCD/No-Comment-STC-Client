import type {ReaderCatalog} from './reader-catalog.mjs';
type Catalog=Extract<ReaderCatalog,{ok:true}>;
export function validateOpenDoorBody(body:unknown,catalog:Catalog):{ok:true;email:string;password:string;cardReader:number}|{ok:false;status:number;error:string};
export function runOpenDoorFlow(input:{fetcher:typeof fetch;baseUrl:string;appId:string;body:unknown;catalog:Catalog;enabled:boolean;authorizationId:string|undefined}):Promise<{ok:true;status:200;message:string}|{ok:false;status:number;error:string}>;

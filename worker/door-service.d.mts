export function sendDoorRequest(input:{fetcher:typeof fetch;baseUrl:string;customerId:string;cardReader:number;accessToken:string;cookie?:string}):Promise<Response>;
export function lookupPassageReader(input:{fetcher:typeof fetch;baseUrl:string;major:string;minor:string;cookie?:string}):Promise<{ok:true;cardReader:number}|{ok:false;status:number}>;

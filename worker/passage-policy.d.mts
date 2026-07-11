export type PassagePolicyInput={originMatches:boolean;authenticatedCustomerId:string|null;body:Record<string,unknown>|null;enabled:boolean;authorizationId:string|undefined;allowedReader:number;replayed:boolean;recentAt:number|null;now:number};
export type PassagePolicyResult={ok:false;status:number;error:string}|{ok:true;customerId:string;cardReader:number;requestId:string;auditTimestamp:string};
export function validatePassageAttempt(input:PassagePolicyInput):PassagePolicyResult;

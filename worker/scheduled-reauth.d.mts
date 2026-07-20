export const REAUTH_INTERVAL_MS:number;
export const REAUTH_EXPIRY_MARGIN_MS:number;
export const REAUTH_RETRY_MS:number;
export const REAUTH_LOCK_MS:number;
export const MAX_REAUTH_BATCH:number;
export function nextReauthenticationAt(now:number,expiresAt:number):number;
export function selectReauthenticationCandidates<T extends {active_device_count:number;scheduled_reauth_enabled:number;scheduled_reauth_ciphertext:string|null;next_reauth_at:number|null;refresh_lock_until:number|null}>(rows:T[],now?:number,limit?:number):T[];
export function runScheduledReauthentication<Row,Session>(options:{
 enabled:boolean;now?:number;limit?:number;
 listCandidates(input:{now:number;limit:number}):Promise<Row[]>;
 acquire(row:Row,lockUntil:number):Promise<boolean>;
 decryptCredentials(row:Row):Promise<{username:string;password:string}|null>;
 authenticate(credentials:{username:string;password:string}):Promise<{ok:true;session:Session&{customerId:string;expiresAt:number}}|{ok:false;status:number}>;
 ownerForCustomer(customerId:string):Promise<string>;
 saveSuccess(row:Row,session:Session,nextAt:number):Promise<void>;
 saveFailure(row:Row,status:'refresh_failed'|'reauthorization_required',error:string,disable:boolean,now:number):Promise<void>;
 release(row:Row):Promise<void>;
 audit(row:Row,eventType:'reauthorize'|'refresh_failed',status:string,durationMs:number):Promise<void>;
}):Promise<{status:string;selected:number;renewed:number;failed:number}>;

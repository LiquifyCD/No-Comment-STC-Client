export const REFRESH_WINDOW_MS:number;
export const REFRESH_LOCK_MS:number;
export const MAX_REFRESH_BATCH:number;
export function sessionStatus(row:{upstream_expires_at:number;refresh_lock_until:number|null;refresh_status:string}|null,now?:number):string;
export function selectRefreshCandidates<T extends {active_device_count:number;upstream_expires_at:number;refresh_lock_until:number|null;refresh_status:string}>(rows:T[],now?:number,limit?:number):T[];
export function runProactiveRefresh<Row,Session>(options:{
 enabled:boolean;contractVerified:boolean;now?:number;limit?:number;
 listCandidates(input:{now:number;before:number;limit:number}):Promise<Row[]>;
 acquire(row:Row,lockUntil:number):Promise<boolean>;
 decryptSession(row:Row):Promise<Session|null>;
 refreshSession(session:Session):Promise<Session|null>;
 saveSuccess(row:Row,session:Session):Promise<void>;
 saveFailure(row:Row,status:'refresh_failed'|'reauthorization_required',error:string):Promise<void>;
 release(row:Row):Promise<void>;
 audit(row:Row,eventType:'refresh_success'|'refresh_failed',status:string,durationMs:number):Promise<void>;
}):Promise<{status:string;selected:number;refreshed:number;failed:number}>;

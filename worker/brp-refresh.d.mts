export const BRP_REFRESH_CONTRACT_VERIFIED:false;
export function refreshBrpSession(currentSession:{customerId:string;accessToken:string;refreshToken?:string;upstreamCookie?:string;expiresAt:number}):Promise<{ok:true;session:{customerId:string;accessToken:string;refreshToken:string;upstreamCookie?:string;expiresAt:number}}|{ok:false;status:number;error:string;reason:string}>;

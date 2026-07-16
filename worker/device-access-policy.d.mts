export function validateDeviceRecord(input:{row:null|{revoked_at:string|null;expires_at:number;token_hash:string};computedHash:string;now:number;constantTimeEqual:(a:string,b:string)=>boolean}):{ok:true}|{ok:false;status:401;error:string};
export function isDeviceTargetAllowed(allowedTargetIds:string[],targetId:string):boolean;

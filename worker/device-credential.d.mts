export function createDeviceCredential(id?:string):{id:string;secret:string;credential:string};
export function parseDeviceCredential(value:unknown):{id:string;secret:string}|null;
export function hashDeviceSecret(secret:string,keyMaterial:string):Promise<string>;
export function constantTimeEqual(a:string,b:string):boolean;
export function validateDeviceTargetBody(body:unknown):{ok:true;targetType:'door'|'sequence';targetName:string;targetNameKey:string}|{ok:false;status:number;error:string};
export function validateDeviceInput(body:unknown):{ok:true;name:string;nameKey:string;expiresInDays:number|'never';targets:Array<{type:'door'|'sequence';id:string}>}|{ok:false;status:number;error:string};

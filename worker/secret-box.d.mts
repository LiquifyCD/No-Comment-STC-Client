export function encryptJson(value:unknown,secret:string):Promise<string>;
export function decryptJson<T=unknown>(value:string,secret:string):Promise<T>;

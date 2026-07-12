export const PASSAGE_COOLDOWN_MS:number;
export const ACQUIRE_PASSAGE_COOLDOWN:string;
export function acquirePassageCooldown(input:{db:D1Database;owner:string;readerId:string;now:number;cooldownMs?:number}):Promise<boolean>;

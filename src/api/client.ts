import { APP_ID, BASE_URL } from './config';
import type { CustomerProfile, LoginResponse, TokenSet } from './types';

const commonHeaders = { Accept:'application/json', 'Content-Type':'application/json', 'X-Request-Source':'mobilityapp', 'Accept-Language':'sv-SE' };
let tokens: TokenSet | null = null;
export function setSessionTokens(value: TokenSet | null) { tokens = value; }

async function json<T>(path:string, init:RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, { ...init, credentials:'include', headers:{...commonHeaders,...init.headers} });
  if (!response.ok) { if (response.status === 401) throw new Error('Sessionen har gått ut. Logga in igen.'); throw new Error(`API-anropet misslyckades (${response.status}).`); }
  return response.json() as Promise<T>;
}

export async function login(username:string,password:string):Promise<TokenSet>{
  await json(`/apps/${APP_ID}?allowMultipleCompaniesAndBusinessUnits=true`);
  const data=await json<LoginResponse>('/auth/login',{method:'POST',body:JSON.stringify({username,password})});
  const next={accessToken:data.access_token,refreshToken:data.refresh_token,customerId:data.username,expiresAt:Date.now()+data.expires_in*1000}; setSessionTokens(next); return next;
}

export async function getOwnProfile():Promise<CustomerProfile>{ if(!tokens) throw new Error('Inte inloggad.'); return json(`/customers/${encodeURIComponent(tokens.customerId)}`,{headers:{Authorization:`Bearer ${tokens.accessToken}`}}); }

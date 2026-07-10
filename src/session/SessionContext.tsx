import { createContext, useContext, useEffect, useState, type PropsWithChildren } from 'react';
import type { CustomerProfile, TokenSet } from '@/api/types';
import * as api from '@/api/client';
import * as store from '@/security/tokenStore';
type Status='loading'|'anonymous'|'authenticated';
type Value={status:Status;profile:CustomerProfile|null;error:string;login:(u:string,p:string)=>Promise<void>;logout:()=>Promise<void>;reloadProfile:()=>Promise<void>};
const Context=createContext<Value|null>(null);
export function SessionProvider({children}:PropsWithChildren){
 const[status,setStatus]=useState<Status>('loading'); const[profile,setProfile]=useState<CustomerProfile|null>(null); const[error,setError]=useState(''); const[token,setToken]=useState<TokenSet|null>(null);
 async function activate(next:TokenSet){ api.setSessionTokens(next); setToken(next); await store.saveTokens(next); setProfile(await api.getOwnProfile()); setStatus('authenticated'); }
 async function logout(){api.setSessionTokens(null);setToken(null);setProfile(null);setError('');await store.clearTokens();setStatus('anonymous');}
 async function reloadProfile(){try{setError('');let current=token;if(current&&current.expiresAt-Date.now()<60_000){current=await api.refresh(current);setToken(current);await store.saveTokens(current);}setProfile(await api.getOwnProfile());}catch(e){setError(e instanceof Error?e.message:'Kunde inte läsa profilen.');}}
 useEffect(()=>{(async()=>{const saved=await store.loadTokens();if(!saved)return setStatus('anonymous');try{let current=saved;if(current.expiresAt-Date.now()<60_000)current=await api.refresh(current);await activate(current);}catch{await logout();}})();},[]);
 async function login(username:string,password:string){try{setError('');await activate(await api.login(username,password));}catch(e){await logout();throw e;}}
 return <Context.Provider value={{status,profile,error,login,logout,reloadProfile}}>{children}</Context.Provider>;
}
export function useSession(){const value=useContext(Context);if(!value)throw new Error('useSession must be inside SessionProvider');return value;}

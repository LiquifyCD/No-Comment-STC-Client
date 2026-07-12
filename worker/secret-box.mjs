function bytesToBase64(bytes){let value='';for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value)}
function base64ToBytes(value){return Uint8Array.from(atob(value),character=>character.charCodeAt(0))}
async function keyFromSecret(secret){const raw=base64ToBytes(secret);if(raw.byteLength!==32)throw new Error('Invalid encryption key');return crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt'])}

export async function encryptJson(value,secret){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const plain=new TextEncoder().encode(JSON.stringify(value));
  const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},await keyFromSecret(secret),plain);
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipher))}`;
}

export async function decryptJson(value,secret){
  const [iv,cipher]=value.split('.');if(!iv||!cipher)throw new Error('Invalid encrypted value');
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:base64ToBytes(iv)},await keyFromSecret(secret),base64ToBytes(cipher));
  return JSON.parse(new TextDecoder().decode(plain));
}

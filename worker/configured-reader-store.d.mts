export const CONFIGURED_READER_UPSERT:string;
export function saveConfiguredReader(input:{
  db:D1Database;
  id:string;
  owner:string;
  name:string;
  nameKey:string;
  now:string;
  ciphertext:string;
}):Promise<string|null>;

export function validateReaderDeletion(input:{authenticated:boolean;originMatches:boolean;csrfValid:boolean;confirmed:unknown}):{ok:true}|{ok:false;status:number;error:string};
export function deleteOwnedReader(input:{db:D1Database;owner:string;readerId:string}):Promise<boolean>;

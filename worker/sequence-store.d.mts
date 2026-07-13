export type SequenceInputStep={doorNameKey:string;delayAfterMs:number;position:number};
export type ResolvedSequenceStep={readerId:string;delayAfterMs:number;position:number};
export type DefaultSelection={type:'door'|'sequence';id:string}|null;
export function resolveSequenceReaders(input:{db:D1Database;owner:string;steps:SequenceInputStep[]}):Promise<{ok:true;steps:ResolvedSequenceStep[]}|{ok:false;status:number;error:string}>;
export function getDefaultSelection(input:{db:D1Database;owner:string}):Promise<DefaultSelection>;

export const MAX_SEQUENCE_STEPS:8;
export const MAX_STEP_DELAY_SECONDS:10;
export const MAX_SEQUENCE_DELAY_SECONDS:30;
export type ValidSequenceStep={position:number;doorName:string;doorNameKey:string;delayAfterMs:number};
export function validateSequenceInput(body:unknown):{ok:true;name:string;nameKey:string;steps:ValidSequenceStep[];totalDelaySeconds:number}|{ok:false;status:number;error:string};
export function runSequenceSteps<T extends {delayAfterMs:number}>(input:{steps:T[];openStep:(step:T,index:number)=>Promise<{ok:true}|{ok:false;status:number;error:string}>;wait:(ms:number)=>Promise<void>}):Promise<{ok:true;completedSteps:number}|{ok:false;status:number;error:string;failedStep:number;completedSteps:number}>;

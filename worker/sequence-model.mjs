import {validateReaderName} from './reader-model.mjs';

export const MAX_SEQUENCE_STEPS=8;
export const MAX_STEP_DELAY_SECONDS=10;
export const MAX_SEQUENCE_DELAY_SECONDS=30;

export function validateSequenceInput(body){
  if(!body||typeof body!=='object'||Array.isArray(body))return {ok:false,status:400,error:'Ogiltig begäran.'};
  for(const forbidden of ['customerId','readerId','readerIds','major','minor','cardReader','accessToken','refreshToken','cookie'])if(forbidden in body)return {ok:false,status:400,error:'Ogiltig begäran.'};
  const validatedName=validateReaderName(body.name);
  if(!validatedName.ok)return {ok:false,status:400,error:validatedName.error};
  if(!Array.isArray(body.steps)||body.steps.length<1||body.steps.length>MAX_SEQUENCE_STEPS)return {ok:false,status:400,error:`En sekvens måste ha 1–${MAX_SEQUENCE_STEPS} steg.`};
  let totalDelaySeconds=0;
  const steps=[];
  for(let position=0;position<body.steps.length;position++){
    const step=body.steps[position];
    if(!step||typeof step!=='object'||Array.isArray(step))return {ok:false,status:400,error:'Ogiltigt sekvenssteg.'};
    for(const forbidden of ['readerId','major','minor','cardReader'])if(forbidden in step)return {ok:false,status:400,error:'Dörren måste anges med sparat namn.'};
    const door=validateReaderName(step.doorName);
    if(!door.ok)return {ok:false,status:400,error:'Ogiltigt dörrnamn.'};
    if(!Number.isInteger(step.delaySeconds)||step.delaySeconds<0||step.delaySeconds>MAX_STEP_DELAY_SECONDS)return {ok:false,status:400,error:`Väntetiden måste vara 0–${MAX_STEP_DELAY_SECONDS} sekunder.`};
    totalDelaySeconds+=position===body.steps.length-1?0:step.delaySeconds;
    steps.push({position,doorName:door.name,doorNameKey:door.nameKey,delayAfterMs:position===body.steps.length-1?0:step.delaySeconds*1000});
  }
  if(totalDelaySeconds>MAX_SEQUENCE_DELAY_SECONDS)return {ok:false,status:400,error:`Total väntetid får vara högst ${MAX_SEQUENCE_DELAY_SECONDS} sekunder.`};
  return {ok:true,name:validatedName.name,nameKey:validatedName.nameKey,steps,totalDelaySeconds};
}

export async function runSequenceSteps({steps,openStep,wait}){
  for(let index=0;index<steps.length;index++){
    const result=await openStep(steps[index],index);
    if(!result.ok)return {ok:false,status:result.status,error:result.error,failedStep:index+1,completedSteps:index};
    if(index<steps.length-1&&steps[index].delayAfterMs>0)await wait(steps[index].delayAfterMs);
  }
  return {ok:true,completedSteps:steps.length};
}

export function validateReaderCreation(body:unknown):
  {ok:true;name:string;nameKey:string;major:string;minor:string}
  |{ok:false;status:number;error:string};

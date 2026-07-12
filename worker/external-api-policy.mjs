function safeEqual(left,right){
  const a=new TextEncoder().encode(left),b=new TextEncoder().encode(right);
  if(a.length!==b.length)return false;
  let difference=0;
  for(let index=0;index<a.length;index++)difference|=a[index]^b[index];
  return difference===0;
}

export function validateExternalOpenRequest({protocol,origin,expectedOrigin,apiKey,expectedApiKey,recentAt,now}){
  if(protocol!=='https:')return {ok:false,status:400,error:'HTTPS required.'};
  if(origin&&origin!==expectedOrigin)return {ok:false,status:403,error:'Forbidden.'};
  if(!expectedApiKey||!apiKey||!safeEqual(apiKey,expectedApiKey))return {ok:false,status:401,error:'Unauthorized.'};
  if(recentAt!==null&&now-recentAt<2_000)return {ok:false,status:429,error:'Try again in 2 seconds.'};
  return {ok:true};
}

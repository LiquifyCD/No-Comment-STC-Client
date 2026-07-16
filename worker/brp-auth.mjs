const HEADERS={accept:'application/json','content-type':'application/json','x-request-source':'mobilityapp','accept-language':'sv-SE'};
function cookie(headers){return headers.get('set-cookie')?.split(';',1)[0]}

export async function authenticateBrp({fetcher,baseUrl,appId,email,password,onTiming=()=>{},now=()=>Date.now()}){
  const configStarted=now();
  const config=await fetcher(`${baseUrl}/apps/${appId}?allowMultipleCompaniesAndBusinessUnits=true`,{headers:HEADERS});
  onTiming('appConfig',now()-configStarted);
  if(!config.ok)return {ok:false,status:502,error:'Request failed.'};
  const affinity=cookie(config.headers);
  const loginStarted=now();
  const auth=await fetcher(`${baseUrl}/auth/login`,{method:'POST',headers:{...HEADERS,...(affinity?{cookie:affinity}:{})},body:JSON.stringify({username:email,password})});
  onTiming('login',now()-loginStarted);
  if(!auth.ok)return {ok:false,status:auth.status===401?401:502,error:auth.status===401?'Invalid credentials.':'Request failed.'};
  const data=await auth.json();
  if(!data||typeof data.access_token!=='string'||typeof data.username!=='string')return {ok:false,status:502,error:'Request failed.'};
  const expiresIn=Number.isFinite(Number(data.expires_in))?Math.max(60,Number(data.expires_in)):604800;
  return {ok:true,customerId:data.username,accessToken:data.access_token,refreshToken:typeof data.refresh_token==='string'?data.refresh_token:undefined,expiresAt:Date.now()+expiresIn*1000,cookie:cookie(auth.headers)??affinity};
}

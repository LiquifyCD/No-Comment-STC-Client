const HEADERS={accept:'application/json','content-type':'application/json','x-request-source':'mobilityapp','accept-language':'sv-SE'};
function cookie(headers){return headers.get('set-cookie')?.split(';',1)[0]}

export async function refreshBrpSession({fetcher,baseUrl,path,refreshToken,currentCookie,customerId,now=()=>Date.now()}){
  if(!path||!path.startsWith('/')||!refreshToken)return {ok:false,status:401,error:'Reauthorization required.'};
  const response=await fetcher(`${baseUrl}${path}`,{method:'POST',headers:{...HEADERS,...(currentCookie?{cookie:currentCookie}:{})},body:JSON.stringify({refresh_token:refreshToken})});
  if(!response.ok)return {ok:false,status:401,error:'Reauthorization required.'};
  const data=await response.json();
  if(!data||typeof data.access_token!=='string'||(data.username!==undefined&&String(data.username)!==customerId))return {ok:false,status:401,error:'Reauthorization required.'};
  const expiresIn=Number.isFinite(Number(data.expires_in))?Math.max(60,Number(data.expires_in)):604800;
  return {ok:true,customerId,accessToken:data.access_token,refreshToken:typeof data.refresh_token==='string'?data.refresh_token:refreshToken,upstreamCookie:cookie(response.headers)??currentCookie,expiresAt:now()+expiresIn*1000};
}

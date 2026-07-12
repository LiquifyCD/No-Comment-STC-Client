export async function sendDoorRequest({fetcher,baseUrl,customerId,cardReader,accessToken,cookie}){
  const headers={accept:'application/json','content-type':'application/json','x-request-source':'mobilityapp','accept-language':'sv-SE',authorization:`Bearer ${accessToken}`};
  if(cookie)headers.cookie=cookie;
  return fetcher(`${baseUrl}/customers/${encodeURIComponent(customerId)}/passagetries`,{method:'POST',headers,body:JSON.stringify({cardReader,printTicket:true})});
}

const LOOKUP_HEADERS={accept:'application/json','x-request-source':'mobilityapp','accept-language':'sv-SE'};

export async function lookupPassageReader({fetcher,baseUrl,major,minor,cookie}){
  const url=new URL(`${baseUrl}/passagereaders`);url.searchParams.set('major',major);url.searchParams.set('minor',minor);
  const response=await fetcher(url.toString(),{headers:{...LOOKUP_HEADERS,...(cookie?{cookie}:{})}});
  if(!response.ok)return {ok:false,status:response.status===404?404:502};
  const data=await response.json().catch(()=>null);
  if(!data||!Number.isInteger(data.id)||data.id<=0)return {ok:false,status:502};
  return {ok:true,cardReader:data.id};
}

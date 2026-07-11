export async function sendDoorRequest({fetcher,baseUrl,customerId,cardReader,accessToken,cookie}){
  const headers={accept:'application/json','content-type':'application/json','x-request-source':'mobilityapp','accept-language':'sv-SE',authorization:`Bearer ${accessToken}`};
  if(cookie)headers.cookie=cookie;
  return fetcher(`${baseUrl}/customers/${encodeURIComponent(customerId)}/passagetries`,{method:'POST',headers,body:JSON.stringify({cardReader,printTicket:true})});
}

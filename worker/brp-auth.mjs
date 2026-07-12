const HEADERS={accept:'application/json','content-type':'application/json','x-request-source':'mobilityapp','accept-language':'sv-SE'};
function cookie(headers){return headers.get('set-cookie')?.split(';',1)[0]}

export async function authenticateBrp({fetcher,baseUrl,appId,email,password}){
  const config=await fetcher(`${baseUrl}/apps/${appId}?allowMultipleCompaniesAndBusinessUnits=true`,{headers:HEADERS});
  if(!config.ok)return {ok:false,status:502,error:'Request failed.'};
  const affinity=cookie(config.headers);
  const auth=await fetcher(`${baseUrl}/auth/login`,{method:'POST',headers:{...HEADERS,...(affinity?{cookie:affinity}:{})},body:JSON.stringify({username:email,password})});
  if(!auth.ok)return {ok:false,status:auth.status===401?401:502,error:auth.status===401?'Invalid credentials.':'Request failed.'};
  const data=await auth.json();
  if(!data||typeof data.access_token!=='string'||typeof data.username!=='string')return {ok:false,status:502,error:'Request failed.'};
  return {ok:true,customerId:data.username,accessToken:data.access_token,cookie:cookie(auth.headers)??affinity};
}

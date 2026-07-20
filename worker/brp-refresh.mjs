// No BRP refresh request may be implemented until an authorized capture verifies
// its exact method, path, headers, body, cookie behavior and response contract.
export const BRP_REFRESH_CONTRACT_VERIFIED=false;

export async function refreshBrpSession(_currentSession){
  return {ok:false,status:501,error:'Refresh contract unavailable.',reason:'contract_unavailable'};
}

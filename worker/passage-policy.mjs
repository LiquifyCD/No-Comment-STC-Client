const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validatePassageAttempt(input) {
  if (!input.originMatches) return { ok:false,status:403,error:'Otillåtet ursprung.' };
  if (!input.authenticatedCustomerId) return { ok:false,status:401,error:'Inte inloggad.' };
  if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) return { ok:false,status:400,error:'Ogiltig begäran.' };
  if ('customerId' in input.body) return { ok:false,status:400,error:'Kund-ID får inte skickas från klienten.' };
  if ('cardReader' in input.body) return { ok:false,status:400,error:'Kortläsare styrs av servern.' };
  if (!input.enabled || !input.authorizationId?.startsWith('APPROVED-')) return { ok:false,status:503,error:'Passagefunktionen är inte aktiverad.' };
  if (!Number.isInteger(input.allowedReader) || input.allowedReader <= 0) return { ok:false,status:503,error:'Ingen godkänd kortläsare är konfigurerad.' };
  if (input.body.confirmed !== true) return { ok:false,status:400,error:'Passagen måste bekräftas.' };
  if (typeof input.body.requestId !== 'string' || !REQUEST_ID_PATTERN.test(input.body.requestId)) return { ok:false,status:400,error:'Ogiltigt request-ID.' };
  if (input.replayed) return { ok:false,status:409,error:'Begäran har redan behandlats.' };
  if (input.recentAt !== null && input.now-input.recentAt<2_000) return { ok:false,status:429,error:'Vänta 2 sekunder innan nästa försök.' };
  return {ok:true,customerId:input.authenticatedCustomerId,cardReader:input.allowedReader,requestId:input.body.requestId,auditTimestamp:new Date(input.now).toISOString()};
}

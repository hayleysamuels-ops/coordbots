'use strict';
const crypto=require('crypto'),path=require('path');
const {OAuth2Client}=require('google-auth-library');
const {calendarTokenStore}=require('./calendar-token-store');
const FREEBUSY_SCOPE='https://www.googleapis.com/auth/calendar.events.freebusy';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const nonce=()=>crypto.randomBytes(32).toString('base64url');
function createGoogleCalendarConnection({tenantId,clientId,clientSecret,redirectUri,expectedEmail,keyHex,dataDir,ownerAllowed,now=()=>Date.now(),oauthFactory=options=>new OAuth2Client(options),store}){
  const missing=[];
  for(const [name,value] of Object.entries({SCHEDULING_CLIENT_ID:tenantId,GOOGLE_CALENDAR_CLIENT_ID:clientId,GOOGLE_CALENDAR_CLIENT_SECRET:clientSecret,GOOGLE_CALENDAR_REDIRECT_URI:redirectUri,GOOGLE_CALENDAR_EXPECTED_EMAIL:expectedEmail,GOOGLE_CALENDAR_ENCRYPTION_KEY:keyHex}))if(!value)missing.push(name);
  const pending=new Map();
  let vault=store;
  function ready(){
    if(missing.length)fail(503,'Google Calendar setup is incomplete. An administrator must configure the OAuth app.');
    let u;try{u=new URL(redirectUri);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/api/google-calendar/callback')throw Error();}catch(_){fail(503,'The Google Calendar redirect URI must be the HTTPS callback for this dashboard.');}
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedEmail)||!/^[a-f0-9]{64}$/i.test(keyHex))fail(503,'The Google account or token encryption configuration is invalid.');
    if(!vault)vault=calendarTokenStore({file:path.join(dataDir,'google-calendar-tokens.json'),keyHex,binding:JSON.stringify([tenantId,clientId,expectedEmail.toLowerCase()])});
  }
  const oauth=()=>oauthFactory({clientId,clientSecret,redirectUri,transporterOptions:{timeout:20000,retry:false}});
  function stored(){ready();let saved;try{saved=vault.load();}catch(_){fail(503,'The saved Google Calendar connection cannot be read. Contact the administrator.');}
    if(saved&&(saved.tenantId!==tenantId||saved.clientId!==clientId||saved.email!==expectedEmail.toLowerCase()))fail(409,'The saved Google account belongs to a different client.');return saved;}
  function allowed(){return typeof ownerAllowed==='function';}
  function scopesOK(scopes){const set=new Set(scopes);return set.has(FREEBUSY_SCOPE)&&set.has('openid')&&(set.has('email')||set.has('https://www.googleapis.com/auth/userinfo.email'))&&[...set].every(s=>[FREEBUSY_SCOPE,'openid','email','https://www.googleapis.com/auth/userinfo.email'].includes(s));}
  return {
    status(){if(missing.length)return {configured:false,connected:false,missing,expectedEmail:expectedEmail||null,redirectUri:redirectUri||null,scope:FREEBUSY_SCOPE};const saved=stored();return {configured:true,connected:!!saved,expectedEmail,redirectUri,scope:FREEBUSY_SCOPE,account:saved?.email||null,connectedAt:saved?.connectedAt||null,bookingEnabled:false};},
    async start(owner){ready();if(!allowed()||!await ownerAllowed(owner))fail(403,'Only an active coordinator can connect Google Calendar.');
      for(const [k,v] of pending)if(v.expiresAt<=now()||v.owner===owner)pending.delete(k);
      if(pending.size>=50)fail(429,'Too many sign-in attempts. Try again shortly.');
      const client=oauth(),pkce=await client.generateCodeVerifierAsync(),state=nonce(),browserToken=nonce(),identityNonce=nonce();
      pending.set(hash(state),{owner,browserHash:hash(browserToken),identityNonce,codeVerifier:pkce.codeVerifier,expiresAt:now()+600000});
      const url=client.generateAuthUrl({response_type:'code',scope:['openid','email',FREEBUSY_SCOPE],access_type:'offline',include_granted_scopes:false,prompt:'consent select_account',login_hint:expectedEmail,state,nonce:identityNonce,code_challenge:pkce.codeChallenge,code_challenge_method:'S256'});
      return {url,browserToken};
    },
    async finish({state,browserToken,code,error}){ready();if(typeof state!=='string'||state.length>256||typeof browserToken!=='string')fail(409,'Restart Google sign-in from this dashboard.');
      const key=hash(state),flow=pending.get(key);
      if(!flow||flow.expiresAt<=now()||flow.browserHash!==hash(browserToken))fail(409,'Google sign-in expired or belongs to another browser. Restart it.');
      pending.delete(key);
      if(!allowed()||!await ownerAllowed(flow.owner))fail(403,'The coordinator no longer has permission to connect calendars.');
      if(error)fail(409,'Google Calendar authorization was cancelled.');
      if(typeof code!=='string'||!code||code.length>8192)fail(422,'Google did not return an authorization code.');
      const client=oauth();let tokens;
      try{
        ({tokens}=await client.getToken({code,codeVerifier:flow.codeVerifier,redirect_uri:redirectUri}));
        if(!tokens.id_token||!tokens.access_token||!tokens.refresh_token)fail(409,'Google did not grant persistent read-only access. Restart sign-in and grant the requested access.');
        const ticket=await client.verifyIdToken({idToken:tokens.id_token,audience:clientId}),identity=ticket.getPayload();
        if(identity?.email_verified!==true||identity.email?.toLowerCase()!==expectedEmail.toLowerCase()||identity.nonce!==flow.identityNonce||!identity.sub)fail(409,'Sign in with the expected Luminai Google account.');
        const info=await client.getTokenInfo(tokens.access_token);
        if(info.aud!==clientId||!scopesOK(info.scopes))fail(409,'Google must grant only the requested identity and calendar availability permissions.');
        if(!await ownerAllowed(flow.owner))fail(403,'The coordinator permission changed during sign-in.');
        vault.save({tenantId,clientId,email:identity.email.toLowerCase(),subject:identity.sub,connectionId:nonce(),connectedAt:now(),owner:flow.owner,tokens:{access_token:tokens.access_token,refresh_token:tokens.refresh_token,expiry_date:tokens.expiry_date,token_type:tokens.token_type,scope:info.scopes.join(' ')}});
        return {connected:true,email:identity.email.toLowerCase()};
      }catch(e){if(tokens?.access_token)try{await client.revokeToken(tokens.access_token);}catch(_){}if(e.status)throw e;fail(503,'Google authorization could not be verified. No new connection was saved.');}
    },
    isCurrent(id){return stored()?.connectionId===id;},
    async access(){const saved=stored();if(!saved?.tokens?.refresh_token)fail(409,'Connect Google Calendar first.');const client=oauth();client.setCredentials(saved.tokens);
      client.on('tokens',tokens=>{if(vault.load()?.connectionId===saved.connectionId){saved.tokens={...saved.tokens,...tokens};delete saved.tokens.id_token;vault.save(saved);}});
      let token;try{({token}=await client.getAccessToken());}catch(_){fail(409,'Google Calendar authorization expired or was revoked. Reconnect the account.');}
      if(!token||stored()?.connectionId!==saved.connectionId)fail(409,'The Google connection changed. Read calendars again.');
      return {token,connectionId:saved.connectionId};
    },
    async disconnect(owner){ready();if(!allowed()||!await ownerAllowed(owner))fail(403,'Only an active coordinator can disconnect Google Calendar.');const saved=stored();if(!saved)return {connected:false,revoked:true};
      let revoked=false;try{await oauth().revokeToken(saved.tokens.refresh_token);revoked=true;}catch(_){}vault.clear();pending.clear();return {connected:false,revoked};
    }
  };
}
module.exports={createGoogleCalendarConnection,FREEBUSY_SCOPE};

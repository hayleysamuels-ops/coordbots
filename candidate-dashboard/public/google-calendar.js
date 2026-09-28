'use strict';
(()=>{
 const $=id=>document.getElementById(id);let credentials=null,version=0,busy=false;
 async function api(path,body){const r=await fetch('/api/google-calendar/'+path,{method:body===undefined?'GET':'POST',headers:{'X-Coordinator-Authorization':credentials,'Content-Type':'application/json','X-Scheduling-Request':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});const d=await r.json();if(!r.ok)throw Error(d.error||'Google Calendar could not be reached.');return d;}
 async function refresh(){const v=version,d=await api('status');if(v!==version||!credentials)return;
  $('account').textContent='Expected Google account: '+(d.expectedEmail||'Administrator setup required');
  $('status').textContent=d.connected?'Saved connection: '+d.account+'. Test it to verify current access.':d.configured?'Ready for Google sign-in.':'Google OAuth app setup is not complete yet.';
  $('connect').disabled=!d.configured;$('verify').disabled=!d.connected;$('disconnect').disabled=!d.connected;
  $('setup').open=!d.configured;$('redirect').textContent=d.redirectUri||location.origin+'/api/google-calendar/callback';$('missing').textContent=d.missing?.length?'Still needed: '+d.missing.join(', '):'';
 }
 $('login').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget;version++;credentials='Basic '+btoa(unescape(encodeURIComponent(f.username.value+':'+f.password.value)));try{await refresh();f.password.value='';f.hidden=true;$('workspace').hidden=false;const result=new URLSearchParams(location.search).get('connection');$('message').textContent=result==='saved'?'Google authorization was saved. Test the connection below.':result==='failed'?'Google authorization was not saved. Check the account and permissions, then try again.':'Calendar access stays read-only. Interviews still require coordinator approval.';history.replaceState(null,'',location.pathname);}catch(e){credentials=null;$('message').textContent=e.message;}};
 $('logout').onclick=()=>{version++;credentials=null;$('workspace').hidden=true;$('login').hidden=false;$('account').textContent='';$('status').textContent='';$('message').textContent='Signed out.';};
 async function action(fn){if(busy)return;busy=true;const v=version;for(const id of ['connect','verify','disconnect'])$(id).disabled=true;try{await fn(v);}catch(e){if(v===version)$('message').textContent=e.message;}finally{busy=false;if(credentials&&v===version)try{await refresh();}catch(e){$('message').textContent=e.message;}}}
 $('connect').onclick=()=>action(async v=>{const r=await api('start',{});if(v!==version||!credentials)return;const u=new URL(r.url);if(u.origin!=='https://accounts.google.com')throw Error('Unexpected authorization destination.');location.assign(u.href);});
 $('verify').onclick=()=>action(async v=>{$('message').textContent='Testing read-only availability access…';const r=await api('verify',{});if(v===version)$('message').textContent=r.message;});
 $('disconnect').onclick=()=>action(async v=>{const r=await api('disconnect',{});if(v===version)$('message').textContent=r.revoked?'Google Calendar disconnected and its authorization revoked.':'The saved connection was removed. Google revocation could not be confirmed; remove this app in your Google account’s third-party connections.';});
})();

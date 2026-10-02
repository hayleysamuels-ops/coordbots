'use strict';
// The safeguards on the one page the reader clicks: Ashby's schedule template
// editor. These run a real browser against a page written here, so they test
// the safeguards themselves (what's blocked, what's refused, when reading
// stops), not Ashby's markup; that's only known from a live read.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {guardWrites,classify}=require('../worker/template-guard');
const {readPlan}=require('../worker/plan-reader');

test('only reads get through: GET, and GraphQL whose every operation is a query',()=>{
  const gql=(...ops)=>JSON.stringify(ops.length===1?ops[0]:ops);
  const url='https://app.ashbyhq.com/api/graphql?x=secret';
  assert.equal(classify({method:'GET',url}).allow,true);
  assert.equal(classify({method:'POST',url,postData:gql({operationName:'Template',query:'query Template { a }'})}).allow,true);
  assert.equal(classify({method:'POST',url,postData:gql({query:'# note\n{ a }'})}).allow,true);
  const save=classify({method:'POST',url,postData:gql({operationName:'SaveTemplate',query:'mutation SaveTemplate { a }'})});
  assert.deepEqual([save.allow,save.mutation,save.summary],[false,true,'POST /api/graphql mutation SaveTemplate']);
  assert.equal(classify({method:'POST',url,postData:gql({operationName:'A',query:'query A { a }'},{operationName:'B',query:'mutation B { b }'})}).mutation,true);
  // A persisted operation with no query text can't be classified, so it's blocked.
  assert.equal(classify({method:'POST',url,postData:gql({operationName:'Thing',extensions:{persistedQuery:{sha256Hash:'abc'}}})}).allow,false);
  assert.equal(classify({method:'POST',url,postData:'name=x&save=1'}).summary,'POST /api/graphql (not GraphQL)');
  for(const method of ['PUT','PATCH','DELETE'])assert.equal(classify({method,url}).allow,false);
});

let chromium=null;
try{chromium=require('../worker/node_modules/playwright').chromium;}catch(_){}
async function launch(){
  if(!chromium)return null;
  for(const options of [{},{channel:'chrome'}]){try{return await chromium.launch({headless:true,...options});}catch(_){}}
  return null;
}

const URL='https://app.ashbyhq.com/schedules/s1/template/events';
// Two collapsed events. `onExpand` is script run inside the expander's click
// handler, to stand in for whatever Ashby might do on expanding.
function templateHtml({onExpand='',expander='<a href="#" class="exp">Interviewers</a>'}={}){
  const event=(title,minutes,person)=>`<div class="event"><div class="row"><span>${title}</span> <input type="number" value="${minutes}"> min <span>Configure: ${expander} | <a href="#">Room</a></span></div>
    <div class="slots" hidden><div>Slot #1 —</div><div>1 Eligible Match</div><div>Specific Employees:</div><div>1 Employees</div><div>${person}</div><button type="button">Add Interviewer Slot</button></div></div>`;
  return `<!doctype html><h1>Template</h1><h2>Events</h2>${event('Welcome',15,'Pat Doe')}${event('Lunch',30,'Sam Roe')}
  <script>window.clicks=0;document.addEventListener('click',e=>{const x=e.target.closest('.exp');if(!x)return;e.preventDefault();window.clicks++;x.closest('.event').querySelector('.slots').hidden=false;${onExpand}});</script>`;
}
const input={activities:[{sessions:[{sessionId:'a',interviewId:'i1',title:'Welcome',durationMinutes:15},{sessionId:'b',interviewId:'i2',title:'Lunch',durationMinutes:30}]}]};

async function read(t,html){
  const browser=await launch();
  if(!browser){t.skip('no Chromium available');return null;}
  const received=[],logs=[];
  try{
    const context=await browser.newContext({serviceWorkers:'block'});
    // Stands in for Ashby: serves the page and records every request that reaches it.
    await context.route('**/*',route=>{const r=route.request();received.push(`${r.method()} ${new globalThis.URL(r.url()).pathname} ${r.postData()||''}`);
      return r.url()===URL?route.fulfill({contentType:'text/html',body:html}):route.fulfill({contentType:'application/json',body:'{}'});});
    const guard=await guardWrites(context,{warn:m=>logs.push(m)});
    const page=await context.newPage();
    await page.goto(URL);
    const result=await readPlan(page,input,{guard}).then(r=>({ok:r}),e=>({error:e}));
    return {...result,received,logs,clicks:await page.evaluate(()=>window.clicks),guard};
  }finally{await browser.close();}
}

test('collapsed events are expanded by their "Interviewers" control and then read',async t=>{
  const r=await read(t,templateHtml());if(!r)return;
  assert.equal(r.error,undefined,r.error?.message);
  assert.deepEqual(r.ok.sessions.map(s=>[s.title,s.eligibleInterviewers[0].name]),[['Welcome','Pat Doe'],['Lunch','Sam Roe']]);
  assert.equal(r.clicks,2);
  assert.deepEqual(r.guard.blocked,[]);
});

test('a save Ashby tries to send while expanding is blocked before it leaves the browser, and reading stops',async t=>{
  const r=await read(t,templateHtml({onExpand:`fetch('/api/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operationName:'SaveEvent',query:'mutation SaveEvent { a }'})});`}));if(!r)return;
  assert.equal(r.error?.kind,'read');
  assert.match(r.error.message,/Ashby tried to send a change while the template was being read \(POST \/api\/graphql mutation SaveEvent\), and it was blocked\./);
  assert.match(r.error.message,/no change could have been saved/);
  assert.equal(r.received.filter(x=>/mutation/.test(x)).length,0,'the mutation reached the server');
  assert.equal(r.clicks,1,'kept clicking after a write');
  assert.match(r.logs.join('\n'),/Blocked a write during expanding: POST \/api\/graphql mutation SaveEvent/);
});

test('a beacon or form post is blocked too, not just GraphQL',async t=>{
  const r=await read(t,templateHtml({onExpand:`navigator.sendBeacon('/api/autosave','x=1');`}));if(!r)return;
  assert.match(r.error?.message||'',/\(POST \/api\/autosave \(not GraphQL\)\), and it was blocked/);
  assert.equal(r.received.filter(x=>/autosave/.test(x)).length,0);
});

test('if expanding puts the cursor in a field, reading stops without another click',async t=>{
  const r=await read(t,templateHtml({onExpand:`const f=document.createElement('input');x.closest('.event').append(f);f.focus();`}));if(!r)return;
  assert.match(r.error?.message||'',/^Expanding "Welcome" put the cursor in a field\. Reading stopped before anything else was clicked/);
  assert.equal(r.clicks,1);
});

test('a field that changes on the page fails the read',async t=>{
  const r=await read(t,templateHtml({onExpand:`document.querySelector('input[type=number]').value='45';`}));if(!r)return;
  assert.match(r.error?.message||'',/changed on the page while (it|the template) was being read/);
});

test('an "Interviewers" control that is a submit button, a form field or plain text is never clicked',async t=>{
  for(const [expander,pattern] of [
    ['<form><button class="exp">Interviewers</button></form>',/would submit a form/],
    ['<span class="exp">Interviewers</span>',/isn't a link or button \(span\)/],
    ['<span class="exp" aria-label="Interviewers"><svg></svg></span>',/it has no "Interviewers" control\. The row holds: input "15"; span\[label="Interviewers"\] ""; svg ""; a\[href=\/schedules\/s1\/template\/events\] "Room"; span "Welcome"\./],
    ['<a class="exp" href="/jobs/elsewhere">Interviewers</a>',/leaves this template \(\/jobs\/elsewhere\)/],
  ]){
    const r=await read(t,templateHtml({expander}));if(!r)return;
    assert.match(r.error?.message||'',pattern,expander);
    assert.match(r.error.message,/^"Welcome" couldn't be expanded safely/);
    assert.equal(r.clicks,0,expander);
  }
});

test('WebSockets are held closed',async t=>{
  const r=await read(t,templateHtml().replace('<script>','<script>try{new WebSocket("wss://app.ashbyhq.com/socket").onopen=()=>{window.opened=true;};}catch(_){}'));if(!r)return;
  assert.equal(r.error,undefined,r.error?.message);
  assert.ok(r.guard.sockets>=1);
});

// The live layout as far as it's known: the row holds the name button,
// duration, "Configure" and a "Room" button, with no Interviewers pill because
// that section is already showing. The section ("Interviewers 1", the slot and
// its names) isn't inside the row's block; here it's a sibling in a list that
// holds every event, so widening the row would swallow the next event. It must
// be read in place, with nothing clicked.
test('slots already on the page are read where they are, with no click',async t=>{
  const event=(title,minutes,names)=>`<div class="row"><button type="button"><span>${title}</span><svg role="img"></svg></button>
    <input type="number" value="${minutes}"><span>min</span><span>Configure</span><button type="button"><span>Room</span></button><button type="button"><svg role="img"></svg></button></div>
    <section><h4>Interviewers <span>1</span></h4><div>Slot #1 —</div><div><span>${names.length}</span> Eligible Matches</div><div>Specific Employees:</div><div>${names.length} Employees</div>${names.map((n,i)=>`<div>${i?'OR ':''}${n}</div>`).join('')}<button type="button">Add Interviewer Slot</button></section>`;
  const html=`<!doctype html><h2>Events</h2><div class="list">${event('Welcome',15,['Pat Doe','Lee Kim'])}${event('Lunch',30,['Sam Roe'])}</div>
    <script>window.clicks=0;document.addEventListener('click',()=>window.clicks++,true);</script>`;
  const r=await read(t,html);if(!r)return;
  assert.equal(r.error,undefined,r.error?.message);
  assert.deepEqual(r.ok.sessions.map(s=>[s.title,s.eligibleInterviewers.map(i=>i.name)]),[['Welcome',['Pat Doe','Lee Kim']],['Lunch',['Sam Roe']]]);
  assert.equal(r.clicks,0);
});

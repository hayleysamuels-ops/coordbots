'use strict';
// The submitted-availability reader, against a page built to match the live
// grid as measured on October 2, 2026 (worker log): class names carry a build
// hash and are matched by prefix only; each week opens collapsed to
// 6 AM–8 PM; the scale is 48px an hour with the end hour labels clamped 8px
// inward; each submitted window is a _block_ labelled with its own times.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {readAvailability,parseBlocks,collectBlocks,gridReady,showAllHours,describeGrid,measureGrid}=require('../worker/availability-reader');

let chromium=null;try{chromium=require('../worker/node_modules/playwright').chromium;}catch(_){}
async function launch(t){
  if(!chromium){t.skip('no Playwright');return null;}
  for(const o of [{},{channel:'chrome'}]){try{return await chromium.launch({headless:true,...o});}catch(_){}}
  t.skip('no Chromium available');return null;
}

// The week of Oct 4, 2026 with the candidate's two six-hour windows.
const WEEK=['Sun 4','Mon 5','Tue 6','Wed 7','Thu 8','Fri 9','Sat 10'];
const NAMES=['Sunday Oct 4','Monday Oct 5','Tuesday Oct 6','Wednesday Oct 7','Thursday Oct 8','Friday Oct 9','Saturday Oct 10'];
const BLOCKS={4:[[11,17,'11:00 AM – 5:00 PM']],5:[[9,15,'9:00 AM – 3:00 PM']]};
function page_({picker='Oct 4, 2026',headers=WEEK,blocks=BLOCKS,skew=null}={}){
  return `<!doctype html><input placeholder="Set date to view..." value="${picker}"><div>America/Denver</div>
  <div class="_grid_qq7z1_2 _weekGrid_k3j_14">
    <div class="_headerRow_qq7z1_12" style="display:flex;margin-left:60px">${headers.map(h=>`<div class="_dayHeader_qq7z1_26" style="width:90px"><span><span class="_dayLabel_qq7z1_41">${h}</span></span></div>`).join('')}</div>
    <button type="button" class="_expander_qq7z1_61" id="top">Show 12 AM – 6 AM</button>
    <div class="_bodyRow_qq7z1_86" style="display:flex"><div id="gutter" style="position:relative;width:60px"></div><div class="_body_qq7z1_86" id="body" style="display:flex"></div></div>
    <button type="button" class="_expander_qq7z1_61 _bottom_qq7z1_81" id="bottom">Show 8 PM – 12 AM</button>
  </div>
  <script>(()=>{
    const NAMES=${JSON.stringify(NAMES)},BLOCKS=${JSON.stringify(blocks)},SKEW=${JSON.stringify(skew)};
    let start=6,end=20;window.removed=0;window.expanded=0;
    const label=h=>{const x=h%24;return (x%12||12)+' '+(x<12?'AM':'PM');};
    function render(){
      const g=document.getElementById('gutter'),b=document.getElementById('body');g.style.height=(end-start)*48+'px';
      g.innerHTML='';for(let h=start;h<=end;h++){const y=(h-start)*48+(h===start?8:h===end?-8:0)+(SKEW&&SKEW[0]===h?SKEW[1]:0);g.insertAdjacentHTML('beforeend','<div style="position:absolute;top:'+y+'px">'+label(h)+'</div>');}
      b.innerHTML=NAMES.map((n,i)=>'<div class="_column_qq7z1_142" role="group" aria-label="Availability for '+n+'" style="position:relative;width:90px;height:'+(end-start)*48+'px">'+
        (BLOCKS[i]||[]).map(([s,e,t])=>'<div class="_block_qq7z1_3" aria-label="'+n+' '+t+'" style="position:absolute;top:'+(s-start)*48+'px;height:'+((e-s)*48-1)+'px;width:80px;background:rgb(96, 86, 207)"><div class="_blockLabel_qq7z1_5">'+t+'</div><div class="_blockDuration_qq7z1_6">'+(e-s)+'h</div><button type="button" class="_removeButton_qq7z1_7" aria-label="Remove '+n+' '+t+'" onclick="window.removed++">×</button></div>').join('')+'</div>').join('');
    }
    document.getElementById('top').onclick=e=>{window.expanded++;start=start?0:6;e.target.textContent=start?'Show 12 AM – 6 AM':'Hide 12 AM – 6 AM';render();};
    document.getElementById('bottom').onclick=e=>{window.expanded++;end=end===20?24:20;e.target.textContent=end===20?'Show 8 PM – 12 AM':'Hide 8 PM – 12 AM';render();};
    render();
  })();</script>`;
}
const guard=(problem=null)=>({phase:'load',expanding(){this.phase='expanding';},problem:()=>problem});

test('the live layout reads: both hour ranges shown, then each window from its own label, cross-checked by position',async t=>{
  const browser=await launch(t);if(!browser)return;
  try{
    const page=await browser.newPage();await page.setContent(page_());
    assert.equal(await page.evaluate(gridReady),true);
    const g=guard();
    assert.equal(await showAllHours(page,g),null);
    assert.equal(g.phase,'expanding');
    assert.equal(await page.evaluate(()=>window.expanded),2);
    assert.equal(await page.evaluate(()=>window.removed),0,'a Remove button was clicked');
    const data=await page.evaluate(collectBlocks);
    assert.equal(data.error,undefined,data.error);
    assert.deepEqual([data.startHour,data.endHour,data.pxPerHour],[0,24,48]);
    assert.deepEqual(data.days.map(d=>d.date),['2026-10-04','2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09','2026-10-10']);
    const week=parseBlocks(data);
    // Denver is UTC−6 in October.
    assert.deepEqual(week.windows,[{start:'2026-10-08T17:00:00.000Z',end:'2026-10-08T23:00:00.000Z'},{start:'2026-10-09T15:00:00.000Z',end:'2026-10-09T21:00:00.000Z'}]);
    assert.deepEqual([week.timezone,week.start,week.end],['America/Denver','2026-10-04','2026-10-10']);
    // Already shown: nothing more is clicked.
    assert.equal(await showAllHours(page,g),null);assert.equal(await page.evaluate(()=>window.expanded),2);
  }finally{await browser.close();}
});

test('without the write guard no expander is clicked, so hidden hours make the week unreadable',async t=>{
  const browser=await launch(t);if(!browser)return;
  try{
    const page=await browser.newPage();await page.setContent(page_());
    assert.match(await showAllHours(page,null),/the write guard isn't active, so nothing was clicked/);
    assert.equal(await page.evaluate(()=>window.expanded),0);
    // Read collapsed anyway, the week is refused rather than read short.
    const collapsed=await page.evaluate(collectBlocks);
    assert.deepEqual([collapsed.startHour,collapsed.endHour],[6,20]);
    assert.throws(()=>parseBlocks(collapsed),/showed only 6:00 to 20:00 after its hours were expanded, so windows outside that range could be missing/);
  }finally{await browser.close();}
});

test('a write Ashby sends while the hours are being shown stops the read',async t=>{
  const browser=await launch(t);if(!browser)return;
  try{
    const page=await browser.newPage();await page.setContent(page_());
    await assert.rejects(showAllHours(page,guard({summary:'POST /api/graphql mutation SaveAvailability'})),/Ashby tried to send a change while the availability grid was being read \(POST \/api\/graphql mutation SaveAvailability\), and it was blocked\. Nothing was saved\./);
    assert.equal(await page.evaluate(()=>window.expanded),1,'kept clicking after a blocked write');
  }finally{await browser.close();}
});

test('the hour scale is measured, not assumed: a non-linear interior label refuses the week',async t=>{
  const browser=await launch(t);if(!browser)return;
  try{
    const page=await browser.newPage();await page.setContent(page_({skew:[12,10]}));
    await showAllHours(page,guard());
    assert.match((await page.evaluate(collectBlocks)).error,/^the hour scale isn't linear: 11:00 to 12:00 is 58px, against 48\.0px an hour from the column$/);
  }finally{await browser.close();}
});

test('day headers are dated from the week picker, and every mismatch is refused',async t=>{
  const browser=await launch(t);if(!browser)return;
  try{
    const page=await browser.newPage();
    for(const [opts,pattern] of [
      [{picker:'Oct 18, 2026'},/^the header "Sun 4" doesn't match the week picker \(Oct 18, 2026\)$/],
      [{headers:['Mon 4',...WEEK.slice(1)]},/^the header "Mon 4" doesn't match the week picker/],
      [{headers:[...WEEK.slice(0,6),'Sat 11']},/^the header "Sat 11" doesn't match the week picker/],
      [{picker:''},/^the week picker's date could not be read/],
    ]){
      await page.setContent(page_(opts));await showAllHours(page,guard());
      assert.match((await page.evaluate(collectBlocks)).error,pattern,JSON.stringify(opts));
    }
    // A month boundary dates correctly: Sun 27 to Sat 3.
    await page.setContent(page_({picker:'Sep 27, 2026',headers:['Sun 27','Mon 28','Tue 29','Wed 30','Thu 1','Fri 2','Sat 3'],blocks:{}}).replace(/Sunday Oct 4","Monday Oct 5","Tuesday Oct 6","Wednesday Oct 7","Thursday Oct 8","Friday Oct 9","Saturday Oct 10/,'Sunday Sep 27","Monday Sep 28","Tuesday Sep 29","Wednesday Sep 30","Thursday Oct 1","Friday Oct 2","Saturday Oct 3'));
    await showAllHours(page,guard());
    const data=await page.evaluate(collectBlocks);
    assert.deepEqual(data.days.map(d=>d.date),['2026-09-27','2026-09-28','2026-09-29','2026-09-30','2026-10-01','2026-10-02','2026-10-03']);
    assert.deepEqual(parseBlocks(data).windows,[],'an empty week reads as no windows, not unreadable');
  }finally{await browser.close();}
});

// parseBlocks on its own: every disagreement refuses rather than guesses.
const day=(date,label,blocks=[])=>({date,label:`Availability for ${label}`,height:1152,blocks});
const week=blocks=>({timezone:'America/Denver',startHour:0,endHour:24,pxPerHour:48,days:[
  day('2026-10-04','Sunday Oct 4'),day('2026-10-05','Monday Oct 5'),day('2026-10-06','Tuesday Oct 6'),day('2026-10-07','Wednesday Oct 7'),
  day('2026-10-08','Thursday Oct 8',blocks),day('2026-10-09','Friday Oct 9'),day('2026-10-10','Saturday Oct 10')]});
test('a block whose label and position disagree is refused, not shifted',()=>{
  assert.equal(parseBlocks(week([{label:'Thursday Oct 8 11:00 AM – 5:00 PM',top:528,height:287}])).windows.length,1);
  // One hour off: exactly the silent shift a misread scale would cause.
  assert.throws(()=>parseBlocks(week([{label:'Thursday Oct 8 11:00 AM – 5:00 PM',top:480,height:287}])),/is labelled "Thursday Oct 8 11:00 AM – 5:00 PM" but drawn at 480px, 287px tall, where that time would be 528px, 288px tall/);
  assert.throws(()=>parseBlocks(week([{label:'Friday Oct 9 11:00 AM – 5:00 PM',top:528,height:287}])),/in Thursday Oct 8's column is labelled for Friday Oct 9/);
  assert.throws(()=>parseBlocks(week([{label:'Thursday Oct 8 5:00 PM – 11:00 AM',top:816,height:-288}])),/ends before it starts/);
  assert.throws(()=>parseBlocks(week([{label:'Thursday Oct 8 sometime',top:0,height:0}])),/couldn't be read/);
  // Only part of the day showing: windows could be hidden, so it refuses.
  assert.throws(()=>parseBlocks({...week([]),startHour:6,endHour:20}),/showed only 6:00 to 20:00 after its hours were expanded/);
  const wrongDay=week([]);wrongDay.days[4].label='Availability for Friday Oct 9';
  assert.throws(()=>parseBlocks(wrongDay),/doesn't match its header date \(2026-10-08\)/);
});
test('a window ending at midnight ends at 00:00 the next day',()=>{
  assert.deepEqual(parseBlocks(week([{label:'Thursday Oct 8 9:00 PM – 12:00 AM',top:1008,height:143}])).windows,[{start:'2026-10-09T03:00:00.000Z',end:'2026-10-09T06:00:00.000Z'}]);
});

test('logged descriptions carry class prefixes, never build hashes',async t=>{
  const browser=await launch(t);if(!browser)return;
  try{
    const page=await browser.newPage();await page.setContent(page_());
    for(const seen of [await page.evaluate(describeGrid),await page.evaluate(measureGrid)])assert.doesNotMatch(seen,/qq7z1|k3j/,seen);
    assert.match(await page.evaluate(describeGrid),/^7 day headers \(Sun 4, Mon 5, Tue 6, Wed 7, Thu 8, Fri 9, Sat 10\); week picker shows "Oct 4, 2026"; grid div\.grid\.weekGrid with children div\.headerRow, button\.expander, div\.bodyRow, button\.expander\.bottom$/);
  }finally{await browser.close();}
});

// The week loop, through a fake page: unreadable weeks are skipped and named,
// and the read fails only when no week can be read.
test('unreadable weeks are skipped and named; a read with no readable week fails',async()=>{
  const starts=['2026-09-27','2026-10-04','2026-10-11','2026-10-18','2026-10-25','2026-11-01'];
  const data=start=>{const s=Date.parse(start+'T12:00:00Z'),W=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return {timezone:'America/Denver',startHour:0,endHour:24,pxPerHour:48,days:Array.from({length:7},(_,i)=>{const d=new Date(s+i*86400000),n=`${W[d.getUTCDay()]} ${M[d.getUTCMonth()]} ${d.getUTCDate()}`;
      return {date:d.toISOString().slice(0,10),label:`Availability for ${n}`,height:1152,blocks:i===4?[{label:`${n} 11:00 AM – 5:00 PM`,top:528,height:287}]:[]};})};};
  const fake=readable=>{let w=0;
    return {waitForTimeout:async()=>{},getByText:()=>({waitFor:async()=>{}}),getByRole:()=>({waitFor:async()=>{},isChecked:async()=>false}),
      getByPlaceholder:()=>({waitFor:async()=>{},inputValue:async()=>starts[w]}),
      waitForFunction:async fn=>{if(fn===gridReady&&!readable.includes(w+1))throw Object.assign(Error('Timeout 15000ms exceeded.'),{name:'TimeoutError'});},
      evaluateHandle:async()=>({asElement:()=>null,jsonValue:async()=>'none'}),
      evaluate:async fn=>fn===collectBlocks?data(starts[w]):fn===describeGrid||fn===measureGrid?'described':0,
      locator:()=>({nth:()=>({click:async()=>{w++;}})})};};
  const warn=console.warn,logs=[];console.warn=m=>logs.push(String(m));
  try{
    const r=await readAvailability(fake([2,3,4,5,6]),{},{guard:guard()});
    assert.deepEqual(r.unreadWeeks,[{week:1,shown:'2026-09-27'}]);
    assert.equal(r.windows.length,5);
    assert.equal(r.windows[0].start,'2026-10-08T17:00:00.000Z');
    assert.deepEqual(r.scope,{start:'2026-10-04',end:'2026-11-07'});
    assert.match(logs.join('\n'),/Week 1 \(2026-09-27\) not read: its grid of 7 day columns didn't load/);
    await assert.rejects(readAvailability(fake([]),{},{guard:guard()}),/None of the 6 weeks of submitted availability could be read, so it isn't known whether the candidate has any\. Week 1 \(2026-09-27\): its grid of 7 day columns didn't load\.$/);
  }finally{console.warn=warn;}
});

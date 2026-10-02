'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {parseGrid}=require('../worker/availability-reader');
function grid(){return {timezone:'Etc/UTC',columns:Array.from({length:7},(_,i)=>({date:'2026-09-'+String(27+i).padStart(2,'0'),selected:Array(96).fill(false)})).map((c,i)=>({...c,date:new Date(Date.UTC(2026,8,27+i)).toISOString().slice(0,10)}))};}
test('quarter-hour grid preserves candidate-submitted blocks and merges adjacent quarters',()=>{const g=grid();for(const c of [g.columns[1],g.columns[2]])for(let i=52;i<84;i++)c.selected[i]=true;const r=parseGrid(g);assert.deepEqual(r.windows,[{start:'2026-09-28T13:00:00.000Z',end:'2026-09-28T21:00:00.000Z'},{start:'2026-09-29T13:00:00.000Z',end:'2026-09-29T21:00:00.000Z'}]);});
test('empty complete grids are distinct from incomplete grids',()=>{assert.deepEqual(parseGrid(grid()).windows,[]);const g=grid();g.columns[0].selected.pop();assert.throws(()=>parseGrid(g),/layout changed/);});
test('split windows stay separate and midnight uses the following date',()=>{const g=grid();g.columns[0].selected[40]=true;g.columns[0].selected[95]=true;const r=parseGrid(g);assert.equal(r.windows.length,2);assert.equal(r.windows[1].end,'2026-09-28T00:00:00.000Z');});

// When the grid can't be read, the refusal says what the page held instead of
// only "could not be read completely". Runs in a real browser when one exists.
test('an unreadable availability grid is described: headers, timezone labels and cells found',async t=>{
  let chromium;try{chromium=require('../worker/node_modules/playwright').chromium;}catch(_){return t.skip('no Playwright');}
  let browser=null;for(const o of [{},{channel:'chrome'}]){try{browser=await chromium.launch({headless:true,...o});break;}catch(_){}}
  if(!browser)return t.skip('no Chromium available');
  try{
    const page=await browser.newPage();
    const {describeGrid}=require('../worker/availability-reader');
    // Headers as Ashby renders them now: the description says what's under the
    // first and last day, not only that the expected cells are missing.
    await page.setContent(`<h1>Candidate Availability</h1><input placeholder="Set date to view..." value="09/27/2026"><div>America/Denver</div>
      <div style="display:flex"><div class="col past" style="width:80px"><div class="hd">Sun 27</div><div class="body"><span class="blk" style="display:block;height:200px"></span></div></div>
      <div class="col" style="width:80px"><div class="hd">Sat 3</div><div class="body"><div class="q on" style="height:10px;background:rgb(1, 2, 3)"></div><div class="q" style="height:10px"></div></div></div></div>`);
    const seen=await page.evaluate(describeGrid);
    assert.match(seen,/^2 day headers \(Sun 27, Sat 3\); week picker shows "09\/27\/2026"; timezone labels: America\/Denver; 0 cells with the class the reader expects; under the headers: /);
    assert.match(seen,/"Sun 27": header div\.hd < div\.col\.past < div < body; column div\.col\.past with 2 children \(div\.hd ×1, div\.body ×1\) and 3 descendants; 2 elements below its centre \(div\.body ×1, span\.blk ×1\); 0 cell-sized leaves/);
    assert.match(seen,/ \| "Sat 3": header div\.hd < div\.col < div < body; column div\.col with 2 children \(div\.hd ×1, div\.body ×1\) and 4 descendants; 3 elements below its centre \(div\.body ×1, div\.q\.on ×1, div\.q ×1\); 2 cell-sized leaves \(fills rgb\(1, 2, 3\) ×1, rgba\(0, 0, 0, 0\) ×1\)$/);
  }finally{await browser.close();}
});

// A week that can't be read is skipped and recorded, not fatal, and the read
// fails only when no week can be read. Driven through a fake page: real
// timeouts would take 15 seconds a week.
test('unreadable weeks are skipped and named; a read with no readable week fails',async()=>{
  const {readAvailability,collectGrid,describeGrid}=require('../worker/availability-reader');
  const day=(d,on)=>({date:d,selected:Array.from({length:96},(_,i)=>on&&i>=36&&i<60)});
  const grid=start=>{const s=Date.parse(start+'T12:00:00Z');return {timezone:'America/Denver',columns:Array.from({length:7},(_,i)=>day(new Date(s+i*86400000).toISOString().slice(0,10),i===4))};};
  const fake=readable=>{let week=0;const starts=['2026-09-27','2026-10-04','2026-10-11','2026-10-18','2026-10-25','2026-11-01'];
    return {waitForTimeout:async()=>{},getByText:()=>({waitFor:async()=>{}}),getByRole:()=>({waitFor:async()=>{},isChecked:async()=>false}),
      getByPlaceholder:()=>({waitFor:async()=>{},inputValue:async()=>starts[week]}),
      waitForFunction:async(fn)=>{if(fn===collectGrid){if(!readable.includes(week+1))throw Object.assign(Error('Timeout 15000ms exceeded.'),{name:'TimeoutError'});return {jsonValue:async()=>grid(starts[week])};}},
      evaluate:async(fn)=>fn===describeGrid?'7 day headers (Sun 27 ...)':0,
      locator:()=>({nth:()=>({click:async()=>{week++;}})})};};
  const warn=console.warn;console.warn=()=>{};
  try{
    const r=await readAvailability(fake([2,3,4,5,6]));
    assert.deepEqual(r.unreadWeeks,[{week:1,shown:'2026-09-27'}]);
    // Thursday of each readable week, 09:00–15:00 Denver.
    assert.equal(r.windows.length,5);
    assert.equal(r.windows[0].start,'2026-10-08T15:00:00.000Z');
    assert.deepEqual(r.scope,{start:'2026-10-04',end:'2026-11-07'});
    await assert.rejects(readAvailability(fake([])),/None of the 6 weeks of submitted availability could be read, so it isn't known whether the candidate has any\. Week 1: The reader needs 7 consecutive day headers \("Sun 27", dated from the week picker\)/);
  }finally{console.warn=warn;}
});

// Ashby's current day headers ("Sun 27") are dated from the week picker
// ("Sep 27, 2026"), across the month boundary, and refused if the picker,
// the weekday or the sequence disagrees.
test('"Sun 27" day headers are dated from the week picker, and mismatches are refused',async t=>{
  let chromium;try{chromium=require('../worker/node_modules/playwright').chromium;}catch(_){return t.skip('no Playwright');}
  let browser=null;for(const o of [{},{channel:'chrome'}]){try{browser=await chromium.launch({headless:true,...o});break;}catch(_){}}
  if(!browser)return t.skip('no Chromium available');
  const {collectGrid}=require('../worker/availability-reader');
  const page_=(picker,labels)=>`<input placeholder="Set date to view..." value="${picker}"><div>America/Denver</div><div style="display:flex">${labels.map((l,d)=>`<div style="width:60px"><div>${l}</div>${Array.from({length:96},(_,q)=>`<div class="_slice_a${d===4&&q>=36&&q<60?' _selected_b':''}" style="height:2px"></div>`).join('')}</div>`).join('')}</div>`;
  const week=['Sun 27','Mon 28','Tue 29','Wed 30','Thu 1','Fri 2','Sat 3'];
  try{
    const page=await browser.newPage();
    await page.setContent(page_('Sep 27, 2026',week));
    const grid=await page.evaluate(collectGrid);
    assert.equal(grid.timezone,'America/Denver');
    assert.deepEqual(grid.columns.map(c=>c.date),['2026-09-27','2026-09-28','2026-09-29','2026-09-30','2026-10-01','2026-10-02','2026-10-03']);
    assert.equal(grid.columns[4].selected.filter(Boolean).length,24);
    for(const [picker,labels] of [['Oct 11, 2026',week],['Sep 27, 2026',['Mon 27',...week.slice(1)]],['Sep 27, 2026',[...week.slice(0,6),'Sat 4']],['',week]]){
      await page.setContent(page_(picker,labels));
      assert.equal(await page.evaluate(collectGrid),null,`${picker} ${labels.join(',')}`);
    }
    // The older dated form still reads.
    await page.setContent(page_('',['SUN 9/27/2026','MON 9/28/2026','TUE 9/29/2026','WED 9/30/2026','THU 10/1/2026','FRI 10/2/2026','SAT 10/3/2026']));
    assert.equal((await page.evaluate(collectGrid)).columns[0].date,'2026-09-27');
  }finally{await browser.close();}
});

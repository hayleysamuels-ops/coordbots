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
    await page.setContent('<h1>Candidate Availability</h1><div>THU 10/8/2026</div><div>FRI 10/9/2026</div><div>America/Los_Angeles</div><div class="x_cell_1"></div>');
    const {describeGrid}=require('../worker/availability-reader');
    assert.equal(await page.evaluate(describeGrid),'2 day headers (THU 10/8/2026, FRI 10/9/2026); timezone labels: America/Los_Angeles; 0 grid cells; grid-like classes: x_cell_1');
  }finally{await browser.close();}
});

#!/usr/bin/env node
'use strict';
// Runs the booking dry run (worker/booking-composer.js) locally, in Chrome,
// with a signed-in Ashby browser profile: every step up to "Schedule", which
// is never clicked, then the draft is deleted. For development against a test
// candidate only; production runs in the worker with its saved session.
//
//   node scripts/booking-dry-run-local.js --profile <dir> --plan <plan.json> [--headed] [--debug-snapshot <file>] [--timeout-seconds <n>]
//
// The whole run has a deadline (default 300 seconds): past it, the script
// exits with an error rather than waiting on, since a wait that can't fail
// looks the same as work in progress. A run stopped that way may not have
// deleted its draft, and says so.
//
// --debug-snapshot saves the page's accessibility tree where the run stopped.
// It can include calendar details: keep it local and delete it after use.
//
// The profile must already be signed in to Ashby. The plan is the approved
// agenda (see worker/booking-check.js for its shape).
const fs=require('fs'),path=require('path');
const {chromium}=require('../worker/node_modules/playwright');
const {dryRun}=require('../worker/booking-composer');

const arg=name=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:null;};
const profile=arg('--profile'),planFile=arg('--plan'),headed=process.argv.includes('--headed'),snapshotFile=arg('--debug-snapshot');
const timeoutSeconds=Number(arg('--timeout-seconds')||300);
if(!profile||!planFile||!(timeoutSeconds>0)){console.error('Usage: booking-dry-run-local.js --profile <dir> --plan <plan.json> [--headed] [--debug-snapshot <file>] [--timeout-seconds <n>]');process.exit(2);}
const plan=JSON.parse(fs.readFileSync(planFile,'utf8'));
const executablePath=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let draftId=null;
setTimeout(()=>{
  console.error(`[booking-dry-run] timed out after ${timeoutSeconds}s. The draft ${draftId?draftId+' ':''}may not have been deleted: check the schedule's Drafts tab.`);
  process.exit(124);
},timeoutSeconds*1000).unref();

(async()=>{
  const context=await chromium.launchPersistentContext(path.resolve(profile),{headless:!headed,executablePath,serviceWorkers:'block',viewport:{width:1400,height:950}});
  // No single browser call may wait longer than this; the run's own waits
  // are bounded separately, and the deadline above covers everything else.
  context.setDefaultTimeout(30000);
  const page=context.pages()[0]||await context.newPage();
  // Progress without page contents: step outcomes, permitted writes, checks.
  const log=e=>{if(e.draftId)draftId=e.draftId;if(['permitted','response','refused-save','uncertain','check','dialog'].includes(e.type))console.error('[booking-dry-run]',JSON.stringify(e));};
  let report;
  const onRefusal=snapshotFile?async p=>fs.writeFileSync(snapshotFile,await p.locator('body').ariaSnapshot()):undefined;
  try{report=await dryRun({context,page,plan,log,onRefusal});}
  finally{await context.close();}
  console.log(JSON.stringify(report,null,2));
  process.exit(report.status==='dry_run_complete'&&report.cleanup?.deleted?0:1);
})().catch(e=>{console.error('[booking-dry-run] failed:',e.message);process.exit(1);});

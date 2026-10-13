#!/usr/bin/env node
'use strict';
// Runs the booking dry run (worker/booking-composer.js) locally, in Chrome,
// with a signed-in Ashby browser profile: every step up to "Schedule", which
// is never clicked, then the draft is deleted. For development against a test
// candidate only; production runs in the worker with its saved session.
//
//   node scripts/booking-dry-run-local.js --profile <dir> --plan <plan.json> [--headed] [--debug-snapshot <file>]
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
if(!profile||!planFile){console.error('Usage: booking-dry-run-local.js --profile <dir> --plan <plan.json> [--headed]');process.exit(2);}
const plan=JSON.parse(fs.readFileSync(planFile,'utf8'));
const executablePath=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

(async()=>{
  const context=await chromium.launchPersistentContext(path.resolve(profile),{headless:!headed,executablePath,serviceWorkers:'block',viewport:{width:1400,height:950}});
  const page=context.pages()[0]||await context.newPage();
  // Progress without page contents: step outcomes, permitted writes, checks.
  const log=e=>{if(['permitted','response','refused-save','uncertain','check','dialog'].includes(e.type))console.error('[booking-dry-run]',JSON.stringify(e));};
  let report;
  const onRefusal=snapshotFile?async p=>fs.writeFileSync(snapshotFile,await p.locator('body').ariaSnapshot()):undefined;
  try{report=await dryRun({context,page,plan,log,onRefusal});}
  finally{await context.close();}
  console.log(JSON.stringify(report,null,2));
  process.exit(report.status==='dry_run_complete'&&report.cleanup?.deleted?0:1);
})().catch(e=>{console.error('[booking-dry-run] failed:',e.message);process.exit(1);});

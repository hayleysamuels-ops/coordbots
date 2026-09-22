'use strict';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
// Inspection only: fixed draft pages and calendar-view navigation. No booking
// submission or cookies returned to the dashboard. Calendar range navigation
// verifies that saved interview dates stay unchanged.
function createDraftReader({chromium,vault,clientId,expectedIdentity,chromiumSandbox=true,connection,now=()=>Date.now(),confirmationReader=require("./confirmation-reader").readConfirmation,invitationReader=require("./invitation-reader").readInvitations,calendarReader=require("./calendar-range").readCalendarRange,availabilityReader=require("./availability-reader").readAvailability}) {
  let reading=false;
  return {
    async inspect(input, mode='communications') {
      if(!input||!(mode==='plan'?['scheduleId','candidateId','applicationId']:mode==='availability'?['scheduleId','candidateId','applicationId']:['draftId','candidateId','applicationId']).every(k=>uuid(input[k]))||typeof input.candidateName!=='string'||!input.candidateName.trim())fail(422,'A verified candidate and Ashby draft are required.');
      if(reading||(await connection.status()).signInOpen)fail(409,'Close the sign-in window before checking an Ashby draft.');
      const saved=vault.load();
      if(!saved||saved.clientId!==clientId||saved.expectedIdentity!==expectedIdentity||!saved.storageState)fail(409,'Save the expected Ashby connection first.');
      reading=true;let browser;
      try {
        browser=await chromium.launch({headless:true,chromiumSandbox});
        const context=await browser.newContext({storageState:saved.storageState,acceptDownloads:false});
        await context.route('**/*',async route=>{
          if(route.request().isNavigationRequest()) {
            try {if(new URL(route.request().url()).origin!=='https://app.ashbyhq.com')return route.abort();}catch(_){return route.abort();}
          }
          return route.continue();
        });
        const page=await context.newPage();
        const base=(mode==='plan'||mode==='availability')?'https://app.ashbyhq.com/schedules/'+input.scheduleId:'https://app.ashbyhq.com/schedules/drafts/'+input.draftId;
        async function open(suffix) {
          await page.goto(base+suffix,{waitUntil:'domcontentloaded',timeout:30000});
          await page.getByRole('button',{name:expectedIdentity,exact:true}).waitFor({state:'visible',timeout:15000});
          if(page.url()!==base+suffix)fail(409,'Ashby did not open the requested unsent draft.');
          const candidate=page.getByRole('link',{name:input.candidateName.trim(),exact:true});
          // Ashby's account header renders before the draft's candidate link.
          // Wait for the requested draft content before evaluating its binding.
          await candidate.first().waitFor({state:'visible',timeout:15000});
          const links=await candidate.all();let bound=false;
          for(const link of links){const href=await link.getAttribute('href');if(href&&href.includes('/candidates/'+input.candidateId+'/applications/'+input.applicationId))bound=true;}
          if(!bound)fail(409,'The Ashby draft belongs to a different candidate or application.');
        }
        if(mode==='plan'){
          await open('/template/events');
          return {...await require('./plan-reader').readPlan(page,input),scheduleId:input.scheduleId,applicationId:input.applicationId,candidateId:input.candidateId,checkedAt:now()};
        }
        if(mode==='availability'){
          await open('/candidate-availability');
          const availability=await availabilityReader(page,input);
          return {...availability,scheduleId:input.scheduleId,applicationId:input.applicationId,candidateId:input.candidateId,checkedAt:now()};
        }
        if(mode==='calendar'){
          if(!input.interviewer?.name||!input.interviewer?.email)fail(422,'A verified interviewer is required.');
          // Directly opening the draft root can redirect to its last-used
          // Communications page. Use Ashby's visible Schedule navigation.
          await open('/communication/calendar-invites');
          await page.getByRole('link',{name:'Schedule',exact:true}).click();
          await page.getByPlaceholder('Set date to view...',{exact:true}).waitFor({state:'visible',timeout:15000});
          if(page.url()!==base)fail(409,'Ashby did not open the requested draft calendar.');
          const calendar=await calendarReader(page,input);
          return {...calendar,draftId:input.draftId,candidateId:input.candidateId,applicationId:input.applicationId,checkedAt:now()};
        }
        await open('/communication/calendar-invites');
        const candidateInvite=await page.getByRole('checkbox',{name:'Send Candidate Invite',exact:true}).isChecked();
        const interviewerInvite=await page.getByRole('checkbox',{name:'Send Interviewer Invite',exact:true}).isChecked();
        function section(text,start,end){const lines=text.split('\n').map(s=>s.trim());const a=lines.indexOf(start),b=end?lines.indexOf(end,a+1):lines.length;if(a<0||b<0)fail(409,'The Ashby draft layout changed. Review it directly before continuing.');return lines.slice(a+1,b).join('\n').trim();}
        const invitations=await invitationReader(page);
        if(!invitations.complete)fail(409,'The invitation cards could not be read completely. Review this draft in Ashby.');
        const candidatePreview=invitations.candidate.preview;
        const interviewerPreview=invitations.interviewer.preview;
        await open('/communication/candidate-confirmation-email');
        const confirmationEnabled=await page.getByRole('checkbox',{name:'Send Candidate Confirmation Email',exact:true}).isChecked();
        await page.locator('[contenteditable="true"]').last().waitFor({state:'visible',timeout:15000});
        await page.getByText('Loading template builder',{exact:true}).waitFor({state:'hidden',timeout:15000});
        const emailText=await page.locator('body').innerText();
        let confirmationPreview=section(emailText,'PREVIEW');
        if(/Loading template builder/i.test(confirmationPreview))fail(409,'The confirmation editor is still loading. Read the draft again.');
        const recipients=invitations.candidate.recipients;
        const confirmation=await confirmationReader(page,recipients.length===1?recipients[0]:null);
        if(confirmation.subject&&confirmation.body){
          confirmationPreview=`From: ${confirmation.from||'Needs verification'}\nTo: ${confirmation.to||'Needs verification'}\nCC: ${confirmation.cc?'None':'Review in Ashby'}\nBCC: ${confirmation.bcc?'None':'Review in Ashby'}\nSubject: ${confirmation.subject}\n\n${confirmation.body}\n\nAttachments: ${confirmation.attachments.map(a=>a.name).join(', ')||'None'}`;
        }
        if(!confirmation.complete)confirmationPreview+='\n\n'+confirmation.issues.join(' ');
        return {invitations,confirmation,draftId:input.draftId,applicationId:input.applicationId,candidateId:input.candidateId,checkedAt:now(),candidateInvite,interviewerInvite,confirmationEnabled,candidatePreview,interviewerPreview,confirmationPreview,bookingEnabled:false};
      }catch(error){if(error.status)throw error;fail(503,'Could not read the saved Ashby draft. No scheduling action was taken.');}
      finally{try{if(browser)await browser.close();}finally{reading=false;}}
    }
  };
}
module.exports={createDraftReader};

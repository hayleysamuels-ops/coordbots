'use strict';
// Read only rendered invitation cards. Their nearest complete container excludes
// page navigation, editor controls, timezone help and product announcements.
function parseInvitations(cards) {
  const issues=[];
  function parse(card,heading) {
    const lines=card.text.split('\n').map(s=>s.trim()).filter(Boolean);
    const details=lines.indexOf('EVENT DETAILS');
    const guests=lines.findIndex(s=>s.replace(/\s+/g,' ')===heading);
    const recipientText=guests<0?'':lines.slice(guests+1).join('\n');
    const recipients=[...new Set(recipientText.match(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/g)||[])];
    if(details<2||guests<=details||!recipients.length)issues.push('An invitation’s event details or recipients could not be read.');
    return {title:card.title,displayedTime:details>1?lines.slice(1,details).join(' '):null,details:details>=0&&guests>details?lines.slice(details+1,guests).join('\n'):null,recipients,recipientText,preview:card.text};
  }
  const candidate=cards.filter(c=>c.kind==='candidate'),interviewer=cards.filter(c=>c.kind==='interviewer');
  if(candidate.length!==1||interviewer.length!==1)issues.push('This reader requires one candidate invitation and one interviewer invitation.');
  const candidateInvite=candidate.length===1?parse(candidate[0],'INVITEES'):null;
  const interviewerInvite=interviewer.length===1?parse(interviewer[0],'INVITEES & ROOMS'):null;
  return {complete:issues.length===0,issues,candidate:candidateInvite,interviewer:interviewerInvite};
}
async function readInvitations(page) {
  const cards=await page.getByRole('heading',{level:3}).evaluateAll(headings=>headings.filter(h=>h.getBoundingClientRect().width&&h.getBoundingClientRect().height).flatMap(h=>{
    for(let p=h.parentElement;p&&p.tagName!=='BODY';p=p.parentElement){
      const labels=[...p.querySelectorAll('h4')].map(e=>e.innerText.trim().replace(/\s+/g,' '));
      if(labels.includes('EVENT DETAILS')&&(labels.includes('INVITEES')||labels.includes('INVITEES & ROOMS'))){
        if(p.querySelectorAll('h3').length!==1)return [];
        return [{title:h.innerText.trim(),kind:labels.includes('INVITEES & ROOMS')?'interviewer':'candidate',text:p.innerText.trim()}];
      }
    }
    return [];
  }));
  const parsed=parseInvitations(cards);
  parsed.complete=parsed.complete&&parsed.issues.length===0;
  return parsed;
}
module.exports={readInvitations,parseInvitations};

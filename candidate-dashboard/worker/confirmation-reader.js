'use strict';
const EMAIL=/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
function parseConfirmation({editors,senders,ccCollapsed,bccCollapsed,attachments,to}) {
  const candidates=[...new Set(senders.map(text=>{
    const value=String(text||'').trim();const match=value.match(/<([^<>]+)>$/);
    return match?match[1].trim():value;
  }).filter(value=>EMAIL.test(value)))];
  const issues=[];
  if(candidates.length!==1)issues.push('Confirm the sending account in Ashby.');
  if(editors.length!==2||editors.some(text=>!text.trim()))issues.push('The email subject and message could not be read separately.');
  if(!ccCollapsed||!bccCollapsed)issues.push('Additional email recipients need review in Ashby.');
  if(!EMAIL.test(to||''))issues.push('The candidate email could not be verified from the invitation.');
  return {complete:issues.length===0,issues,from:candidates.length===1?candidates[0]:null,to:EMAIL.test(to||'')?to:null,
    cc:ccCollapsed?[]:null,bcc:bccCollapsed?[]:null,subject:editors.length===2?editors[0].trim():null,
    body:editors.length===2?editors[1].trim():null,attachments};
}
async function readConfirmation(page,to) {
  // Only rendered form controls are read. The subject and body are separate
  // editors; reading those excludes toolbars and Ashby's product announcements.
  const editors=await page.locator('[contenteditable="true"]').evaluateAll(elements=>elements.filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height).map(e=>e.innerText));
  const senders=await page.locator('select, [role="combobox"], button').evaluateAll(elements=>elements.filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height).flatMap(e=>e.tagName==='SELECT'?[...e.selectedOptions].map(o=>o.textContent):[e.innerText,e.getAttribute('aria-label'),e.getAttribute('title')]).filter(Boolean));
  const attachments=await page.locator('a[href*="/api/files/redirect/"]').evaluateAll(elements=>elements.filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height).map(e=>({name:e.innerText,url:e.href})));
  return parseConfirmation({editors,senders,attachments,to,
    ccCollapsed:await page.getByRole('button',{name:'Cc',exact:true}).isVisible(),
    bccCollapsed:await page.getByRole('button',{name:'Bcc',exact:true}).isVisible()});
}
module.exports={readConfirmation,parseConfirmation};

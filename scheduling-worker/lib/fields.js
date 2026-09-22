"use strict";
/**
 * The tracker's field schema: the one definition of what a card holds.
 *
 * Moved out of public/index.html on 8 Sep 2026 so the server can read it too.
 * Same arrangement as lib/effective.js, and for the same reason: bot 10 needs to
 * know a field's DEFAULT to tell "nobody has answered this" from "somebody
 * answered it", and a second copy of that list in the bot's config would drift
 * from the one the browser renders. Required as a module on the server, served
 * to the browser at /fields.js.
 *
 * The browser owns everything else about a field — how it renders, whether it
 * counts toward progress — and those helpers stay in index.html.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FIELDS = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SECTIONS = [
    {title:"Candidate & Trial", fields:[
      {k:"position",label:"Position",type:"select",opts:["FDE","FDS","Sales","Platform"],src:true},
      {k:"driName",label:"Main Partner / DRI",type:"text"},
      {k:"startDate",label:"Start date",type:"date"},
      {k:"endDate",label:"End date",type:"date"},
      {k:"status",label:"Overall status",type:"select",opts:["NOT STARTED","IN PROGRESS","DONE","CANCELED"],
        tone:{"DONE":"good","IN PROGRESS":"prog","NOT STARTED":"neutral","CANCELED":"bad"}, done:["DONE"]}
    ]},
    {title:"Scheduling", fields:[
      {k:"bgScreen",label:"Exception BG screen",type:"select",opts:["NOT SCHEDULED","SCHEDULED","DONE - NOTES ADDED"],src:true,
        code:"interview from prior stage, sometimes skipped",
        tone:{"NOT SCHEDULED":"warn","SCHEDULED":"prog","DONE - NOTES ADDED":"good"}, done:["DONE - NOTES ADDED"]},
      {k:"calendarHold",label:"Calendar hold sent",type:"toggle", done:["YES"]},
      {k:"workTrialScheduled",label:"Work trial scheduled",type:"toggle",src:true,code:"scheduled in Ashby", done:["YES"]},
      {k:"debriefScheduled",label:"Debrief scheduled",type:"toggle", done:["YES"]},
      {k:"himaReminder",label:"Slack reminder for text intro",type:"toggle", done:["YES"]}
    ]},
    {title:"Position-specific", fields:[
      {k:"fdeShareDocs",label:"FDE: Share AS Docs",type:"pcheck",pos:["FDE","Sales"]},
      {k:"fds9pm",label:"FDS: 9pm DRI Reminder",type:"pcheck",pos:"FDS"},
      {k:"agentShadowSched",label:"FDE: Agent shadow scheduled",type:"select",pos:["FDE","Sales"],src:true,code:"scheduling pullable from Ashby",
        opts:["NOT SCHEDULED","BOOKING LINK SENT","CALL SCHEDULED","N/A"],
        tone:{"NOT SCHEDULED":"warn","BOOKING LINK SENT":"prog","CALL SCHEDULED":"good","N/A":"neutral"},
        done:["CALL SCHEDULED","N/A"]},
      {k:"agentShadowRec",label:"FDE: Agent shadow recording shared",type:"select",pos:["FDE","Sales"],
        opts:["NOT SHARED","SHARED","N/A"],
        tone:{"NOT SHARED":"warn","SHARED":"good","N/A":"neutral"},
        done:["SHARED","N/A"]},
      {k:"salesMarkieDebrief",label:"Sales: Add Markie to debriefs",type:"pcheck",pos:"Sales"}
    ]},
    {title:"Onboarding & Logistics", fields:[
      {k:"nda",label:"NDA & Workplace Agreement",type:"select",opts:["NOT SENT","SENT","COMPLETED"],src:true,code:"e-sig request in Ashby",
        tone:{"NOT SENT":"warn","SENT":"prog","COMPLETED":"good"}, done:["COMPLETED"]},
      {k:"rampLinear",label:"Ramp + Linear ticket",type:"select",opts:["NOT COMPLETED","IN PROGRESS","COMPLETED"],src:true,
        tone:{"NOT COMPLETED":"warn","IN PROGRESS":"prog","COMPLETED":"good"}, done:["COMPLETED"]},
      {k:"teamSlack",label:"Team Slack updated",type:"select",opts:["NOT COMPLETED","IN PROGRESS","COMPLETED"],
        tone:{"NOT COMPLETED":"warn","IN PROGRESS":"prog","COMPLETED":"good"}, done:["COMPLETED"]},
      {k:"chatSlack",label:"Chat Slack updated",type:"select",opts:["NOT COMPLETED","IN PROGRESS","COMPLETED"],
        tone:{"NOT COMPLETED":"warn","IN PROGRESS":"prog","COMPLETED":"good"}, done:["COMPLETED"]},
      {k:"laptopDesk",label:"Laptop & desk assignment",type:"select",opts:["NOT YET","REQUESTED","ASSIGNED"],
        tone:{"NOT YET":"warn","REQUESTED":"prog","ASSIGNED":"good"}, done:["ASSIGNED"]},
      {k:"location",label:"WT location",type:"text"},
      {k:"computer",label:"Computer",type:"text"},
      {k:"desk",label:"Desk",type:"text"},
      {k:"laptopChat",label:"Laptop added to Chat Slack",type:"toggle", done:["YES"]},
      {k:"laptopInvites",label:"Laptop added to work trial invites",type:"toggle", done:["YES"]}
    ]},
    {title:"Notes & References", fields:[
      {k:"referenceSent",label:"Reference sent",type:"text"},
      {k:"preWork",label:"Pre-work status",type:"text"},
      {k:"notes",label:"Notes",type:"textarea",full:true}
    ]}
  ];

  var ALLFIELDS = [];
  SECTIONS.forEach(function (s) { s.fields.forEach(function (f) { ALLFIELDS.push(f); }); });

  function field(k) {
    return ALLFIELDS.filter(function (f) { return f.k === k; })[0];
  }

  /**
   * What a field reads as when nobody has answered it.
   *
   * A select shows its first option, a toggle "NOT YET", a red/green check
   * false, a text field empty. Unlike the browser's old copy this tolerates an
   * unknown key rather than throwing, because the server can be asked about a
   * field the schema no longer has.
   */
  function defVal(f) {
    if (!f) return "";
    if (f.type === "select") return f.opts[0];
    if (f.type === "toggle") return "NOT YET";
    if (f.type === "pcheck") return false;
    return "";
  }

  /**
   * True when a stored value is not a person's answer: absent, blank, or exactly
   * the default the card would have shown anyway.
   */
  function isDefault(k, v) {
    if (v === undefined || v === null || v === "") return true;
    var f = field(k);
    return f ? v === defVal(f) : false;
  }

  return { SECTIONS: SECTIONS, ALLFIELDS: ALLFIELDS, field: field,
           defVal: defVal, isDefault: isDefault };
});

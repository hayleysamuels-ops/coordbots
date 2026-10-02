"use strict";
const { createStore } = require("./store");
const { createService } = require("./service");
const { createSlack } = require("./slack");
// Slack interactivity needs a signing secret, the expected workspace and app,
// at least one approver, and one client-wide channel to check clicks against.
const slackInteractive = config => Boolean(config.schedulingSlackSigningSecret && config.schedulingSlackTeamId && config.schedulingSlackAppId && config.schedulingSlackApprovers.length && config.schedulingRouting === "client" && config.schedulingChannelId);
function setup(config, candidates) {
  const slack = config.schedulingSlackToken ? createSlack(config.schedulingSlackToken, fetch, { displayTimeZone: config.displayTimeZone, interactive: slackInteractive(config), clientName: config.clientName }) : null;
  const service = createService({ store: createStore(config.dataDir), candidates, clientId: config.schedulingClientId,
    channelId: config.schedulingChannelId, channelName: config.schedulingChannelName,
    candidateChannels: config.schedulingCandidateChannels, routing: config.schedulingRouting,
    templateReader: require("./ashby-template").createTemplateReader(config.ashbyApiKey),
    slack });
  service.slackApi = slack;
  return service;
}
module.exports = { setup, slackInteractive };

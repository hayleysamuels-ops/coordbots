"use strict";
const { createStore } = require("./store");
const { createService } = require("./service");
const { createSlack } = require("./slack");
function setup(config, candidates) {
  return createService({ store: createStore(config.dataDir), candidates, clientId: config.schedulingClientId,
    channelId: config.schedulingChannelId, channelName: config.schedulingChannelName,
    candidateChannels: config.schedulingCandidateChannels, routing: config.schedulingRouting,
    templateReader: require("./ashby-template").createTemplateReader(config.ashbyApiKey),
    slack: config.schedulingSlackToken ? createSlack(config.schedulingSlackToken) : null });
}
module.exports = { setup };

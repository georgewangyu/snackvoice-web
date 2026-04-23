"use strict";

const { handleCreatePortalSession } = require("../backend/app");
const { withCors } = require("./_lib/with-cors");

module.exports = withCors(async function handler(req, res) {
  return handleCreatePortalSession(req, res);
});

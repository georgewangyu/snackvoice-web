"use strict";

const { handleSignIn } = require("../../backend/app");
const { withCors } = require("../_lib/with-cors");

module.exports = withCors(async function handler(req, res) {
  return handleSignIn(req, res);
});

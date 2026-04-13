"use strict";

const { handleWebhook } = require("../backend/app");

module.exports = async function handler(req, res) {
  return handleWebhook(req, res);
};

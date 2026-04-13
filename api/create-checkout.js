"use strict";

const { handleCreateCheckout } = require("../backend/app");

module.exports = async function handler(req, res) {
  return handleCreateCheckout(req, res);
};

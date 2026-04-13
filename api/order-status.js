"use strict";

const { handleOrderStatus } = require("../backend/app");

module.exports = async function handler(req, res) {
  return handleOrderStatus(req, res);
};

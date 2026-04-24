"use strict";

const { handleRequest } = require("../backend/app");

module.exports = async function handler(req, res) {
  return handleRequest(req, res);
};

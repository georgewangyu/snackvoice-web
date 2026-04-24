"use strict";

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-SnackVoice-Email",
  );
}

function withCors(handler) {
  return async function corsWrappedHandler(req, res) {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    return handler(req, res);
  };
}

module.exports = {
  withCors,
};

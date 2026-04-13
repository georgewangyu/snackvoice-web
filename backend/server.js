"use strict";

const http = require("http");
const { PORT, STRIPE_SECRET, handleRequest } = require("./app");

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`SnackVoice backend running at http://localhost:${PORT}`);
  console.log(`  Stripe configured: ${!!STRIPE_SECRET}`);
});

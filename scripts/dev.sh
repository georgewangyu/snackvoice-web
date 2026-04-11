#!/bin/bash
# SnackVoice dev helper — starts server + Stripe webhook listener in parallel
# Usage: bash scripts/dev.sh

set -e

PORT=${PORT:-4200}

echo "Starting SnackVoice dev server on :$PORT..."
node backend/server.js &
SERVER_PID=$!

echo ""
echo "Starting Stripe webhook listener..."
echo "(Copy the whsec_ it prints and set STRIPE_WEBHOOK_SECRET in backend/.env)"
echo ""

stripe listen --forward-to "http://localhost:$PORT/api/webhook" &
STRIPE_PID=$!

# Cleanup on exit
trap "kill $SERVER_PID $STRIPE_PID 2>/dev/null" EXIT

wait

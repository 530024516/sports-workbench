#!/bin/bash
cd "$(dirname "$0")"
node server.js &
sleep 1.5
open http://localhost:5123
#!/bin/bash
pkill -f openclaw-gateway || true
sleep 1
setsid /home/spock/.npm-global/bin/openclaw gateway run </dev/null >/tmp/openclaw-gateway.log 2>&1 &
disown
echo "restarted"

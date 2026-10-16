#!/bin/sh
set -eu
exec /usr/bin/xvfb-run -a -s '-screen 0 1200x900x24 -nolisten tcp' /usr/bin/chromium \
  --user-data-dir=/var/lib/ns-seek-browser/profile \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --window-size=1200,900 --no-first-run --no-default-browser-check \
  --disable-dev-shm-usage https://www.nodeseek.com/ruling

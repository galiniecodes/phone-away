#!/bin/zsh
set -eu
cd -- "${0:A:h}"
if ! command -v python3 >/dev/null 2>&1; then
  print 'Phone Away needs Python 3. Install Python 3, then open this launcher again.'
  read '?Press Return to close. '
  exit 1
fi
python3 server.py --open

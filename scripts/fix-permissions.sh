#!/usr/bin/env bash
# Give each container the files it needs, owned by the user it runs as. On a
# Linux server the suite's folders belong to the deploy user (any uid) or to
# root (folders Docker creates for a mount), while the containers run as fixed
# users: Puter, the chat server and DynamoDB as 1000, RustFS as 10001.
# (MariaDB and Valkey fix their own folders; Caddy runs as root.)
#
#   scripts/fix-permissions.sh      after unpacking or cloning, before the first start;
#                                   safe to run again at any time
#
# config.json stays readable only by you and the containers' group (mode 640,
# group 1000). Runs the changes as root in a throwaway container: no sudo.
set -euo pipefail
. "$(dirname "$0")/lib/suite.sh"
cd "$SUITE"

mkdir -p puter/tls
# puter/data may itself belong to root (Docker creates it for the first mount).
docker run --rm -v "$SUITE/puter:/p" "$ALPINE_IMAGE" sh -euc '
  mkdir -p /p/data/puter /p/data/dynamo /p/data/s3 /p/data/caddy
  chown -R 1000:1000   /p/data/puter /p/data/dynamo
  chown -R 10001:10001 /p/data/s3
  chgrp 1000 /p/config/config.json && chmod 640 /p/config/config.json
'
echo "permissions set: data/puter, data/dynamo -> 1000; data/s3 -> 10001; config.json -> group 1000, mode 640"

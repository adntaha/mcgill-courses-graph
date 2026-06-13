#!/usr/bin/env bash

set -a
source .dev.vars
set +a
curl -X POST https://mcgill-cg-api.botato.workers.dev/sync -H "x-sync-secret: $SYNC_SECRET"

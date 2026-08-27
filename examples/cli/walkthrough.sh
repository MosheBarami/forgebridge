#!/usr/bin/env bash
#
# The CLI loop, end to end, stopping where a person has to look.
#
# `set -u` matters here more than usual: an unset FORGEBRIDGE_PRODUCER_TOKEN
# would otherwise become an empty header, and an empty header reads to the
# daemon as an unauthenticated request rather than as a misconfigured script.
set -euo pipefail

: "${FORGEBRIDGE_PRODUCER_TOKEN:?export the token the daemon printed on its terminal}"
DAEMON="${FORGEBRIDGE_DAEMON_URL:-http://127.0.0.1:7317}"

cli() { npx forgebridge --json "$@"; }

echo "── 1. Who are we talking to, and who else can read what we send?"
# `privacyPosture` is printed verbatim on purpose: it is one of the few strings
# in this protocol whose wording is the contract.
cli status

echo
echo "── 2. Is a Studio session paired? An approved set with no consumer has nowhere to go."
cli link

echo
echo "── 3. Propose. Nothing is applied and nothing is approved."
changeset="$(cli run --prompt 'Add a shop stand with a proximity prompt' | tee /dev/stderr | sed -n 's/.*"changeSetId":"\([^"]*\)".*/\1/p')"
if [ -z "$changeset" ]; then
  echo "No changeset id came back. The run log above says which model refused and why." >&2
  exit 1
fi

echo
echo "── 4. The diff. Read it. Destructive operations are ordered first."
cli diff "$changeset"

echo
cat <<MESSAGE
── 5. Approve — deliberately not automated.

    npx forgebridge approve $changeset --digest <contentDigest from the diff above>

The digest is required: a caller that never loaded a diff cannot approve, which
is ADR-012 made mechanical rather than advisory. After it applies:

    npx forgebridge rollback --last     # the journal inverse, on $DAEMON
MESSAGE

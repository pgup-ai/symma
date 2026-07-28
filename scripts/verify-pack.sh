#!/usr/bin/env bash
# Loads the published packages the way a consumer does, which nothing else here
# does: the suite runs under --conditions=symma-source and tsc resolves @symma/*
# to source, so the dist entry, the types contract and the tarball's contents
# are exercised by this script alone. Every packaging defect found so far —
# a `development` condition resolving to unshipped source, sourcemaps pointing
# at files that never ship, a .d.ts needing @types/node it did not declare —
# was invisible from inside the workspace and caught out here.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Build explicitly rather than leaning on `prepack`. The hook fires for a real
# `npm publish`, but relying on it here made this script's result depend on
# whether a lifecycle script ran — and in CI it did not, so the tarball had no
# dist and the guard below was the only thing that noticed.
echo "==> building"
(cd "$root" && npm run build --silent)

echo "==> packing"
tarballs=()
for pkg in protocol client; do
  ver=$(node -p "require('$root/packages/$pkg/package.json').version")
  (cd "$root/packages/$pkg" && npm pack --silent --pack-destination "$work" >/dev/null)
  tgz="symma-$pkg-$ver.tgz"
  files=$(tar tzf "$work/$tgz" | wc -l | tr -d ' ')
  # npm ships LICENSE, README and package.json whatever `files` says, so a
  # dist-less pack still produces a plausible-looking tarball. The entry point
  # is the only thing worth asserting.
  # Read the listing once and match it as a string. `tar … | grep -q` looks
  # equivalent but is not: grep exits at the first match, the producer takes
  # SIGPIPE, and `pipefail` turns that into a failed pipeline — so the guard
  # fires precisely when the file it wants IS present. It survived locally and
  # failed every CI run, which is the timing difference that decides it.
  listing=$(tar tzf "$work/$tgz")
  if ! grep -qx "package/dist/index.js" <<<"$listing"; then
    echo "FAIL: $tgz has no dist/index.js"
    printf '%s\n' "$listing" | sed 's/^/    /'
    exit 1
  fi
  tarballs+=("./$tgz")
  echo "    @symma/$pkg@$ver: $files files"
done

cd "$work"
printf '{"name":"consumer","type":"module","private":true}\n' > package.json
# Both together: client pins an exact protocol version that may not be published yet.
npm install --silent "${tarballs[@]}"

echo "==> importing from plain node (no tsx, no conditions)"
node --input-type=module -e '
import { parseEnvelope, parseRelayControl } from "@symma/protocol";
import { runLocalAcpPrompt, checkEndpointReady } from "@symma/client";
const ok = parseEnvelope(JSON.stringify({v:1,runId:"r",sessionId:"s",seq:1,ts:1,agent:"a",label:"l",dir:"in",frame:{}}));
if (ok?.sessionId !== "s") throw new Error("protocol did not round trip");
if (parseRelayControl(JSON.stringify({kind:"close",sessionId:"s"}))?.kind !== "close") throw new Error("relay control broken");
for (const [n, f] of Object.entries({ runLocalAcpPrompt, checkEndpointReady })) {
  if (typeof f !== "function") throw new Error(`client export ${n} is ${typeof f}`);
}
'

echo "==> tooling that sets a development condition still resolves"
node --conditions=development --input-type=module -e 'import "@symma/protocol";'

echo "==> typechecking a consumer WITHOUT skipLibCheck"
printf '{"compilerOptions":{"module":"nodenext","moduleResolution":"nodenext","strict":true,"noEmit":true},"files":["probe.ts"]}\n' > tsconfig.json
printf 'import { parseEnvelope } from "@symma/protocol";\nimport { checkEndpointReady, type LocalAcpPromptOptions } from "@symma/client";\nexport const seq = parseEnvelope("{}")?.seq;\nexport const ready = checkEndpointReady;\nexport const opts: LocalAcpPromptOptions = { timeoutMs: 1 };\n' > probe.ts
"$root/node_modules/.bin/tsc" -p tsconfig.json

echo "==> publint"
for tgz in "${tarballs[@]}"; do npx --yes publint@latest "$tgz"; done

echo "OK: both packages install, import and typecheck as a consumer"

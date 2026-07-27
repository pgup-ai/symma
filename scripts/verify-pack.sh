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

echo "==> packing"
for pkg in protocol client; do
  (cd "$root/packages/$pkg" && npm pack --silent --pack-destination "$work" >/dev/null)
  files=$(tar tzf "$work/symma-$pkg-0.1.0.tgz" | wc -l | tr -d ' ')
  # `npm pack` happily emits a package.json-only tarball when dist is missing.
  [ "$files" -gt 1 ] || { echo "FAIL: symma-$pkg tarball holds $files file(s)"; exit 1; }
  echo "    @symma/$pkg: $files files"
done

cd "$work"
printf '{"name":"consumer","type":"module","private":true}\n' > package.json
npm install --silent ./symma-protocol-0.1.0.tgz ./symma-client-0.1.0.tgz

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
printf 'import { parseEnvelope } from "@symma/protocol";\nimport { checkEndpointReady } from "@symma/client";\nexport const seq = parseEnvelope("{}")?.seq;\nexport const ready = checkEndpointReady;\n' > probe.ts
"$root/node_modules/.bin/tsc" -p tsconfig.json

echo "==> publint"
npx --yes publint@latest ./symma-protocol-0.1.0.tgz
npx --yes publint@latest ./symma-client-0.1.0.tgz

echo "OK: both packages install, import and typecheck as a consumer"

#!/bin/bash
# Runs every offline test: road matching simulations and background drive scenarios.
set -e
OUT=/tmp/tarmacked-tests
rm -rf "$OUT"
tsc --target es2020 --module commonjs --strict --outDir "$OUT" test/sim.ts
node "$OUT/test/sim.js" | grep -E "^(FAIL|MC)|ALL PASS|SOME FAILED"
tsc --target es2020 --module commonjs --strict --skipLibCheck --outDir "$OUT" src/background.ts src/driveWatch.ts src/geo.ts modules/motion-activity/index.ts test/stubs.d.ts
node test/background.test.js "$OUT" | grep -E "^FAIL|ALL PASS|SOME FAILED"
tsc --target es2020 --module commonjs --strict --skipLibCheck --outDir "$OUT" src/storage.ts test/stubs.d.ts
node --no-warnings test/storage.test.js "$OUT" | grep -E "^FAIL|ALL PASS|SOME FAILED"

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
tsc --target es2020 --module commonjs --strict --outDir "$OUT" test/nav.test.ts
node "$OUT/test/nav.test.js" | grep -E "^FAIL|ALL PASS|SOME FAILED"
npx tsx test/roadData.test.ts | grep -E "^FAIL|ALL PASS|SOME FAILED"
npx tsx test/recap.test.ts | grep -E "^FAIL|ALL PASS|SOME FAILED"
npx tsx test/pipeline.test.ts | grep -E "^FAIL|ALL PASS|SOME FAILED"
npx tsx test/router.test.ts | grep -E "^FAIL|ALL PASS|SOME FAILED"
npx tsx test/places.test.ts | grep -E "^FAIL|ALL PASS|SOME FAILED"
npx tsx test/r2.test.ts | grep -E "^FAIL|ALL PASS|SOME FAILED" | tail -1
npx tsx test/areas.test.ts | grep -E "^FAIL|ALL PASS|SOME FAILED"
npx tsx test/scenic.test.ts | grep -E "^FAIL|ALL PASS|SOME FAILED"

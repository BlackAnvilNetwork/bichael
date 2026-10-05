#!/usr/bin/env node
// Rebuild the engine wasm and compare it with the checked-in bundle and the ruleset pin.
//
//   node contracts/lok-log/engine/scripts/check-wasm-pin.mjs            rebuild, then compare
//   node contracts/lok-log/engine/scripts/check-wasm-pin.mjs --no-build compare pkg/ with the pin only
//   node contracts/lok-log/engine/scripts/check-wasm-pin.mjs --install  rebuild, copy into pkg/, print the new pin
//
// Exit 0 when pkg/lok_engine.wasm matches LOCAL_RULESET_WASM_SHA256 in apps/server/src/lok-vault.ts
// (and, unless --no-build, the fresh build matches pkg/). Exit 1 on any mismatch.
// The build is only byte-identical on the same toolchain and host paths: dependency paths are
// embedded in panic locations, so a different machine can produce a different digest.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const engine = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(engine, "..", "..", "..");
const pkg = join(engine, "pkg", "lok_engine.wasm");
const built = join(engine, "target", "wasm32-unknown-unknown", "release", "lok_engine.wasm");
const vault = join(repo, "apps", "server", "src", "lok-vault.ts");

const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const args = new Set(process.argv.slice(2));
const pin = /LOCAL_RULESET_WASM_SHA256\s*=\s*"([0-9a-f]{64})"/.exec(readFileSync(vault, "utf8"))?.[1];
let ok = true;

if (!args.has("--no-build")) {
  execFileSync("cargo", ["build", "--release", "--lib", "--target", "wasm32-unknown-unknown"], {
    cwd: engine,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (args.has("--install")) copyFileSync(built, pkg);
  const fresh = sha(built);
  console.log("built  " + fresh);
  if (fresh !== sha(pkg)) {
    console.error("MISMATCH: fresh build differs from pkg/lok_engine.wasm (stale bundle or different toolchain/host)");
    ok = false;
  }
}

const shipped = sha(pkg);
console.log("pkg    " + shipped);
console.log("pin    " + (pin ?? "(missing)"));
if (shipped !== pin) {
  console.error("MISMATCH: pkg/lok_engine.wasm differs from LOCAL_RULESET_WASM_SHA256 in apps/server/src/lok-vault.ts");
  ok = false;
}
process.exit(ok ? 0 : 1);

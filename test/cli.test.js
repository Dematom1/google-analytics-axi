import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const cli = new URL("../dist/bin/google-analytics-axi.js", import.meta.url);
const run = (...args) => execFileSync(process.execPath, [cli.pathname, ...args], { encoding: "utf8" });

test("CLI exposes SDK help and version and a no-argument home", () => {
  assert.match(run("--help"), /Usage:/);
  assert.match(run("--help"), /update/);
  assert.match(run("--version"), /^0\.1\.0\s*$/);
  assert.match(run(), /status: scaffold/);
});

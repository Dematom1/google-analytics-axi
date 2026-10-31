import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const cli = new URL("../dist/bin/google-analytics-axi.js", import.meta.url);
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const run = (...args) => execFileSync(process.execPath, [cli.pathname, ...args], { encoding: "utf8" });

test("CLI exposes SDK help and version and a no-argument home", () => {
  assert.match(run("--help"), /Usage:/);
  assert.match(run("--help"), /update/);
  assert.equal(run("--version").trim(), version);
  assert.match(run(), /status: scaffold/);
});

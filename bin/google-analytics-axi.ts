#!/usr/bin/env node
import { runAxiCli } from "axi-sdk-js";
import { encode } from "@toon-format/toon";
import { readFileSync } from "node:fs";
import { setupCommand } from "./auth.js";

const version: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

const description = "Read-only Google Analytics 4 and Search Console for agents";
const args = process.argv.slice(2);
await runAxiCli({
  description,
  version,
  argv: args,
  topLevelHelp: `${description}\n\nUsage: google-analytics-axi [--help] [--version]\n\nCommands:\n  setup  Configure, inspect, or remove authentication`,
  commands: { setup: setupCommand },
  home: async () =>
    encode({
      tool: "google-analytics-axi",
      status: "scaffold",
      help: ["Run google-analytics-axi setup for authentication."],
    }),
});

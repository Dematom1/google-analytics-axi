#!/usr/bin/env node
import { runAxiCli } from "axi-sdk-js";
import { encode } from "@toon-format/toon";
import { readFileSync } from "node:fs";

const version: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

const description = "Read-only Google Analytics 4 and Search Console for agents";
const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  console.log(
    `${description}\n\nUsage: google-analytics-axi [--help] [--version]\n\nCommands will be added in a later release.`,
  );
} else if (args.length === 1 && args[0] === "--version") {
  console.log(version);
} else {
  await runAxiCli({
    description,
    version,
    argv: args,
    topLevelHelp: `${description}\n\nUsage: google-analytics-axi [--help] [--version]`,
    commands: {},
    home: async () =>
      encode({
        tool: "google-analytics-axi",
        status: "scaffold",
        help: ["Run google-analytics-axi --help for available commands."],
      }),
  });
}

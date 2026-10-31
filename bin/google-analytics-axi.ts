#!/usr/bin/env node
import { runAxiCli } from "axi-sdk-js";
import { encode } from "@toon-format/toon";

const description = "Read-only Google Analytics 4 and Search Console for agents";
const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  console.log(
    `${description}\n\nUsage: google-analytics-axi [--help] [--version]\n\nCommands will be added in a later release.`,
  );
} else if (args.length === 1 && args[0] === "--version") {
  console.log("0.1.0");
} else {
  await runAxiCli({
    description,
    version: "0.1.0",
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

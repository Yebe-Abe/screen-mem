#!/usr/bin/env node
// Thin launcher for the compiled CLI. Keeps the bin entry stable across
// build configurations.
import("../dist/cli.js").catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
// Entry point for the `mehen` CLI. Imports the compiled CLI module.
import('../dist/cli.js').then(({ main }) => main()).catch((err) => {
  console.error('mehen aborted:', err?.message ?? err);
  process.exit(1);
});

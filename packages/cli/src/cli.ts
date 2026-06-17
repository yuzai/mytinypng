#!/usr/bin/env node
import { run } from "./run.js";

run(process.argv.slice(2))
  .then(({ code }) => {
    process.exitCode = code;
  })
  .catch((e) => {
    process.stderr.write(`error: ${e?.message ?? e}\n`);
    process.exitCode = 1;
  });

// Library surface: re-export the engine so consumers can `import { compress }
// from "mytinypng"` for programmatic use, plus the CLI runner.
export * from "@mytinypng/core";
export { run, type RunResult } from "./run.js";

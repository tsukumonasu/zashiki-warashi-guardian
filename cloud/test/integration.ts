// Opt-in switch for tests that need an AWS account (R26.5).
//
// `make test` never sets WARASHI_AWS_INTEGRATION, so these suites are reported as skipped
// there. Run them on purpose with: WARASHI_AWS_INTEGRATION=1 npx vitest --run
import { describe } from "vitest";

export const INTEGRATION_ENV = "WARASHI_AWS_INTEGRATION";

export function integrationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[INTEGRATION_ENV] === "1";
}

type Suite = typeof describe.skip;

/** `describe` when opted in, `describe.skip` otherwise. */
export function selectDescribe(env: NodeJS.ProcessEnv = process.env): Suite {
  return integrationEnabled(env) ? (describe as unknown as Suite) : describe.skip;
}

export const describeIntegration: Suite = selectDescribe();

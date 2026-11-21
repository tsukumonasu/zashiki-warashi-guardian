// Global vitest setup: blocks outbound network access in every test (R26.2, R26.3).
//
// The opt-in integration tests (WARASHI_AWS_INTEGRATION=1) need the network on purpose, so the
// guard is not installed for them. Run them alone: `npx vitest --run test/integration`.
import { afterEach } from "vitest";
import { integrationEnabled } from "./integration.js";
import { installNetworkGuard, takeViolations } from "./network-guard.js";
if (!integrationEnabled()) installNetworkGuard();
// If code under test swallowed the guard's error, the test still fails here.
afterEach(() => {
  const blocked = takeViolations();
  if (blocked.length > 0) {
    throw new Error(`Test attempted outbound network connection(s) to: ${blocked.join(", ")}`);
  }
});

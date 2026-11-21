import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import * as appsync from "aws-cdk-lib/aws-appsync";

/**
 * voice-conversation task 1.1: the VoiceStack needs an AppSync Events API. This test checks that the
 * installed aws-cdk-lib exports one. If `EventApi` (L2) is missing, the failure message names the
 * construct that is offered instead (the L1 `CfnApi`, or none), so the design is updated on purpose.
 *
 * Installed aws-cdk-lib version when this test was written: 2.278.0 (recorded in design.md by 1.4).
 */

const require = createRequire(import.meta.url);

/** Reads the installed aws-cdk-lib version from its package.json. */
function installedCdkVersion(): string {
  const path = require.resolve("aws-cdk-lib/package.json");
  return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
}

/** Names the Events API construct that the installed library offers. */
function offeredEventApiConstruct(): string {
  const exported = appsync as unknown as Record<string, unknown>;
  if (typeof exported["EventApi"] === "function") return "EventApi";
  if (typeof exported["CfnApi"] === "function") return "CfnApi";
  return "(none offered)";
}

describe("aws-cdk-lib AppSync Events API construct", () => {
  it("exports aws-appsync EventApi", () => {
    const exported = appsync as unknown as Record<string, unknown>;
    expect(
      typeof exported["EventApi"],
      `EventApi is missing from aws-cdk-lib ${installedCdkVersion()}. Construct offered: ${offeredEventApiConstruct()}`,
    ).toBe("function");
  });

  it("exports the L1 CfnApi (AWS::AppSync::Api) as a fallback", () => {
    expect(typeof (appsync as unknown as Record<string, unknown>)["CfnApi"]).toBe("function");
  });

  it("reports an installed aws-cdk-lib version", () => {
    expect(installedCdkVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

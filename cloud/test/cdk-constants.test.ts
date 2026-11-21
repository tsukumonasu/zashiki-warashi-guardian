import { describe, expect, it } from "vitest";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";

/**
 * Checks that the installed aws-cdk-lib offers the constants the design relies on
 * (cloud-judgement Requirement 19.5). If a constant disappears, the failure message names the
 * newest Node.js runtime that is offered, so the design can be updated deliberately.
 */

/** Node.js runtime constants offered by the installed aws-cdk-lib, e.g. `NODEJS_24_X`. */
function offeredNodeRuntimes(): { constant: string; major: number }[] {
  return Object.keys(Runtime)
    .map((constant) => ({ constant, match: /^NODEJS_(\d+)_X$/.exec(constant) }))
    .filter((entry) => entry.match !== null)
    .map((entry) => ({ constant: entry.constant, major: Number(entry.match![1]) }))
    .sort((a, b) => b.major - a.major);
}

/** Node.js LTS lines are the even major versions. */
function newestLtsConstant(): string {
  const lts = offeredNodeRuntimes().filter((r) => r.major % 2 === 0);
  return lts.length > 0 ? lts[0].constant : "(none offered)";
}

describe("aws-cdk-lib constants", () => {
  it("offers Runtime.NODEJS_24_X (lambda runtime nodejs24.x)", () => {
    const offered = (Runtime as unknown as Record<string, Runtime | undefined>)["NODEJS_24_X"];
    expect(
      offered,
      `Runtime.NODEJS_24_X is missing. Newest Node.js LTS constant offered: ${newestLtsConstant()}`,
    ).toBeDefined();
    expect(offered?.name).toBe("nodejs24.x");
  });

  it("exports S3BucketOrigin from aws-cdk-lib/aws-cloudfront-origins", () => {
    expect(origins.S3BucketOrigin).toBeDefined();
    expect(typeof origins.S3BucketOrigin.withOriginAccessControl).toBe("function");
  });
});

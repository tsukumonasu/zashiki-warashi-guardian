/**
 * Template tests for WebStack (R18.1 to R18.9).
 */
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { CONFIG_JSON_KEYS, WebStack } from "../lib/web-stack.js";

function builtDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "web-dist-"));
  writeFileSync(join(dir, "index.html"), "<html></html>");
  mkdirSync(join(dir, "assets"));
  return dir;
}

function synth(dashboardDistPath: string): Template {
  const app = new App();
  const stack = new WebStack(app, "WebStack", {
    env: { account: "111111111111", region: "ap-northeast-1" },
    apiUrl: "https://api.example.invalid/",
    voiceHttpHost: "http.example.invalid",
    voiceRealtimeHost: "realtime.example.invalid",
    apiId: "abc123",
    userPoolId: "ap-northeast-1_example",
    userPoolClientId: "exampleclient",
    dataBucketName: "example-data-bucket",
    dashboardDistPath,
  });
  return Template.fromStack(stack);
}

describe("WebStack", () => {
  const template = synth(builtDist());

  it("keeps the site bucket private (R18.1)", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
    const dist = Object.values(template.findResources("AWS::CloudFront::Distribution"))[0]!;
    const origin = (dist.Properties.DistributionConfig.Origins as Array<Record<string, unknown>>)[0]!;
    expect(origin.OriginAccessControlId).toBeDefined();
    expect(JSON.stringify(origin.S3OriginConfig)).not.toContain("OriginAccessIdentity/");
  });

  it("redirects HTTP to HTTPS (R18.2)", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https" }),
        CacheBehaviors: Match.arrayWith([Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https" })]),
      }),
    });
  });

  it("falls back to index.html with 200 for 403 and 404 (R18.3)", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: Match.arrayEquals([
          Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: "/index.html" }),
          Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: "/index.html" }),
        ]),
      }),
    });
  });

  it("deploys the built dashboard when dist exists (R18.4)", () => {
    const sources = Object.values(template.findResources("Custom::CDKBucketDeployment")).map(
      (r) => r.Properties.SourceObjectKeys as unknown[],
    );
    expect(sources.length).toBe(2);
    expect(JSON.stringify(sources)).toContain(".zip");
  });

  it("deploys config.json with exactly the five keys, no secrets (R18.6, R18.9)", () => {
    const outdir = mkdtempSync(join(tmpdir(), "web-out-"));
    const app = new App({ outdir });
    const stack = new WebStack(app, "WebStack", {
      env: { account: "111111111111", region: "ap-northeast-1" },
      apiUrl: "https://api.example.invalid/",
      voiceHttpHost: "http.example.invalid",
      voiceRealtimeHost: "realtime.example.invalid",
      apiId: "abc123",
      userPoolId: "ap-northeast-1_example",
      userPoolClientId: "exampleclient",
      dataBucketName: "example-data-bucket",
      dashboardDistPath: builtDist(),
    });
    app.synth();
    expect(stack).toBeDefined();
    const file = readdirSync(outdir)
      .filter((d) => d.startsWith("asset."))
      .map((d) => join(outdir, d, "config.json"))
      .find((f) => existsSync(f));
    expect(file).toBeDefined();
    const text = readFileSync(file!, "utf8");
    const parsed = JSON.parse(text.replace(/"(\{\{[^"]*\}\}|<<marker:[^"]*>>)"/g, '"x"')) as Record<string, string>;
    expect(Object.keys(parsed).sort()).toEqual([...CONFIG_JSON_KEYS].sort());
    expect(text).not.toMatch(/secret|token|password|accessKey/i);
  });

  it("caps the CloudFront cache of /config.json at 60 s (R18.8)", () => {
    template.hasResourceProperties("AWS::CloudFront::CachePolicy", {
      CachePolicyConfig: Match.objectLike({ MaxTTL: 60, DefaultTTL: 60, MinTTL: 0 }),
    });
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([Match.objectLike({ PathPattern: "/config.json" })]),
      }),
    });
    template.hasResourceProperties("Custom::CDKBucketDeployment", {
      SystemMetadata: Match.objectLike({ "cache-control": "public, max-age=60" }),
      DistributionPaths: ["/config.json"],
    });
  });

  it("sets the API CORS origin from this stack without a reverse reference (cycle resolution)", () => {
    template.hasResourceProperties("Custom::AWS", {
      Create: Match.anyValue(),
    });
    const text = JSON.stringify(template.toJSON());
    expect(text).toContain("updateApi");
    expect(text).toContain("apigateway:PATCH");
  });

  it("sets a POST-only CORS rule on the data bucket for the CloudFront origin, never `*` (dashboard R15.5)", () => {
    const resources = Object.values(template.findResources("Custom::AWS")).filter((r) =>
      JSON.stringify(r).includes("putBucketCors"),
    );
    expect(resources.length).toBe(1);
    const create = JSON.stringify(resources[0]);
    expect(create).toContain("example-data-bucket");
    expect(create).toContain("CORSRules");
    expect(create).toContain("AllowedHeaders");
    expect(create).not.toContain('AllowedOrigins\\":[\\"*');
    expect(create).toContain("Distribution");
    expect(JSON.stringify(template.toJSON())).toContain("s3:PutBucketCORS");
  });

  it("adds security headers and the WebUrl output", () => {
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          StrictTransportSecurity: Match.objectLike({ Override: true }),
          ContentTypeOptions: { Override: true },
          FrameOptions: { FrameOption: "DENY", Override: true },
        }),
      }),
    });
    expect(Object.keys(template.toJSON().Outputs)).toEqual(["WebUrl"]);
  });
});

describe("WebStack without dashboard/dist (R18.5)", () => {
  it("synthesizes with a placeholder index.html", () => {
    const template = synth(join(tmpdir(), "does-not-exist-warashi-dist"));
    template.resourceCountIs("AWS::CloudFront::Distribution", 1);
    expect(Object.keys(template.findResources("Custom::CDKBucketDeployment")).length).toBe(2);
  });
});

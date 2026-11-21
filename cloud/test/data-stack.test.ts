/**
 * Template tests for DataStack. Cites R11.1 to R11.4, R17.16, R19.7 and R20.6.
 */
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { DataStack } from "../lib/data-stack.js";

function synth(snapshotExpiryDays?: number): Template {
  const app = new App();
  const stack = new DataStack(app, "Data", snapshotExpiryDays === undefined ? {} : { snapshotExpiryDays });
  return Template.fromStack(stack);
}

describe("DataStack", () => {
  const template = synth();

  it("makes the data bucket private, TLS-only and encrypted (R11.3)", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
    });
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
        ]),
      },
    });
  });

  it("expires snapshots in 3 days and audio and staging in 1 day (R11.1, R11.2)", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: Match.arrayEquals([
          Match.objectLike({ Prefix: "snapshots/", ExpirationInDays: 3, Status: "Enabled" }),
          Match.objectLike({ Prefix: "audio/", ExpirationInDays: 1, Status: "Enabled" }),
          Match.objectLike({ Prefix: "faces-staging/", ExpirationInDays: 1, Status: "Enabled" }),
        ]),
      },
    });
  });

  it("accepts 1 to 7 days and rejects other snapshot lifetimes (R11.1)", () => {
    for (const days of [1, 7]) {
      synth(days).hasResourceProperties("AWS::S3::Bucket", {
        LifecycleConfiguration: {
          Rules: Match.arrayWith([Match.objectLike({ Prefix: "snapshots/", ExpirationInDays: days })]),
        },
      });
    }
    for (const days of [0, 8, 1.5, Number.NaN]) {
      expect(() => synth(days)).toThrow(/snapshotExpiryDays/);
    }
  });

  it("creates an on-demand table with TTL on `ttl` and GSI1 (R11.4, R20.6)", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "warashi",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: "GSI1",
          KeySchema: [
            { AttributeName: "gsi1pk", KeyType: "HASH" },
            { AttributeName: "gsi1sk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        }),
      ],
    });
    // On-demand tables carry no provisioned throughput anywhere.
    for (const [logicalId, resource] of Object.entries(template.findResources("AWS::DynamoDB::Table"))) {
      expect(JSON.stringify(resource), logicalId).not.toContain("ProvisionedThroughput");
    }
  });

  it("creates both collections with fixed literal ids (R17.16)", () => {
    const collections = template.findResources("AWS::Rekognition::Collection");
    const ids = Object.values(collections).map((r) => r.Properties.CollectionId);
    expect(ids.sort()).toEqual(["warashi-demo", "warashi-household"]);
    for (const id of ids) expect(typeof id).toBe("string");
  });

  it("destroys everything on teardown, emptying the bucket (R19.7)", () => {
    template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Delete", UpdateReplacePolicy: "Delete" });
    template.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Delete", UpdateReplacePolicy: "Delete" });
    template.hasResource("AWS::Rekognition::Collection", { DeletionPolicy: "Delete" });
    template.hasResourceProperties("Custom::S3AutoDeleteObjects", Match.anyValue());
  });

  it("has no always-on compute and no Allow policy for Principal * (R20.6)", () => {
    for (const type of ["AWS::EC2::Instance", "AWS::EC2::NatGateway", "AWS::RDS::DBInstance", "AWS::ECS::Service"]) {
      expect(Object.keys(template.findResources(type)), type).toEqual([]);
    }
    const policies = template.findResources("AWS::S3::BucketPolicy");
    for (const policy of Object.values(policies)) {
      for (const statement of policy.Properties.PolicyDocument.Statement as Record<string, unknown>[]) {
        const principal = JSON.stringify(statement["Principal"]);
        if (statement["Effect"] === "Allow") expect(principal).not.toMatch(/"\*"/);
      }
    }
  });
});

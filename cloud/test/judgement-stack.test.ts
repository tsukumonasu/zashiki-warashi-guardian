/**
 * Template tests for JudgementStack. Cites R1.7 to R1.10, R4.6, R9.10, R19.5, R20.7 and R25.5.
 */
import { App } from "aws-cdk-lib";
import { Capture, Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../lambda/_shared/config.js";
import { DataStack } from "../lib/data-stack.js";
import {
  checkDashboardUrl,
  JudgementStack,
  RULE_INGEST_EVENTS,
  RULE_INGEST_STATUS,
  RULE_SNAPSHOTS,
} from "../lib/judgement-stack.js";

function synth(): Template {
  const app = new App();
  const data = new DataStack(app, "Data");
  const stack = new JudgementStack(app, "Judgement", {
    bucket: data.bucket,
    table: data.table,
    householdCollectionId: data.householdCollectionId,
    notificationEmail: "family@example.invalid",
    config: DEFAULT_CONFIG,
    dashboardUrl: "https://dashboard.example.invalid/",
  });
  return Template.fromStack(stack);
}

describe("JudgementStack", () => {
  const template = synth();

  it("creates exactly three topic rules with the exact SQL and no rule on commands (R1.7, R1.8, R1.9)", () => {
    const rules = template.findResources("AWS::IoT::TopicRule");
    expect(Object.keys(rules)).toHaveLength(3);
    const bySql: Record<string, string> = {};
    for (const rule of Object.values(rules)) {
      const props = (rule as { Properties: { RuleName: string; TopicRulePayload: { Sql: string } } }).Properties;
      bySql[props.RuleName] = props.TopicRulePayload.Sql;
    }
    expect(bySql).toEqual({
      [RULE_SNAPSHOTS]:
        "SELECT *, topic(2) AS topicDeviceId FROM 'warashi/+/events' WHERE type = 'snapshot.captured'",
      [RULE_INGEST_EVENTS]: "SELECT *, topic(2) AS topicDeviceId FROM 'warashi/+/events'",
      [RULE_INGEST_STATUS]: "SELECT *, topic(2) AS topicDeviceId FROM 'warashi/+/status'",
    });
    for (const sql of Object.values(bySql)) {
      expect(sql).toContain("topic(2) AS topicDeviceId");
      expect(sql).not.toContain("commands");
    }
  });

  it("lets iot.amazonaws.com invoke each function with SourceArn and SourceAccount (R1.10)", () => {
    const permissions = template.findResources("AWS::Lambda::Permission");
    expect(Object.keys(permissions)).toHaveLength(3);
    for (const permission of Object.values(permissions)) {
      const props = (permission as { Properties: Record<string, unknown> }).Properties;
      expect(props["Principal"]).toBe("iot.amazonaws.com");
      expect(props["Action"]).toBe("lambda:InvokeFunction");
      expect(props["SourceArn"]).toBeDefined();
      expect(props["SourceAccount"]).toBeDefined();
    }
    template.hasResourceProperties("AWS::Lambda::Permission", {
      SourceArn: { "Fn::GetAtt": [Match.stringLikeRegexp("SnapshotsRule"), "Arn"] },
    });
  });

  it("sets judge with 0 async retries, 60 s max event age, 15 s, 512 MB, nodejs24.x (R4.6, R19.5)", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Timeout: 15,
      MemorySize: 512,
      Environment: { Variables: Match.objectLike({ WARASHI_DASHBOARD_URL: "https://dashboard.example.invalid/" }) },
    });
    template.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
      MaximumRetryAttempts: 0,
      MaximumEventAgeInSeconds: 60,
    });
  });

  it("sets ingest with 10 s, 512 MB, nodejs24.x and a 60 s max event age (R19.5)", () => {
    template.hasResourceProperties("AWS::Lambda::Function", { Runtime: "nodejs24.x", Timeout: 10, MemorySize: 512 });
    const configs = template.findResources("AWS::Lambda::EventInvokeConfig");
    expect(Object.keys(configs)).toHaveLength(2);
    for (const c of Object.values(configs)) {
      expect((c as { Properties: Record<string, unknown> })["Properties"]["MaximumEventAgeInSeconds"]).toBe(60);
    }
  });

  it("gives the two functions different roles (R25.5)", () => {
    const fns = template.findResources("AWS::Lambda::Function");
    const roles = Object.values(fns).map((f) => JSON.stringify((f as { Properties: { Role: unknown } }).Properties.Role));
    expect(new Set(roles).size).toBe(roles.length);
  });

  it("keeps every log group for 14 days (R20.7)", () => {
    const groups = template.findResources("AWS::Logs::LogGroup");
    expect(Object.keys(groups).length).toBeGreaterThanOrEqual(3);
    for (const g of Object.values(groups)) {
      expect((g as { Properties: Record<string, unknown> }).Properties["RetentionInDays"]).toBe(14);
    }
  });

  it("subscribes the e-mail from context to the SNS topic (R9.10)", () => {
    template.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "email",
      Endpoint: "family@example.invalid",
    });
  });

  it("reads the IoT data endpoint with iot:Data-ATS (R4.6)", () => {
    const create = new Capture();
    template.hasResourceProperties("Custom::AWS", { Create: create });
    expect(create.asString()).toContain("iot:Data-ATS");
  });

  it("creates the device policy without a * resource (R1.1 to R1.6)", () => {
    template.hasResourceProperties("AWS::IoT::Policy", { PolicyName: "warashi-device" });
    const policies = template.findResources("AWS::IoT::Policy");
    expect(JSON.stringify(policies)).not.toMatch(/"Resource":"\*"/);
  });

  it("grants judge only the actions of the design table, with * only for DetectFaces", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const wildcard: string[] = [];
    for (const p of Object.values(policies)) {
      const statements = (p as { Properties: { PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] } } })
        .Properties.PolicyDocument.Statement;
      for (const s of statements) {
        if (s.Resource === "*" || (Array.isArray(s.Resource) && s.Resource.includes("*"))) {
          wildcard.push(JSON.stringify(s.Action));
        }
      }
    }
    expect(wildcard.sort()).toEqual(['"iot:DescribeEndpoint"', '"rekognition:DetectFaces"']);
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: "s3:PutObject", Resource: Match.anyValue() }),
          Match.objectLike({ Action: "iot:Publish" }),
          Match.objectLike({ Action: "sns:Publish" }),
        ]),
      },
    });
  });

  it("tags the stack resources with project=zashiki-warashi (R25.2)", () => {
    template.hasResourceProperties("AWS::SNS::Topic", {
      Tags: Match.arrayWith([{ Key: "project", Value: "zashiki-warashi" }]),
    });
  });

  it("outputs the endpoint, policy name and topic ARN (R19.2)", () => {
    const outputs = Object.keys(template.toJSON()["Outputs"] as Record<string, unknown>);
    expect(outputs.sort()).toEqual(["DevicePolicyName", "IotEndpoint", "StrangerTopicArn"]);
  });

  it("rejects a dashboard URL that is not https", () => {
    expect(() => checkDashboardUrl("http://x.example.invalid")).toThrow(/dashboardUrl/);
    expect(() => checkDashboardUrl("not a url")).toThrow(/dashboardUrl/);
  });
});

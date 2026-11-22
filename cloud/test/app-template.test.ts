/**
 * Cross-stack template tests for the whole Cloud_App (task 19.10).
 *
 * `buildApp()` is synthesized once, in-process, with the example context values: no AWS
 * credentials and no network are needed. Each test name cites the requirement it checks
 * (R19.2, R19.5, R20.4, R20.5, R20.7, R25.2, R25.5, R25.6, R25.7, R26.4).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { API_RUNTIME } from "../lib/api-stack.js";
import { buildApp, PROJECT_TAG } from "../bin/cloud.js";

type Json = Record<string, unknown>;
interface Res {
  stack: string;
  id: string;
  type: string;
  props: Json;
}

const EXPECTED_STACKS = ["DataStack", "JudgementStack", "ApiStack", "VoiceStack", "WebStack", "BudgetStack"];
const EXPECTED_OUTPUTS = [
  "ApiUrl",
  "WebUrl",
  "VoiceHttpHost",
  "VoiceRealtimeHost",
  "IotEndpoint",
  "UserPoolId",
  "UserPoolClientId",
  "DevicePolicyName",
  "HouseholdCollectionId",
  "DemoCollectionId",
  "DataBucketName",
  "StrangerTopicArn",
];

const resources: Res[] = [];
const outputs: Array<{ stack: string; name: string; value: unknown }> = [];
const stackNames: string[] = [];

beforeAll(() => {
  const app = buildApp(
    new App({
      context: {
        notificationEmail: "family@example.invalid",
        budgetAmountUsd: 10,
        budgetEmail: "owner@example.invalid",
        dashboardUrl: "https://dashboard.example.invalid",
      },
    }),
  );
  for (const stack of app.synth().stacks) {
    stackNames.push(stack.stackName);
    const template = stack.template as { Resources?: Record<string, Json>; Outputs?: Record<string, Json> };
    for (const [id, raw] of Object.entries(template.Resources ?? {})) {
      resources.push({ stack: stack.stackName, id, type: raw["Type"] as string, props: (raw["Properties"] ?? {}) as Json });
    }
    for (const [name, raw] of Object.entries(template.Outputs ?? {})) {
      outputs.push({ stack: stack.stackName, name, value: raw["Value"] });
    }
  }
}, 60000);

const ofType = (type: string): Res[] => resources.filter((r) => r.type === type);
const label = (r: Res): string => `${r.stack}/${r.id} (${r.type})`;

/**
 * Resources that CDK creates from its own inline custom-resource providers or the
 * `BucketDeployment` construct. They are not project code and cannot carry tags or our log groups.
 */
const CDK_MANAGED = [
  /^CustomS3AutoDeleteObjectsCustomResourceProvider/,
  /^CustomCDKBucketDeployment/,
  // The `AwsCustomResource` provider of WebStack (config.json writer); the one in JudgementStack has a log group.
  /^AWS679f53fac002430cb0da5b7982bd22872D164C4C/,
];
const isManaged = (r: Res): boolean => CDK_MANAGED.some((p) => p.test(r.id));

// ---------------------------------------------------------------- IAM helpers

interface Statement {
  Effect?: string;
  Action?: string | string[];
  Resource?: unknown;
  Principal?: unknown;
}
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Returns `[roleLogicalId, statement]` for every statement of every identity policy. */
function identityStatements(): Array<{ role: string; stack: string; statement: Statement }> {
  const out: Array<{ role: string; stack: string; statement: Statement }> = [];
  for (const r of resources) {
    if (r.type === "AWS::IAM::Policy") {
      const roles = asArray(r.props["Roles"] as Array<{ Ref?: string }>);
      const role = roles.map((x) => x.Ref ?? "?").join(",") || r.id;
      const doc = r.props["PolicyDocument"] as { Statement: Statement[] };
      for (const statement of doc.Statement) out.push({ role, stack: r.stack, statement });
    } else if (r.type === "AWS::IAM::Role") {
      for (const p of asArray(r.props["Policies"] as Array<{ PolicyDocument: { Statement: Statement[] } }>)) {
        for (const statement of p.PolicyDocument.Statement) out.push({ role: r.id, stack: r.stack, statement });
      }
    }
  }
  return out;
}

/**
 * Documented exception list for IAM statements whose resource is `*` (design.md, "Lambda table"
 * and the note on resource `*`). Each entry is the role (or its policy) plus the action, and the reason.
 */
const WILDCARD_RESOURCE_EXCEPTIONS: Array<{ role: RegExp; action: string; why: string }> = [
  { role: /^AWS679f53fac002430cb0da5b7982bd2287ServiceRole/, action: "iot:DescribeEndpoint", why: "DescribeEndpoint has no resource type" },
  { role: /^JudgeServiceRole/, action: "rekognition:DetectFaces", why: "DetectFaces has no resource type" },
  { role: /^ApiSimulateServiceRole/, action: "rekognition:DetectFaces", why: "DetectFaces has no resource type" },
  { role: /^ApiSimulateServiceRole/, action: "polly:SynthesizeSpeech", why: "the lexicon is the only resource type; none is used" },
  { role: /^ApiSayServiceRole/, action: "polly:SynthesizeSpeech", why: "the lexicon is the only resource type; none is used" },
  { role: /^CustomCDKBucketDeployment/, action: "cloudfront:CreateInvalidation", why: "BucketDeployment construct emits `*`" },
  { role: /^CustomCDKBucketDeployment/, action: "cloudfront:GetInvalidation", why: "BucketDeployment construct emits `*`" },
];

// ---------------------------------------------------------------- tests

describe("Cloud_App template", () => {
  it("synthesizes the six stacks (R19.1, R26.4)", () => {
    expect([...stackNames].sort()).toEqual([...EXPECTED_STACKS].sort());
  });

  it("exposes the twelve required outputs, each defined in exactly one stack with a value (R19.2)", () => {
    for (const name of EXPECTED_OUTPUTS) {
      const found = outputs.filter((o) => o.name === name);
      expect(found.map((o) => o.stack), `output ${name} must be defined once`).toHaveLength(1);
      const value = found[0]!.value;
      expect(value === undefined || value === "", `output ${name} needs a value`).toBe(false);
    }
    const names = outputs.map((o) => o.name);
    expect(new Set(names).size, "output names are unique across stacks").toBe(names.length);
    expect(names.filter((n) => !EXPECTED_OUTPUTS.includes(n) && !n.startsWith("ExportsOutput")), "no unexpected outputs (CDK cross-stack exports excluded)").toEqual([]);
  });

  it("uses one Lambda runtime constant, nodejs24.x, except the Python BucketDeployment handler (R19.5)", () => {
    expect(API_RUNTIME.name).toBe("nodejs24.x");
    const wrong: string[] = [];
    for (const fn of ofType("AWS::Lambda::Function")) {
      const runtime = fn.props["Runtime"];
      if (/^CustomCDKBucketDeployment/.test(fn.id)) {
        if (!String(runtime).startsWith("python")) wrong.push(`${label(fn)} expected the Python handler, got ${String(runtime)}`);
      } else if (runtime !== "nodejs24.x") {
        wrong.push(`${label(fn)} runtime ${String(runtime)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("creates no always-on compute and no provisioned DynamoDB table (R20.4, R20.5)", () => {
    const forbidden = new Set([
      "AWS::EC2::Instance",
      "AWS::EC2::NatGateway",
      "AWS::EC2::LaunchTemplate",
      "AWS::AutoScaling::AutoScalingGroup",
      "AWS::RDS::DBInstance",
      "AWS::RDS::DBCluster",
      "AWS::ECS::Service",
      "AWS::OpenSearchService::Domain",
      "AWS::Elasticsearch::Domain",
      "AWS::OpenSearchServerless::Collection",
    ]);
    const offenders = resources.filter((r) => forbidden.has(r.type)).map((r) => `${r.type} ${r.stack}/${r.id}`);
    for (const table of ofType("AWS::DynamoDB::Table")) {
      const gsis = asArray(table.props["GlobalSecondaryIndexes"] as Json[]);
      const provisioned =
        table.props["BillingMode"] !== "PAY_PER_REQUEST" ||
        table.props["ProvisionedThroughput"] !== undefined ||
        gsis.some((g) => g["ProvisionedThroughput"] !== undefined);
      if (provisioned) offenders.push(`${table.type} ${table.stack}/${table.id} uses provisioned capacity`);
    }
    expect(offenders).toEqual([]);
  });

  it("gives every Lambda function its own role and a 14-day log group (R20.7, R25.5)", () => {
    const logGroups = new Map(ofType("AWS::Logs::LogGroup").map((g) => [`${g.stack}/${g.id}`, g]));
    const roleOwner = new Map<string, string>();
    const problems: string[] = [];
    for (const fn of ofType("AWS::Lambda::Function")) {
      const roleRef = (fn.props["Role"] as { "Fn::GetAtt"?: string[] } | undefined)?.["Fn::GetAtt"]?.[0];
      if (roleRef === undefined) {
        problems.push(`${label(fn)} has no role reference`);
      } else {
        const key = `${fn.stack}/${roleRef}`;
        const previous = roleOwner.get(key);
        if (previous !== undefined) problems.push(`${label(fn)} shares role ${roleRef} with ${previous}`);
        roleOwner.set(key, fn.id);
      }
      if (isManaged(fn)) continue;
      const ref = ((fn.props["LoggingConfig"] as { LogGroup?: { Ref?: string } } | undefined)?.LogGroup)?.Ref;
      const group = ref === undefined ? undefined : logGroups.get(`${fn.stack}/${ref}`);
      if (group === undefined) problems.push(`${label(fn)} has no log group`);
      else if (group.props["RetentionInDays"] !== 14) problems.push(`${label(fn)} log group retention is ${String(group.props["RetentionInDays"])}`);
    }
    expect(problems).toEqual([]);
    for (const group of logGroups.values()) {
      expect(group.props["RetentionInDays"], `${label(group)} retention`).toBe(14);
    }
  });

  it("tags every taggable resource with project=zashiki-warashi (R25.2)", () => {
    const tagProperty: Record<string, string> = {
      "AWS::ApiGatewayV2::Api": "Tags",
      "AWS::ApiGatewayV2::Stage": "Tags",
      "AWS::AppSync::Api": "Tags",
      "AWS::Budgets::Budget": "ResourceTags",
      "AWS::CloudFront::Distribution": "Tags",
      "AWS::Cognito::UserPool": "UserPoolTags",
      "AWS::DynamoDB::Table": "Tags",
      "AWS::IAM::Role": "Tags",
      "AWS::IoT::Policy": "Tags",
      "AWS::IoT::TopicRule": "Tags",
      "AWS::Lambda::Function": "Tags",
      "AWS::Logs::LogGroup": "Tags",
      "AWS::Rekognition::Collection": "Tags",
      "AWS::S3::Bucket": "Tags",
      "AWS::SNS::Topic": "Tags",
    };
    const hasTag = (value: unknown): boolean => {
      if (Array.isArray(value)) return (value as Array<{ Key: string; Value: string }>).some((t) => t.Key === "project" && t.Value === PROJECT_TAG);
      return (value as Json | undefined)?.["project"] === PROJECT_TAG;
    };
    const missing = resources
      .filter((r) => tagProperty[r.type] !== undefined && !isManaged(r) && !hasTag(r.props[tagProperty[r.type]!]))
      .map(label);
    expect(missing).toEqual([]);
  });

  it("allows an IAM resource `*` only for documented role and action pairs (R25.6)", () => {
    const offenders: string[] = [];
    const used = new Set<number>();
    for (const { role, statement } of identityStatements()) {
      if (!asArray(statement.Resource).includes("*")) continue;
      for (const action of asArray(statement.Action)) {
        const index = WILDCARD_RESOURCE_EXCEPTIONS.findIndex((e) => e.role.test(role) && e.action === action);
        if (index < 0) offenders.push(`role ${role} action ${action} has resource *`);
        else used.add(index);
      }
    }
    expect(offenders).toEqual([]);
    const stale = WILDCARD_RESOURCE_EXCEPTIONS.filter((_, i) => !used.has(i)).map((e) => `${e.role} ${e.action}`);
    expect(stale, "every documented exception is still in use").toEqual([]);
  });

  it("grants no Allow statement with action `*` or `service:*` to any role (R25.5)", () => {
    const offenders = identityStatements()
      .filter(({ statement }) => statement.Effect === "Allow")
      .flatMap(({ role, statement }) => asArray(statement.Action).filter((a) => a === "*" || a.endsWith(":*")).map((a) => `role ${role} action ${a}`));
    expect(offenders).toEqual([]);
  });

  it("has no resource policy with Principal `*` that grants access (R25.7)", () => {
    const isWildcard = (p: unknown): boolean =>
      p === "*" || (typeof p === "object" && p !== null && asArray((p as Json)["AWS"] as unknown).includes("*"));
    const offenders: string[] = [];
    const walk = (node: unknown, where: string): void => {
      if (Array.isArray(node)) node.forEach((n) => walk(n, where));
      else if (typeof node === "object" && node !== null) {
        const obj = node as Json;
        if ("Principal" in obj && isWildcard(obj["Principal"])) {
          // A Deny with a wildcard principal (the `enforceSSL` bucket statement) grants nothing.
          if (obj["Effect"] !== "Deny") offenders.push(where);
        }
        Object.values(obj).forEach((v) => walk(v, where));
      }
    };
    for (const r of resources) {
      if (r.type === "AWS::Lambda::Permission" && r.props["Principal"] === "*") offenders.push(label(r));
      walk(r.props, label(r));
    }
    expect(offenders).toEqual([]);
  });

  it("restricts every Lambda permission to a service principal with a source ARN (R25.7)", () => {
    const loose = ofType("AWS::Lambda::Permission")
      .filter((p) => p.props["SourceArn"] === undefined)
      .map(label);
    expect(loose).toEqual([]);
  });

  it("includes the four VoiceStack functions, each with its own role and 14-day log group (R3.10)", () => {
    const fns = ofType("AWS::Lambda::Function").filter((f) => f.stack === "VoiceStack");
    expect(fns).toHaveLength(4);
    const roles = fns.map((f) => (f.props["Role"] as { "Fn::GetAtt": string[] })["Fn::GetAtt"][0]);
    expect(new Set(roles).size).toBe(4);
    const groups = ofType("AWS::Logs::LogGroup").filter((g) => g.stack === "VoiceStack");
    expect(groups).toHaveLength(4);
    expect(groups.every((g) => g.props["RetentionInDays"] === 14)).toBe(true);
  });

  it("needs no documented `*` resource exception for any VoiceStack role (R3.10)", () => {
    const offenders = identityStatements()
      .filter(({ stack, statement }) => stack === "VoiceStack" && asArray(statement.Resource).includes("*"))
      .map(({ role }) => role);
    expect(offenders).toEqual([]);
  });
});

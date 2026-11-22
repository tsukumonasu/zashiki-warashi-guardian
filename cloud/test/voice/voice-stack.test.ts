/**
 * Template tests for VoiceStack. Cites R3.10, R4.3, R4.8 and R16.6.
 */
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { DataStack } from "../../lib/data-stack.js";
import {
  RULE_VOICE_REQUESTS,
  SQL_VOICE_REQUESTS,
  VOICE_ROUTES,
  VoiceStack,
  type VoiceStackProps,
} from "../../lib/voice-stack.js";

function synth(extra: Partial<VoiceStackProps> = {}): Template {
  const app = new App();
  const data = new DataStack(app, "Data");
  const stack = new VoiceStack(app, "Voice", {
    httpApiId: "api123",
    authorizerId: "auth123",
    table: data.table,
    iotDataEndpoint: "iot.example.invalid",
    ...extra,
  });
  return Template.fromStack(stack);
}

type Json = Record<string, unknown>;
interface Statement {
  Action: string | string[];
  Effect: string;
  Resource: unknown;
}

/** Flattens an intrinsic-function value to a readable string; references become `<ref>`. */
function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flatten).join("|");
  if (value !== null && typeof value === "object") {
    const join = (value as Json)["Fn::Join"];
    if (Array.isArray(join)) return (join[1] as unknown[]).map(flatten).join("");
    return "<ref>";
  }
  return String(value);
}

/** Statements per function, keyed by the function's logical id prefix (for example `VoiceSession`). */
function statementsByFunction(template: Template): Record<string, Statement[]> {
  const roleOf: Record<string, string> = {};
  for (const [id, fn] of Object.entries(template.findResources("AWS::Lambda::Function"))) {
    const role = ((fn as Json)["Properties"] as Json)["Role"] as { "Fn::GetAtt": string[] };
    roleOf[role["Fn::GetAtt"][0]!] = id.replace(/[0-9A-F]{8}$/, "");
  }
  const result: Record<string, Statement[]> = {};
  for (const policy of Object.values(template.findResources("AWS::IAM::Policy"))) {
    const props = (policy as Json)["Properties"] as Json;
    const roleId = ((props["Roles"] as Json[])[0] as { Ref: string }).Ref;
    const name = roleOf[roleId];
    if (name === undefined) continue;
    const statements = (props["PolicyDocument"] as { Statement: Statement[] }).Statement;
    (result[name] ??= []).push(...statements);
  }
  return result;
}

const actionsOf = (s: Statement): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const resourcesOf = (s: Statement): unknown[] => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]);

describe("VoiceStack", () => {
  const template = synth();
  const byFunction = statementsByFunction(template);

  it("creates the Events API with Lambda and IAM auth only and a namespace without handlers (R3.10)", () => {
    template.resourceCountIs("AWS::AppSync::Api", 1);
    template.hasResourceProperties("AWS::AppSync::Api", {
      Name: "warashi-voice",
      EventConfig: {
        AuthProviders: [
          {
            AuthType: "AWS_LAMBDA",
            LambdaAuthorizerConfig: {
              AuthorizerResultTtlInSeconds: 60,
              IdentityValidationExpression: "^[0-9a-f-]{36}\\.[A-Za-z0-9_-]{43}$",
              AuthorizerUri: Match.anyValue(),
            },
          },
          { AuthType: "AWS_IAM" },
        ],
        ConnectionAuthModes: [{ AuthType: "AWS_LAMBDA" }, { AuthType: "AWS_IAM" }],
        DefaultPublishAuthModes: [{ AuthType: "AWS_LAMBDA" }, { AuthType: "AWS_IAM" }],
        DefaultSubscribeAuthModes: [{ AuthType: "AWS_LAMBDA" }, { AuthType: "AWS_IAM" }],
      },
    });
    template.resourceCountIs("AWS::AppSync::ChannelNamespace", 1);
    template.hasResourceProperties("AWS::AppSync::ChannelNamespace", { Name: "voice", HandlerConfigs: {} });
    const api = JSON.stringify(Object.values(template.findResources("AWS::AppSync::Api")));
    expect(api).not.toContain("AMAZON_COGNITO_USER_POOLS");
    expect(api).not.toContain("API_KEY");
  });

  it("lets AppSync invoke the authorizer function (R3.10)", () => {
    template.hasResourceProperties("AWS::Lambda::Permission", {
      Principal: "appsync.amazonaws.com",
      Action: "lambda:InvokeFunction",
      SourceArn: Match.anyValue(),
    });
  });

  it("creates four functions with the design's timeout and memory (R4.8)", () => {
    template.resourceCountIs("AWS::Lambda::Function", 4);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Timeout: 540,
      MemorySize: 512,
      ReservedConcurrentExecutions: 3,
      Runtime: "nodejs24.x",
    });
    for (const timeout of [30, 10, 5]) {
      template.hasResourceProperties("AWS::Lambda::Function", { Timeout: timeout });
    }
    const reserved = Object.values(template.findResources("AWS::Lambda::Function")).filter(
      (fn) => ((fn as Json)["Properties"] as Json)["ReservedConcurrentExecutions"] !== undefined,
    );
    expect(reserved).toHaveLength(1);
  });

  it("honours a maxConcurrent tunable", () => {
    synth({ tunables: { maxConcurrent: 2 } }).hasResourceProperties("AWS::Lambda::Function", {
      Timeout: 540,
      ReservedConcurrentExecutions: 2,
    });
  });

  it("gives voice-session and voice-grant 0 async retries and the minimum max event age (R4.8)", () => {
    const configs = template.findResources("AWS::Lambda::EventInvokeConfig");
    expect(Object.keys(configs)).toHaveLength(2);
    template.allResourcesProperties("AWS::Lambda::EventInvokeConfig", {
      MaximumRetryAttempts: 0,
      MaximumEventAgeInSeconds: 60,
    });
    for (const name of ["VoiceSession", "VoiceGrant"]) {
      template.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
        FunctionName: { Ref: Match.stringLikeRegexp(`^${name}[0-9A-F]{8}$`) },
      });
    }
  });

  it("allows bedrock:InvokeModel only for voice-session on the one nova-2-5-sonic model ARN (R3.10)", () => {
    const bedrock = Object.entries(byFunction).flatMap(([name, statements]) =>
      statements.filter((s) => actionsOf(s).some((a) => a.startsWith("bedrock:"))).map((s) => ({ name, s })),
    );
    expect(bedrock).toHaveLength(1);
    const { name, s } = bedrock[0]!;
    expect(name).toBe("VoiceSession");
    expect(actionsOf(s)).toEqual(["bedrock:InvokeModel"]);
    expect(s.Effect).toBe("Allow");
    const resources = resourcesOf(s);
    expect(resources).toHaveLength(1);
    const arn = flatten(resources[0]);
    expect(arn).toBe("arn:<ref>:bedrock:<ref>::foundation-model/amazon.nova-2-5-sonic");
    expect(arn).not.toContain("*");
    for (const none of ["VoiceStart", "VoiceGrant", "VoiceAuthorizer"]) {
      const text = JSON.stringify(byFunction[none]);
      expect(text, `${none} must have no Bedrock permission`).not.toContain("bedrock");
    }
  });

  it("limits voice-authorizer to dynamodb:GetItem on the table (R3.10)", () => {
    const statements = byFunction["VoiceAuthorizer"] ?? [];
    expect(statements).toHaveLength(1);
    expect(actionsOf(statements[0]!)).toEqual(["dynamodb:GetItem"]);
    expect(resourcesOf(statements[0]!)).toHaveLength(1);
  });

  it("scopes voice-session to the one API, the command topics and its table (R4.8)", () => {
    const statements = byFunction["VoiceSession"] ?? [];
    const appsync = statements.filter((s) => actionsOf(s).some((a) => a.startsWith("appsync:")));
    expect(appsync.flatMap(actionsOf).sort()).toEqual([
      "appsync:EventConnect",
      "appsync:EventPublish",
      "appsync:EventSubscribe",
    ]);
    // EventConnect is authorized on the API ARN itself; `apis/<id>/*` would not match it.
    const connect = appsync.find((s) => actionsOf(s).includes("appsync:EventConnect"))!;
    expect(actionsOf(connect)).toEqual(["appsync:EventConnect"]);
    expect(flatten(resourcesOf(connect)[0])).toMatch(/:appsync:.*apis\/<ref>$/);
    const data = appsync.find((s) => actionsOf(s).includes("appsync:EventPublish"))!;
    expect(flatten(resourcesOf(data)[0])).toMatch(/:appsync:.*apis\/<ref>\/channelNamespace\/voice$/);
    const iot = statements.find((s) => actionsOf(s).includes("iot:Publish"))!;
    expect(flatten(resourcesOf(iot)[0])).toMatch(/:iot:.*:topic\/warashi\/\*\/commands$/);
  });

  it("gives start and grant no direct Bedrock or AppSync access and invoke rights on voice-session only (R4.8)", () => {
    for (const name of ["VoiceStart", "VoiceGrant"]) {
      const statements = byFunction[name] ?? [];
      const actions = statements.flatMap(actionsOf);
      expect(actions.filter((a) => a.startsWith("bedrock:") || a.startsWith("appsync:"))).toEqual([]);
      expect(actions).toContain("lambda:InvokeFunction");
      const invoke = statements.find((s) => actionsOf(s).includes("lambda:InvokeFunction"))!;
      for (const resource of resourcesOf(invoke)) {
        expect(JSON.stringify(resource)).toContain("VoiceSession");
      }
    }
  });

  /** Documented exceptions: a resource may contain `*` only in these shapes (name the role and action). */
  const WILDCARD_EXCEPTIONS: { role: string; pattern: RegExp; why: string }[] = [
    { role: "*", pattern: /\/index\/\*$/, why: "DynamoDB indexes of the single table" },
    { role: "VoiceSession", pattern: /:appsync:.*\/apis\/<ref>\/\*$|apis\/<ref>\/\*$/, why: "AppSync Events channels of the one API" },
    { role: "*", pattern: /:topic\/warashi\/\*\/commands$/, why: "command topic of every doll" },
    { role: "*", pattern: /<ref>:\*$/, why: "Lambda version and alias ARNs of voice-session" },
  ];

  it("has no `*` resource outside the documented exception list (R4.8)", () => {
    for (const [role, statements] of Object.entries(byFunction)) {
      for (const s of statements) {
        for (const resource of resourcesOf(s)) {
          const text = flatten(resource);
          if (!text.includes("*")) continue;
          const allowed = WILDCARD_EXCEPTIONS.some((e) => (e.role === "*" || e.role === role) && e.pattern.test(text));
          expect(text, `${role} ${actionsOf(s).join(",")} has an unlisted wildcard resource`).not.toBe("*");
          expect(allowed, `${role} ${actionsOf(s).join(",")} wildcard resource ${text}`).toBe(true);
        }
      }
    }
  });

  it("creates the IoT rule with the exact SQL and lets iot.amazonaws.com invoke voice-grant (R4.3)", () => {
    template.resourceCountIs("AWS::IoT::TopicRule", 1);
    template.hasResourceProperties("AWS::IoT::TopicRule", {
      RuleName: RULE_VOICE_REQUESTS,
      TopicRulePayload: {
        Sql: SQL_VOICE_REQUESTS,
        AwsIotSqlVersion: "2016-03-23",
        RuleDisabled: false,
        Actions: [{ Lambda: { FunctionArn: { "Fn::GetAtt": [Match.stringLikeRegexp("^VoiceGrant"), "Arn"] } } }],
      },
    });
    expect(SQL_VOICE_REQUESTS).toBe(
      "SELECT *, topic(2) AS topicDeviceId FROM 'warashi/+/events' " +
        "WHERE type = 'conversation.requested' OR type = 'conversation.ended'",
    );
    template.hasResourceProperties("AWS::Lambda::Permission", {
      Principal: "iot.amazonaws.com",
      Action: "lambda:InvokeFunction",
      SourceArn: { "Fn::GetAtt": ["VoiceRequestsRule", "Arn"] },
      SourceAccount: Match.anyValue(),
      FunctionName: { "Fn::GetAtt": [Match.stringLikeRegexp("^VoiceGrant"), "Arn"] },
    });
  });

  it("gives every function its own role and a 14-day log group", () => {
    template.resourceCountIs("AWS::Logs::LogGroup", 4);
    template.allResourcesProperties("AWS::Logs::LogGroup", { RetentionInDays: 14 });
    template.resourceCountIs("AWS::IAM::Role", 4);
    const fns = Object.values(template.findResources("AWS::Lambda::Function")) as Json[];
    const roles = fns.map((fn) => JSON.stringify((fn["Properties"] as Json)["Role"]));
    expect(new Set(roles).size).toBe(4);
    const logGroups = fns.map((fn) => JSON.stringify(((fn["Properties"] as Json)["LoggingConfig"] as Json)["LogGroup"]));
    expect(new Set(logGroups).size).toBe(4);
  });

  it("exports the two host outputs (R3.10)", () => {
    const outputs = Object.keys(template.toJSON()["Outputs"] as Json).sort();
    expect(outputs).toEqual(["VoiceHttpHost", "VoiceRealtimeHost"]);
    template.hasOutput("VoiceHttpHost", { Value: { "Fn::GetAtt": [Match.stringLikeRegexp("^VoiceApi"), "Dns.Http"] } });
    template.hasOutput("VoiceRealtimeHost", {
      Value: { "Fn::GetAtt": [Match.stringLikeRegexp("^VoiceApi"), "Dns.Realtime"] },
    });
  });

  it("keeps the kill switch off by default and passes it when set", () => {
    const flags = (t: Template): unknown[] =>
      Object.values(t.findResources("AWS::Lambda::Function")).map(
        (fn) => ((((fn as Json)["Properties"] as Json)["Environment"] as Json)["Variables"] as Json)["WARASHI_VOICE_ENABLED"],
      );
    // The authorizer takes only the table name; the other three carry the switch.
    expect(flags(template).filter((v) => v !== undefined)).toEqual(["false", "false", "false"]);
    expect(flags(synth({ voiceEnabled: true })).filter((v) => v !== undefined)).toEqual(["true", "true", "true"]);
  });

  it("puts the three conversation routes behind the JWT authorizer on the given API (R16.6)", () => {
    template.resourceCountIs("AWS::ApiGatewayV2::Route", 3);
    template.resourceCountIs("AWS::ApiGatewayV2::Integration", 1);
    template.allResourcesProperties("AWS::ApiGatewayV2::Route", {
      ApiId: "api123",
      AuthorizationType: "JWT",
      AuthorizerId: "auth123",
    });
    const keys = Object.values(template.findResources("AWS::ApiGatewayV2::Route"))
      .map((r) => ((r as Json)["Properties"] as Json)["RouteKey"])
      .sort();
    expect(keys).toEqual(
      [
        "POST /conversations",
        "GET /conversations/{sessionId}",
        "DELETE /conversations/{sessionId}",
      ].sort(),
    );
    expect(VOICE_ROUTES.map((r) => r.key).sort()).toEqual(keys);
    template.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
      IntegrationType: "AWS_PROXY",
      PayloadFormatVersion: "2.0",
    });
  });

  it("lets API Gateway invoke voice-start for each route and nothing broader (R16.6)", () => {
    const permissions = Object.values(template.findResources("AWS::Lambda::Permission")).filter(
      (p) => ((p as Json)["Properties"] as Json)["Principal"] === "apigateway.amazonaws.com",
    );
    const sources = permissions.map((p) => flatten((((p as Json)["Properties"]) as Json)["SourceArn"])).sort();
    expect(sources).toEqual(
      [
        "arn:<ref>:execute-api:<ref>:<ref>:api123/*/POST/conversations",
        "arn:<ref>:execute-api:<ref>:<ref>:api123/*/GET/conversations/*",
        "arn:<ref>:execute-api:<ref>:<ref>:api123/*/DELETE/conversations/*",
      ].sort(),
    );
  });

  it("tags the stack with project=zashiki-warashi", () => {
    template.hasResourceProperties("AWS::AppSync::Api", {
      Tags: Match.arrayWith([{ Key: "project", Value: "zashiki-warashi" }]),
    });
  });
});

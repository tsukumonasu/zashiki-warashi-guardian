/**
 * Template tests for ApiStack. Cites R13.1, R13.2, R14.4, R14.12, R15.4, R15.14, R16.1, R20.7, R25.5.
 */
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { ApiStack } from "../lib/api-stack.js";
import { DataStack } from "../lib/data-stack.js";

type Statement = { Effect: string; Action: string | string[]; Resource: unknown };

let template: Template;

beforeAll(() => {
  const app = new App();
  const data = new DataStack(app, "Data");
  const api = new ApiStack(app, "Api", {
    bucket: data.bucket,
    table: data.table,
    iotDataEndpoint: "iot.example.invalid",
  });
  template = Template.fromStack(api);
}, 120_000);

/** Role logical id -> statements of its inline policies. */
function statementsByRole(): Map<string, Statement[]> {
  const result = new Map<string, Statement[]>();
  for (const policy of Object.values(template.findResources("AWS::IAM::Policy"))) {
    const props = policy["Properties"] as {
      Roles: { Ref: string }[];
      PolicyDocument: { Statement: Statement[] };
    };
    for (const role of props.Roles) {
      result.set(role.Ref, [...(result.get(role.Ref) ?? []), ...props.PolicyDocument.Statement]);
    }
  }
  return result;
}

function roleOf(functionNamePrefix: string): string {
  const entries = Object.entries(template.findResources("AWS::Lambda::Function")).filter(([id]) =>
    id.startsWith(functionNamePrefix),
  );
  expect(entries).toHaveLength(1);
  return (entries[0]![1]["Properties"] as { Role: { "Fn::GetAtt": string[] } }).Role["Fn::GetAtt"][0]!;
}

const actionsOf = (s: Statement): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const text = (value: unknown): string => JSON.stringify(value);

describe("ApiStack", () => {
  it("creates a user pool without self sign-up and with the groups family and reviewer (R13.2)", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
    template.hasResourceProperties("AWS::Cognito::UserPoolGroup", { GroupName: "family" });
    template.hasResourceProperties("AWS::Cognito::UserPoolGroup", { GroupName: "reviewer" });
    template.resourceCountIs("AWS::Cognito::UserPoolGroup", 2);
  });

  it("uses a public SPA app client without a secret (R13.1)", () => {
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      ExplicitAuthFlows: Match.arrayWith(["ALLOW_USER_PASSWORD_AUTH", "ALLOW_USER_SRP_AUTH"]),
    });
    template.resourceCountIs("AWS::Cognito::UserPoolDomain", 0);
    const client = Object.values(template.findResources("AWS::Cognito::UserPoolClient"))[0]!;
    expect((client["Properties"] as Record<string, unknown>)["GenerateSecret"]).toBe(false);
  });

  it("puts the Cognito JWT authorizer on every route (R13.1)", () => {
    template.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 1);
    template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", { AuthorizerType: "JWT" });
    const routes = Object.values(template.findResources("AWS::ApiGatewayV2::Route")).map(
      (r) => r["Properties"] as Record<string, unknown>,
    );
    expect(routes.map((r) => r["RouteKey"]).sort()).toEqual(
      [
        "GET /me",
        "GET /samples",
        "GET /encounters",
        "GET /encounters/{id}",
        "GET /device/status",
        "POST /simulate",
        "POST /commands",
        "GET /faces",
        "POST /faces",
        "POST /faces/upload",
        "DELETE /faces/{memberId}",
      ].sort(),
    );
    for (const route of routes) {
      expect(route["AuthorizationType"], String(route["RouteKey"])).toBe("JWT");
      expect(route["AuthorizerId"], String(route["RouteKey"])).toBeDefined();
    }
  });

  it("leaves CORS to WebStack: the API has no CorsConfiguration (design: Web and API stack cycle)", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", { ProtocolType: "HTTP" });
    const api = Object.values(template.findResources("AWS::ApiGatewayV2::Api"))[0]!;
    expect((api["Properties"] as Record<string, unknown>)["CorsConfiguration"]).toBeUndefined();
  });

  it("throttles POST /simulate at 2 per second with burst 5 (R15.14)", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      RouteSettings: { "POST /simulate": { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 } },
    });
  });

  it("creates five Lambdas on nodejs24.x, each with its own role and a 14-day log group (R20.7, R25.5)", () => {
    const fns = Object.values(template.findResources("AWS::Lambda::Function"));
    expect(fns).toHaveLength(5);
    const roles = new Set<string>();
    for (const fn of fns) {
      const props = fn["Properties"] as { Runtime: string; Role: { "Fn::GetAtt": string[] } };
      expect(props.Runtime).toBe("nodejs24.x");
      roles.add(props.Role["Fn::GetAtt"][0]!);
    }
    expect(roles.size).toBe(5);
    const groups = Object.values(template.findResources("AWS::Logs::LogGroup"));
    expect(groups).toHaveLength(5);
    for (const group of groups) expect((group["Properties"] as { RetentionInDays: number }).RetentionInDays).toBe(14);
  });

  it("sets the timeouts: 3 s for POST /commands (R16.1), 29 s for simulate, 10 s for the others", () => {
    const timeout = (prefix: string): number => {
      const fn = Object.entries(template.findResources("AWS::Lambda::Function")).find(([id]) => id.startsWith(prefix));
      return (fn![1]["Properties"] as { Timeout: number }).Timeout;
    };
    expect(timeout("ApiCommands")).toBe(3);
    expect(timeout("ApiSimulate")).toBe(29);
    for (const name of ["ApiRead", "ApiAdmin", "SnapshotSigner"]) expect(timeout(name)).toBe(10);
  });

  it("routes POST /commands to the 3 s function and nothing else to it (R16.1)", () => {
    const integrations = template.findResources("AWS::ApiGatewayV2::Integration");
    const routes = Object.values(template.findResources("AWS::ApiGatewayV2::Route")).map(
      (r) => r["Properties"] as { RouteKey: string; Target: unknown },
    );
    const commandRoutes = routes.filter((r) => text(r.Target).includes(integrationIdFor("ApiCommands", integrations)));
    expect(commandRoutes.map((r) => r.RouteKey)).toEqual(["POST /commands"]);
  });

  it("gives only the signer s3:GetObject on snapshots/*; api-read and api-simulate have none (R14.4, R14.12)", () => {
    const roles = statementsByRole();
    const touchesSnapshots = (role: string): boolean =>
      (roles.get(role) ?? []).some(
        (s) =>
          s.Effect === "Allow" &&
          actionsOf(s).some((a) => a === "s3:GetObject" || a === "s3:*" || a === "*") &&
          (text(s.Resource).includes("snapshots/") || text(s.Resource).includes('"*"')),
      );
    expect(touchesSnapshots(roleOf("SnapshotSigner"))).toBe(true);
    for (const name of ["ApiRead", "ApiSimulate", "ApiAdmin", "ApiCommands"]) {
      expect(touchesSnapshots(roleOf(name)), name).toBe(false);
    }
  });

  it("limits api-read to table read, invoke on the signer and samples/* (R14.4, R14.12)", () => {
    const statements = statementsByRole().get(roleOf("ApiRead")) ?? [];
    const invoke = statements.filter((s) => actionsOf(s).includes("lambda:InvokeFunction"));
    expect(invoke).toHaveLength(1);
    expect(text(invoke[0]!.Resource)).toContain("SnapshotSigner");
    for (const s of statements) {
      const actions = actionsOf(s);
      if (actions.includes("lambda:InvokeFunction")) continue;
      if (actions.some((a) => a.startsWith("s3:"))) {
        expect(actions).toEqual(["s3:GetObject"]);
        expect(text(s.Resource)).toContain("/samples/*");
        continue;
      }
      expect([...actions].sort()).toEqual(["dynamodb:GetItem", "dynamodb:Query"]);
    }
  });

  it("scopes api-simulate to the demo collection and audio/sim/* (R15.4)", () => {
    const statements = statementsByRole().get(roleOf("ApiSimulate")) ?? [];
    const search = statements.find((s) => actionsOf(s).includes("rekognition:SearchFacesByImage"))!;
    expect(text(search.Resource)).toContain("collection/warashi-demo");
    expect(text(statements)).not.toContain("warashi-household");
    const s3Writes = statements.filter((s) => actionsOf(s).includes("s3:PutObject"));
    expect(s3Writes).toHaveLength(1);
    expect(text(s3Writes[0]!.Resource)).toContain("/audio/sim/*");
    expect(text(statements)).toContain("foundation-model/amazon.nova-lite-v1:0");
  });

  it("scopes api-admin to the household collection and faces-staging/*, with no IoT permission", () => {
    const statements = statementsByRole().get(roleOf("ApiAdmin")) ?? [];
    expect(text(statements)).toContain("collection/warashi-household");
    expect(text(statements)).toContain("/faces-staging/*");
    expect(text(statements)).not.toContain("iot:");
    expect(text(statements)).not.toContain("snapshots/");
  });

  it("lets the commands function publish only to warashi/*/commands", () => {
    const statements = statementsByRole().get(roleOf("ApiCommands")) ?? [];
    const publish = statements.filter((s) => actionsOf(s).includes("iot:Publish"));
    expect(publish).toHaveLength(1);
    expect(text(publish[0]!.Resource)).toContain("topic/warashi/*/commands");
    expect(text(statements)).not.toContain("rekognition:");
    expect(text(statements)).not.toContain("s3:");
  });

  it("uses a `*` resource only for DetectFaces and SynthesizeSpeech, which have no resource scope (R25.5)", () => {
    for (const [role, statements] of statementsByRole()) {
      for (const s of statements) {
        if (s.Resource === "*") {
          expect(actionsOf(s).sort(), role).toSatisfy((a: string[]) =>
            a.every((x) => x === "rekognition:DetectFaces" || x === "polly:SynthesizeSpeech"),
          );
        }
      }
    }
  });

  it("holds no account id, endpoint secret or credential in Lambda environments (R25.5)", () => {
    const env = text(Object.values(template.findResources("AWS::Lambda::Function")).map((f) => f["Properties"]));
    expect(env).not.toMatch(/\b\d{12}\b/);
    expect(env).toContain("WARASHI_SIGNER_FUNCTION_NAME");
    expect(env).toContain("IOT_DATA_ENDPOINT");
  });
});

/** Logical id of the integration whose target Lambda is the function with this id prefix. */
function integrationIdFor(functionPrefix: string, integrations: Record<string, Record<string, unknown>>): string {
  for (const [id, integration] of Object.entries(integrations)) {
    const uri = text((integration["Properties"] as Record<string, unknown>)["IntegrationUri"]);
    if (uri.includes(functionPrefix)) return id;
  }
  throw new Error(`no integration for ${functionPrefix}`);
}

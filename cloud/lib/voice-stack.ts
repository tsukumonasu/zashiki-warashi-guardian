/**
 * VoiceStack: the live voice conversation (voice-conversation R3.10, R4.3, R4.8, R6.12).
 *
 * - AWS AppSync Events API `warashi-voice`. Connect, publish and subscribe accept only the Lambda
 *   authorizer (`voice-authorizer`, per-session token) and IAM (the `voice-session` role). Namespace
 *   `voice` has no handler code, so the API only relays frames.
 * - Four functions, each with its own role and a 14-day log group: `voice-start` (HTTP routes, wired
 *   to the HTTP API by `ApiStack`), `voice-grant` (IoT rule target), `voice-authorizer` and
 *   `voice-session` (one long-running Lambda per conversation).
 * - IoT rule `warashi_voice_requests` sends `conversation.requested` and `conversation.ended` to
 *   `voice-grant`, with `topic(2) AS topicDeviceId`.
 *
 * Verified AWS facts (design.md, "Verified AWS facts"):
 * - `InvokeModelWithBidirectionalStream` has no IAM action of its own. `bedrock:InvokeModel` on the one
 *   foundation-model ARN authorizes it (Service Authorization Reference, Amazon Bedrock).
 * - AppSync Events IAM actions `appsync:EventConnect`, `EventSubscribe` and `EventPublish` apply to
 *   `arn:aws:appsync:<region>:<account>:apis/<APIID>/*`.
 * - CDK `EventApi` adds the `lambda:InvokeFunction` permission for `appsync.amazonaws.com`, scoped to the API ARN.
 *
 * The Lambda reserved concurrency of `voice-session` is `maxConcurrent` (default 3). Lambda keeps at
 * least 10 unreserved executions per account, so an account with the default limit of 10 needs a
 * quota increase before the stack can deploy.
 */
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
  type StackProps,
  aws_apigatewayv2 as apigwv2,
  aws_appsync as appsync,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_iot as iot,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
} from "aws-cdk-lib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Construct } from "constructs";
import { envName } from "../lambda/_shared/config.js";
import { DEFAULT_VOICE_CONFIG } from "../lambda/_shared/voice/config.js";

/** Fixed names (design, "CDK additions"). */
export const VOICE_API_NAME = "warashi-voice";
export const VOICE_NAMESPACE = "voice";
export const RULE_VOICE_REQUESTS = "warashi_voice_requests";
/** Rule SQL: only the two conversation events, with the device id taken from the topic (R4.3). */
export const SQL_VOICE_REQUESTS =
  "SELECT *, topic(2) AS topicDeviceId FROM 'warashi/+/events' " +
  "WHERE type = 'conversation.requested' OR type = 'conversation.ended'";
/** Token regex of the authorizer (docs/schema.md, "Voice session channels"). */
export const VOICE_TOKEN_REGEX = "^[0-9a-f-]{36}\\.[A-Za-z0-9_-]{43}$";
/** Short authorizer cache (design: 60 s). */
export const AUTHORIZER_CACHE_S = 60;

/** Function settings from the design table. */
export const SESSION_TIMEOUT_S = 540;
export const SESSION_MEMORY_MB = 512;
// The design says 30 s, but Lambda accepts 60 s as the smallest maximum event age (CDK validation).
export const SESSION_MAX_EVENT_AGE_S = 60;
export const GRANT_TIMEOUT_S = 30;
export const START_TIMEOUT_S = 10;
export const AUTHORIZER_TIMEOUT_S = 5;
export const FUNCTION_MEMORY_MB = 512;
export const LOG_RETENTION = logs.RetentionDays.TWO_WEEKS;

const HERE = dirname(fileURLToPath(import.meta.url));
const CLOUD_DIR = resolve(HERE, "..");

/** Routes added to the dashboard HTTP API (docs/schema.md, "HTTP API"). `path` is the execute-api resource. */
export const VOICE_ROUTES = [
  { id: "Start", method: "POST", path: "/conversations", key: "POST /conversations" },
  { id: "Get", method: "GET", path: "/conversations/*", key: "GET /conversations/{sessionId}" },
  { id: "End", method: "DELETE", path: "/conversations/*", key: "DELETE /conversations/{sessionId}" },
] as const;

export interface VoiceStackProps extends StackProps {
  /** HTTP API id and JWT authorizer id from `ApiStack`. */
  httpApiId: string;
  authorizerId: string;
  /** Single table of `DataStack`. */
  table: dynamodb.ITable;
  /** IoT data endpoint host from `JudgementStack` (read by the IoT bus adapter). */
  iotDataEndpoint: string;
  /** Kill switch, from the CDK context key `voiceEnabled`. Default false (design, "Cloud settings"). */
  voiceEnabled?: boolean;
  /** Other `voice` settings as given in context, for example `maxConcurrent` or `voiceModelId`. */
  tunables?: Record<string, string | number | boolean>;
}

export class VoiceStack extends Stack {
  readonly eventApi: appsync.EventApi;
  readonly voiceStartFunction: nodejs.NodejsFunction;
  readonly voiceGrantFunction: nodejs.NodejsFunction;
  readonly voiceAuthorizerFunction: nodejs.NodejsFunction;
  readonly voiceSessionFunction: nodejs.NodejsFunction;
  /** Host names for `WebStack` (CSP) and the outputs. */
  readonly httpHost: string;
  readonly realtimeHost: string;

  constructor(scope: Construct, id: string, props: VoiceStackProps) {
    super(scope, id, props);
    Tags.of(this).add("project", "zashiki-warashi");

    const tuning: Record<string, string> = {};
    for (const [setting, value] of Object.entries(props.tunables ?? {})) {
      tuning[envName(setting)] = String(value);
    }
    tuning[envName("voiceEnabled")] = String(props.voiceEnabled ?? false);

    const maxConcurrent = Number(tuning[envName("maxConcurrent")] ?? DEFAULT_VOICE_CONFIG.maxConcurrent);
    const modelId = tuning[envName("voiceModelId")] ?? DEFAULT_VOICE_CONFIG.voiceModelId;

    const tableArn = props.table.tableArn;
    const tableResources = [tableArn, `${tableArn}/index/*`];
    const tableReadWrite = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
    ];
    const commandTopicArn = this.formatArn({ service: "iot", resource: "topic", resourceName: "warashi/*/commands" });

    // --- Functions (own role and log group each) ---------------------------------------
    const baseEnv: Record<string, string> = { ...tuning, WARASHI_TABLE_NAME: props.table.tableName };

    this.voiceAuthorizerFunction = this.makeFunction("VoiceAuthorizer", "voice-authorizer", {
      timeoutS: AUTHORIZER_TIMEOUT_S,
      environment: { WARASHI_TABLE_NAME: props.table.tableName },
    });
    this.voiceAuthorizerFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["dynamodb:GetItem"], resources: [tableArn] }),
    );

    // --- Events API: Lambda authorizer and IAM only, namespace without handlers --------
    this.eventApi = new appsync.EventApi(this, "VoiceApi", {
      apiName: VOICE_API_NAME,
      authorizationConfig: {
        authProviders: [
          {
            authorizationType: appsync.AppSyncAuthorizationType.LAMBDA,
            lambdaAuthorizerConfig: {
              handler: this.voiceAuthorizerFunction,
              resultsCacheTtl: Duration.seconds(AUTHORIZER_CACHE_S),
              validationRegex: VOICE_TOKEN_REGEX,
            },
          },
          { authorizationType: appsync.AppSyncAuthorizationType.IAM },
        ],
        connectionAuthModeTypes: [appsync.AppSyncAuthorizationType.LAMBDA, appsync.AppSyncAuthorizationType.IAM],
        defaultPublishAuthModeTypes: [appsync.AppSyncAuthorizationType.LAMBDA, appsync.AppSyncAuthorizationType.IAM],
        defaultSubscribeAuthModeTypes: [appsync.AppSyncAuthorizationType.LAMBDA, appsync.AppSyncAuthorizationType.IAM],
      },
    });
    this.eventApi.addChannelNamespace("VoiceNamespace", { channelNamespaceName: VOICE_NAMESPACE });
    this.httpHost = this.eventApi.httpDns;
    this.realtimeHost = this.eventApi.realtimeDns;
    // EventConnect is authorized on the API itself, which `apis/<id>/*` does not match; publish and
    // subscribe are authorized on the channel namespace (AppSync Events guide, "AWS_IAM authorization").
    const apiArn = `arn:${this.partition}:appsync:${this.region}:${this.account}:apis/${this.eventApi.apiId}`;
    const namespaceArn = `${apiArn}/channelNamespace/${VOICE_NAMESPACE}`;

    // --- voice-session --------------------------------------------------------------------
    this.voiceSessionFunction = this.makeFunction("VoiceSession", "voice-session", {
      timeoutS: SESSION_TIMEOUT_S,
      memoryMb: SESSION_MEMORY_MB,
      reservedConcurrency: maxConcurrent,
      retryAttempts: 0,
      maxEventAgeS: SESSION_MAX_EVENT_AGE_S,
      environment: {
        ...baseEnv,
        IOT_DATA_ENDPOINT: props.iotDataEndpoint,
        WARASHI_VOICE_HTTP_HOST: this.httpHost,
        WARASHI_VOICE_REALTIME_HOST: this.realtimeHost,
      },
    });
    this.voiceSessionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        // InvokeModelWithBidirectionalStream is authorized by bedrock:InvokeModel (no separate action).
        actions: ["bedrock:InvokeModel"],
        resources: [`arn:${this.partition}:bedrock:${this.region}::foundation-model/${modelId}`],
      }),
    );
    this.voiceSessionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["appsync:EventConnect"],
        resources: [apiArn],
      }),
    );
    this.voiceSessionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["appsync:EventSubscribe", "appsync:EventPublish"],
        resources: [namespaceArn],
      }),
    );
    this.voiceSessionFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["iot:Publish"], resources: [commandTopicArn] }),
    );
    this.voiceSessionFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: tableReadWrite, resources: tableResources }),
    );

    // --- voice-start and voice-grant -------------------------------------------------------
    const startGrantEnv: Record<string, string> = {
      ...baseEnv,
      IOT_DATA_ENDPOINT: props.iotDataEndpoint,
      WARASHI_VOICE_SESSION_FUNCTION_NAME: this.voiceSessionFunction.functionName,
      WARASHI_VOICE_HTTP_HOST: this.httpHost,
      WARASHI_VOICE_REALTIME_HOST: this.realtimeHost,
    };
    this.voiceStartFunction = this.makeFunction("VoiceStart", "voice-start", {
      timeoutS: START_TIMEOUT_S,
      environment: startGrantEnv,
    });
    this.voiceGrantFunction = this.makeFunction("VoiceGrant", "voice-grant", {
      timeoutS: GRANT_TIMEOUT_S,
      retryAttempts: 0,
      maxEventAgeS: SESSION_MAX_EVENT_AGE_S,
      environment: startGrantEnv,
    });
    for (const fn of [this.voiceStartFunction, this.voiceGrantFunction]) {
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: tableReadWrite, resources: tableResources }));
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["iot:Publish"], resources: [commandTopicArn] }));
      // Only the one session function may be invoked (no wildcard).
      this.voiceSessionFunction.grantInvoke(fn);
    }

    // --- IoT rule (design: IoT rule in VoiceStack, so JudgementStack does not depend on it) ----
    const rule = new iot.CfnTopicRule(this, "VoiceRequestsRule", {
      ruleName: RULE_VOICE_REQUESTS,
      topicRulePayload: {
        sql: SQL_VOICE_REQUESTS,
        awsIotSqlVersion: "2016-03-23",
        ruleDisabled: false,
        actions: [{ lambda: { functionArn: this.voiceGrantFunction.functionArn } }],
      },
    });
    this.voiceGrantFunction.addPermission("VoiceRequestsRuleInvoke", {
      principal: new iam.ServicePrincipal("iot.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: rule.attrArn,
      sourceAccount: this.account,
    });

    // --- HTTP routes of the existing API (R1.1, R16.6) -----------------------------------------
    // Built here with L1 constructs so the dependency stays ApiStack <- VoiceStack. The routes use the
    // JWT authorizer of ApiStack (the API default is not inherited by L1 routes).
    const integration = new apigwv2.CfnIntegration(this, "VoiceStartIntegration", {
      apiId: props.httpApiId,
      integrationType: "AWS_PROXY",
      integrationUri: this.voiceStartFunction.functionArn,
      payloadFormatVersion: "2.0",
    });
    for (const route of VOICE_ROUTES) {
      new apigwv2.CfnRoute(this, `Route${route.id}`, {
        apiId: props.httpApiId,
        routeKey: route.key,
        target: `integrations/${integration.ref}`,
        authorizationType: "JWT",
        authorizerId: props.authorizerId,
      });
      this.voiceStartFunction.addPermission(`Invoke${route.id}`, {
        principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
        action: "lambda:InvokeFunction",
        sourceArn: `arn:${this.partition}:execute-api:${this.region}:${this.account}:${props.httpApiId}/*/${route.method}${route.path}`,
      });
    }

    // --- Outputs ------------------------------------------------------------------------------
    new CfnOutput(this, "VoiceHttpHost", { value: this.httpHost, description: "AppSync Events HTTP host" });
    new CfnOutput(this, "VoiceRealtimeHost", { value: this.realtimeHost, description: "AppSync Events real-time host" });
  }

  private makeFunction(
    logicalId: string,
    folder: string,
    options: {
      timeoutS: number;
      environment: Record<string, string>;
      memoryMb?: number;
      reservedConcurrency?: number;
      retryAttempts?: number;
      maxEventAgeS?: number;
    },
  ): nodejs.NodejsFunction {
    const logGroup = new logs.LogGroup(this, `${logicalId}Logs`, {
      retention: LOG_RETENTION,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    return new nodejs.NodejsFunction(this, logicalId, {
      entry: resolve(CLOUD_DIR, "lambda", folder, "index.ts"),
      handler: "handler",
      projectRoot: CLOUD_DIR,
      depsLockFilePath: resolve(CLOUD_DIR, "package-lock.json"),
      runtime: lambda.Runtime.NODEJS_24_X,
      memorySize: options.memoryMb ?? FUNCTION_MEMORY_MB,
      timeout: Duration.seconds(options.timeoutS),
      ...(options.reservedConcurrency === undefined ? {} : { reservedConcurrentExecutions: options.reservedConcurrency }),
      ...(options.retryAttempts === undefined ? {} : { retryAttempts: options.retryAttempts }),
      ...(options.maxEventAgeS === undefined ? {} : { maxEventAge: Duration.seconds(options.maxEventAgeS) }),
      logGroup,
      environment: options.environment,
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: "node24",
        minify: true,
        sourceMap: false,
        externalModules: [],
        mainFields: ["module", "main"],
        banner: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
      },
    });
  }
}

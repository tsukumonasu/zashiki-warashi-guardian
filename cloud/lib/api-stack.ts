/**
 * ApiStack: Cognito user pool, HTTP API with a JWT authorizer and the four API Lambdas
 * (R13, R14.4, R14.12, R15.4, R15.14, R16.1, R20.7, R25.5).
 *
 * - One user pool, self sign-up off, groups `family` and `reviewer` (R13.2). Users are created
 *   out of band (see the README owner steps).
 * - Every route sits behind the user pool JWT authorizer (R13.1).
 * - `api-read` has no S3 permission on `snapshots/*`. Pictures are signed by the internal
 *   `snapshot-signer`, the only role with `s3:GetObject` on `snapshots/*` (R14.4, R14.12).
 * - `POST /commands` is served by its own function with a 3 s timeout (R16.1). It runs the same
 *   `api-admin` code, but its role is limited to IoT publish and the table.
 * - The HTTP API is created WITHOUT `corsPreflight`. `WebStack` sets the CORS origin after it knows
 *   the CloudFront domain (see "Web and API stack cycle" in `design.md`). For the same reason the
 *   Lambdas get no `WARASHI_WEB_ORIGIN`: API Gateway adds the CORS headers.
 *
 * Every role is created by its own function, so no role is shared. Resources use
 * `RemovalPolicy.DESTROY` so `cdk destroy --all` leaves nothing behind (R19.8).
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { DEMO_COLLECTION_ID, HOUSEHOLD_COLLECTION_ID } from "./data-stack.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LAMBDA_DIR = resolve(HERE, "..", "lambda");

/** Lambda runtime of every function (R19.5). */
export const API_RUNTIME = lambda.Runtime.NODEJS_24_X;
export const API_MEMORY_MB = 512;
/** Design "Settings": 10 s for read, signer and admin; 29 s for simulate (API Gateway limit is 30 s). */
export const DEFAULT_TIMEOUT_S = 10;
export const SIMULATE_TIMEOUT_S = 29;
/** R16.1: the answer to `POST /commands` comes within 3 seconds. */
export const COMMANDS_TIMEOUT_S = 3;
/** `POST /simulate` route throttle (R15.14): 2 requests per second, burst 5. */
export const SIMULATE_RATE_LIMIT = 2;
export const SIMULATE_BURST_LIMIT = 5;
export const LOG_RETENTION = logs.RetentionDays.TWO_WEEKS;
export const USER_POOL_GROUPS = ["family", "reviewer"] as const;
export const DEFAULT_BEDROCK_MODEL_ID = "amazon.nova-lite-v1:0";
export const DEFAULT_POLLY_VOICE_ID = "Kazuha";
export const DEFAULT_CONSENT_NOTICE_VERSION = "1";

export interface ApiStackProps extends StackProps {
  /** Data bucket and table from DataStack. */
  bucket: s3.IBucket;
  table: dynamodb.ITable;
  /** IoT data endpoint host from JudgementStack (not a secret); used to publish commands. */
  iotDataEndpoint: string;
  householdCollectionId?: string;
  demoCollectionId?: string;
  /** Bedrock text model for generated lines (design C10). */
  bedrockModelId?: string;
  pollyVoiceId?: string;
  consentNoticeVersion?: string;
  /** Comma-free words that the line sanitizer rejects. */
  blockedWords?: string[];
  /** Extra `WARASHI_<SETTING>` tunables, merged into every function environment. */
  tunables?: Record<string, string>;
}

export class ApiStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly httpApi: apigwv2.HttpApi;
  readonly apiRead: lambda.IFunction;
  readonly snapshotSigner: lambda.IFunction;
  readonly apiSimulate: lambda.IFunction;
  readonly apiAdmin: lambda.IFunction;
  readonly apiCommands: lambda.IFunction;
  /** Values for WebStack (R18.6). */
  readonly apiUrl: string;
  readonly apiId: string;
  /** Id of the JWT authorizer, for routes that VoiceStack adds to the same API. */
  readonly authorizerId: string;
  readonly userPoolId: string;
  readonly userPoolClientId: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const householdId = props.householdCollectionId ?? HOUSEHOLD_COLLECTION_ID;
    const demoId = props.demoCollectionId ?? DEMO_COLLECTION_ID;
    const modelId = props.bedrockModelId ?? DEFAULT_BEDROCK_MODEL_ID;

    // ---- Cognito (R13.2) ----
    this.userPool = new cognito.UserPool(this, "UserPool", {
      selfSignUpEnabled: false,
      signInAliases: { username: true, email: true },
      accountRecovery: cognito.AccountRecovery.NONE,
      passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    for (const group of USER_POOL_GROUPS) {
      new cognito.CfnUserPoolGroup(this, `Group${group[0]!.toUpperCase()}${group.slice(1)}`, {
        userPoolId: this.userPool.userPoolId,
        groupName: group,
      });
    }
    // Public SPA client: no secret, no Cognito domain, no hosted-UI flows. SRP plus
    // USER_PASSWORD_AUTH: the dashboard's own sign-in form posts the password to Cognito over TLS
    // (dashboard-simulation task 2.1, R11.1).
    this.userPoolClient = this.userPool.addClient("SpaClient", {
      generateSecret: false,
      authFlows: { userSrp: true, userPassword: true },
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });
    this.userPoolId = this.userPool.userPoolId;
    this.userPoolClientId = this.userPoolClient.userPoolClientId;

    // ---- Lambda environment (names fixed by the design; never secrets) ----
    const baseEnv: Record<string, string> = {
      ...props.tunables,
      WARASHI_TABLE_NAME: props.table.tableName,
      WARASHI_BUCKET_NAME: props.bucket.bucketName,
      WARASHI_CONSENT_NOTICE_VERSION: props.consentNoticeVersion ?? DEFAULT_CONSENT_NOTICE_VERSION,
    };

    const makeFunction = (
      name: string,
      dir: string,
      options: { timeoutS: number; environment: Record<string, string>; description: string },
    ): nodejs.NodejsFunction =>
      new nodejs.NodejsFunction(this, name, {
        entry: resolve(LAMBDA_DIR, dir, "index.ts"),
        handler: "handler",
        runtime: API_RUNTIME,
        memorySize: API_MEMORY_MB,
        timeout: Duration.seconds(options.timeoutS),
        description: options.description,
        environment: options.environment,
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          retention: LOG_RETENTION,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        bundling: { target: "node24", sourceMap: false, minify: false },
      });

    // ---- snapshot-signer: the only role with s3:GetObject on snapshots/* (R14.4, R14.10) ----
    const signer = makeFunction("SnapshotSigner", "snapshot-signer", {
      timeoutS: DEFAULT_TIMEOUT_S,
      environment: { WARASHI_BUCKET_NAME: props.bucket.bucketName },
      description: "Signs 300-second snapshot URLs for the family role. Invoked by api-read only.",
    });
    signer.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [props.bucket.arnForObjects("snapshots/*")] }),
    );
    this.snapshotSigner = signer;

    // ---- api-read: table read, signer invoke, sample manifest. No snapshots/* ----
    const read = makeFunction("ApiRead", "api-read", {
      timeoutS: DEFAULT_TIMEOUT_S,
      environment: { ...baseEnv, WARASHI_SIGNER_FUNCTION_NAME: signer.functionName },
      description: "GET /me, /samples, /encounters, /encounters/{id}, /device/status",
    });
    read.addToRolePolicy(
      new iam.PolicyStatement({
        // No Scan: the adapter only reads by key and queries.
        actions: ["dynamodb:GetItem", "dynamodb:Query"],
        resources: [props.table.tableArn, `${props.table.tableArn}/index/*`],
      }),
    );
    signer.grantInvoke(read);
    read.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [props.bucket.arnForObjects("samples/*")] }),
    );
    this.apiRead = read;

    // ---- api-simulate: demo collection only (R15.4) ----
    const simulate = makeFunction("ApiSimulate", "api-simulate", {
      timeoutS: SIMULATE_TIMEOUT_S,
      environment: {
        ...baseEnv,
        WARASHI_DEMO_COLLECTION_ID: demoId,
        WARASHI_BEDROCK_MODEL_ID: modelId,
        WARASHI_POLLY_VOICE_ID: props.pollyVoiceId ?? DEFAULT_POLLY_VOICE_ID,
        WARASHI_BLOCKED_WORDS: (props.blockedWords ?? []).join(","),
      },
      description: "POST /simulate against the demo collection",
    });
    simulate.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["rekognition:SearchFacesByImage"],
        resources: [this.formatArn({ service: "rekognition", resource: "collection", resourceName: demoId })],
      }),
    );
    simulate.addToRolePolicy(
      new iam.PolicyStatement({
        // rekognition:DetectFaces has no resource type, so it cannot be scoped to a collection.
        actions: ["rekognition:DetectFaces"],
        resources: ["*"],
      }),
    );
    simulate.addToRolePolicy(
      new iam.PolicyStatement({
        // The model is in-Region in Tokyo (design C10), so the foundation-model ARN is enough.
        actions: ["bedrock:InvokeModel"],
        resources: [`arn:${this.partition}:bedrock:${this.region}::foundation-model/${modelId}`],
      }),
    );
    simulate.addToRolePolicy(
      new iam.PolicyStatement({
        // polly:SynthesizeSpeech supports no resource-level scope except lexicons, which we do not use.
        actions: ["polly:SynthesizeSpeech"],
        resources: ["*"],
      }),
    );
    simulate.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [props.bucket.arnForObjects("samples/*")] }),
    );
    simulate.addToRolePolicy(
      new iam.PolicyStatement({
        // GetObject is for the pre-signed MP3 URL, which is only valid while the role can read.
        actions: ["s3:PutObject", "s3:GetObject"],
        resources: [props.bucket.arnForObjects("audio/sim/*")],
      }),
    );
    simulate.addToRolePolicy(
      new iam.PolicyStatement({
        // Rate-limit counters and the manifest lookups; no delete, no scan.
        actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:TransactWriteItems"],
        resources: [props.table.tableArn],
      }),
    );
    this.apiSimulate = simulate;

    // ---- api-admin (family only): faces ----
    const admin = makeFunction("ApiAdmin", "api-admin", {
      timeoutS: DEFAULT_TIMEOUT_S,
      environment: {
        ...baseEnv,
        WARASHI_HOUSEHOLD_COLLECTION_ID: householdId,
        IOT_DATA_ENDPOINT: props.iotDataEndpoint,
      },
      description: "GET/POST /faces, POST /faces/upload, DELETE /faces/{memberId}",
    });
    admin.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["rekognition:IndexFaces", "rekognition:DeleteFaces", "rekognition:ListFaces"],
        resources: [this.formatArn({ service: "rekognition", resource: "collection", resourceName: householdId })],
      }),
    );
    admin.addToRolePolicy(
      new iam.PolicyStatement({
        // PutObject is used by the pre-signed POST of the upload route.
        actions: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
        resources: [props.bucket.arnForObjects("faces-staging/*")],
      }),
    );
    props.table.grantReadWriteData(admin);
    this.apiAdmin = admin;

    // ---- POST /commands: same code as api-admin, own role, 3 s timeout (R16.1) ----
    const commands = makeFunction("ApiCommands", "api-admin", {
      timeoutS: COMMANDS_TIMEOUT_S,
      environment: { ...baseEnv, IOT_DATA_ENDPOINT: props.iotDataEndpoint },
      description: "POST /commands (family only), answers within 3 seconds",
    });
    commands.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iot:Publish"],
        resources: [this.formatArn({ service: "iot", resource: "topic", resourceName: "warashi/*/commands" })],
      }),
    );
    props.table.grantReadWriteData(commands);
    this.apiCommands = commands;

    // ---- HTTP API: no corsPreflight here (WebStack sets it), JWT authorizer on every route ----
    const authorizer = new HttpUserPoolAuthorizer("UserPoolAuthorizer", this.userPool, {
      userPoolClients: [this.userPoolClient],
    });
    this.httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: "warashi-api",
      description: "Zashiki-Warashi Guardian dashboard API",
      defaultAuthorizer: authorizer,
    });

    const routes: { path: string; methods: apigwv2.HttpMethod[]; fn: lambda.IFunction; id: string }[] = [
      { id: "Me", path: "/me", methods: [apigwv2.HttpMethod.GET], fn: read },
      { id: "Samples", path: "/samples", methods: [apigwv2.HttpMethod.GET], fn: read },
      { id: "Encounters", path: "/encounters", methods: [apigwv2.HttpMethod.GET], fn: read },
      { id: "Encounter", path: "/encounters/{id}", methods: [apigwv2.HttpMethod.GET], fn: read },
      { id: "DeviceStatus", path: "/device/status", methods: [apigwv2.HttpMethod.GET], fn: read },
      { id: "Simulate", path: "/simulate", methods: [apigwv2.HttpMethod.POST], fn: simulate },
      { id: "Commands", path: "/commands", methods: [apigwv2.HttpMethod.POST], fn: commands },
      { id: "FacesList", path: "/faces", methods: [apigwv2.HttpMethod.GET], fn: admin },
      { id: "FacesCreate", path: "/faces", methods: [apigwv2.HttpMethod.POST], fn: admin },
      { id: "FacesUpload", path: "/faces/upload", methods: [apigwv2.HttpMethod.POST], fn: admin },
      { id: "FacesDelete", path: "/faces/{memberId}", methods: [apigwv2.HttpMethod.DELETE], fn: admin },
    ];
    for (const route of routes) {
      this.httpApi.addRoutes({
        path: route.path,
        methods: route.methods,
        integration: new HttpLambdaIntegration(`${route.id}Integration`, route.fn),
      });
    }

    // The voice routes (`/conversations`) are added by VoiceStack with the same authorizer. Their
    // function lives there, and a route built here would make ApiStack and VoiceStack depend on
    // each other (the Lambda permission and the integration URI point in opposite directions).
    this.authorizerId = authorizer.authorizerId;

    // Route throttle for POST /simulate (R15.14). Best effort; hard counters are in DynamoDB (design C12).
    const stage = this.httpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage;
    stage.addPropertyOverride("RouteSettings", {
      "POST /simulate": { ThrottlingRateLimit: SIMULATE_RATE_LIMIT, ThrottlingBurstLimit: SIMULATE_BURST_LIMIT },
    });

    this.apiUrl = this.httpApi.apiEndpoint;
    this.apiId = this.httpApi.apiId;
    new CfnOutput(this, "ApiUrl", { value: this.apiUrl, description: "HTTP API base URL" });
    new CfnOutput(this, "UserPoolId", { value: this.userPoolId, description: "Cognito user pool id" });
    new CfnOutput(this, "UserPoolClientId", { value: this.userPoolClientId, description: "Cognito SPA app client id" });
  }
}

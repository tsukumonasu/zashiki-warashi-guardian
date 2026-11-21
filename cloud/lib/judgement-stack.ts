/**
 * JudgementStack: the path from the doll's MQTT messages to a verdict (R1.7 to R1.10, R4.6, R9.10,
 * R19.5, R20.7, R25.5).
 *
 * - IoT data endpoint (`iot:Data-ATS`) read by a `DescribeEndpoint` custom resource.
 * - Device IoT policy from `device-policy.ts` (attached to certificates by `provision_device.sh`).
 * - Exactly three topic rules, none on `commands`, each adding `topic(2) AS topicDeviceId`.
 * - `judge` and `ingest` Lambda functions, each with its own role, 14-day log group, esbuild bundle.
 * - `lambda:InvokeFunction` for `iot.amazonaws.com`, scoped by rule ARN and account.
 * - SNS topic with the e-mail subscription taken from CDK context.
 *
 * Verified with the AWS docs (2026-11, see design.md):
 * - Rule SQL and Lambda action: https://docs.aws.amazon.com/iot/latest/developerguide/lambda-rule-action.html
 *   (the resource policy uses `SourceArn` = rule ARN and `SourceAccount`; no `iam:PassRole` is needed).
 * - `iot:DescribeEndpoint` accepts no resource restriction, so its custom-resource policy uses `*`.
 *
 * Dashboard URL: `WebStack` depends on `ApiStack`, and `ApiStack` needs the IoT endpoint from this
 * stack, so this stack cannot read the CloudFront domain without a cycle (design, "Web and API stack
 * cycle"). The URL is therefore a plain prop, filled from the `dashboardUrl` context key.
 */
import {
  Aws,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
  type StackProps,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_iot as iot,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_s3 as s3,
  aws_sns as sns,
  aws_sns_subscriptions as subscriptions,
  custom_resources as cr,
} from "aws-cdk-lib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Construct } from "constructs";
import { envName, type CloudConfig } from "../lambda/_shared/config.js";
import { buildDevicePolicy } from "./device-policy.js";
/** Fixed name so `provision_device.sh --policy` and the README can refer to it. */
export const DEVICE_POLICY_NAME = "warashi-device";
/** Rule names fixed by R1.7. */
export const RULE_SNAPSHOTS = "warashi_snapshots";
export const RULE_INGEST_EVENTS = "warashi_ingest_events";
export const RULE_INGEST_STATUS = "warashi_ingest_status";
/** Exact rule SQL (R1.7, R1.9). Every rule adds `topic(2) AS topicDeviceId`. */
export const SQL_SNAPSHOTS =
  "SELECT *, topic(2) AS topicDeviceId FROM 'warashi/+/events' WHERE type = 'snapshot.captured'";
export const SQL_INGEST_EVENTS = "SELECT *, topic(2) AS topicDeviceId FROM 'warashi/+/events'";
export const SQL_INGEST_STATUS = "SELECT *, topic(2) AS topicDeviceId FROM 'warashi/+/status'";
/** Function settings from the design, "Lambda functions" (R4.6, R20.7). */
export const JUDGE_TIMEOUT_S = 15;
export const INGEST_TIMEOUT_S = 10;
export const FUNCTION_MEMORY_MB = 512;
export const MAX_EVENT_AGE_S = 60;
export const LOG_RETENTION = logs.RetentionDays.TWO_WEEKS;
/** Shown in notifications until the owner sets the `dashboardUrl` context key. Never a real host. */
export const DEFAULT_DASHBOARD_URL = "https://dashboard.example.invalid/";
const HERE = dirname(fileURLToPath(import.meta.url));
const CLOUD_DIR = resolve(HERE, "..");
export interface JudgementStackProps extends StackProps {
  /** Data bucket and table of `DataStack`. */
  bucket: s3.IBucket;
  table: dynamodb.ITable;
  householdCollectionId: string;
  /** Receives stranger notifications through an SNS e-mail subscription (R9.10). Validated by `context.ts`. */
  notificationEmail: string;
  /** Validated tunable settings, passed on as `WARASHI_*` environment variables. */
  config: CloudConfig;
  /** Address placed in the stranger notification. Must be `https://`. Default is a placeholder. */
  dashboardUrl?: string;
  /** Optional fixed label for notifications. Without it the device id is used. */
  deviceLabel?: string;
}
/** Returns the URL when it is an `https://` URL, otherwise throws and names the context key. */
export function checkDashboardUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid configuration: dashboardUrl is not a URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("Invalid configuration: dashboardUrl must start with https://");
  }
  return raw;
}
export class JudgementStack extends Stack {
  readonly iotEndpoint: string;
  readonly devicePolicyName: string;
  readonly topic: sns.Topic;
  readonly judgeFunction: nodejs.NodejsFunction;
  readonly ingestFunction: nodejs.NodejsFunction;
  constructor(scope: Construct, id: string, props: JudgementStackProps) {
    super(scope, id, props);
    const dashboardUrl = checkDashboardUrl(props.dashboardUrl ?? DEFAULT_DASHBOARD_URL);
    Tags.of(this).add("project", "zashiki-warashi");
    // --- IoT data endpoint (R4.6 uses it through IOT_DATA_ENDPOINT) -------------------------
    const endpointLogs = new logs.LogGroup(this, "IotEndpointLogs", {
      retention: LOG_RETENTION,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const describeEndpoint = new cr.AwsCustomResource(this, "IotDataEndpoint", {
      onUpdate: {
        service: "Iot",
        action: "describeEndpoint",
        parameters: { endpointType: "iot:Data-ATS" },
        physicalResourceId: cr.PhysicalResourceId.of("iot-data-ats-endpoint"),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["iot:DescribeEndpoint"],
          // iot:DescribeEndpoint has no resource type, so "*" is the only possible value.
          resources: ["*"],
        }),
      ]),
      installLatestAwsSdk: false,
      logGroup: endpointLogs,
    });
    this.iotEndpoint = describeEndpoint.getResponseField("endpointAddress");
    // --- Device policy (R1.1 to R1.6) ---------------------------------------------------
    this.devicePolicyName = DEVICE_POLICY_NAME;
    new iot.CfnPolicy(this, "DevicePolicy", {
      policyName: DEVICE_POLICY_NAME,
      policyDocument: buildDevicePolicy({ region: Aws.REGION, account: Aws.ACCOUNT_ID }),
    });
    // --- SNS topic and e-mail subscription (R9.10) -------------------------------------
    this.topic = new sns.Topic(this, "StrangerTopic", { displayName: "Warashi stranger alert" });
    this.topic.addSubscription(new subscriptions.EmailSubscription(props.notificationEmail));
    // --- Lambda functions ----------------------------------------------------------------
    const tableArn = props.table.tableArn;
    const tuning: Record<string, string> = {};
    for (const [setting, value] of Object.entries(props.config)) {
      tuning[envName(setting)] = String(value);
    }
    const commonEnv: Record<string, string> = {
      ...tuning,
      WARASHI_TABLE_NAME: props.table.tableName,
    };
    this.judgeFunction = this.makeFunction("Judge", "judge", JUDGE_TIMEOUT_S, 0, {
      ...commonEnv,
      WARASHI_BUCKET_NAME: props.bucket.bucketName,
      IOT_DATA_ENDPOINT: this.iotEndpoint,
      NOTIFY_TOPIC_ARN: this.topic.topicArn,
      WARASHI_DASHBOARD_URL: dashboardUrl,
      WARASHI_HOUSEHOLD_COLLECTION_ID: props.householdCollectionId,
      ...(props.deviceLabel === undefined ? {} : { WARASHI_DEVICE_LABEL: props.deviceLabel }),
    });
    // R4.5: ingest throws when its claim write fails so that Lambda can redeliver once or twice
    // (default retries). R4.6 fixes 0 retries for the Judge only.
    this.ingestFunction = this.makeFunction("Ingest", "ingest", INGEST_TIMEOUT_S, undefined, commonEnv);
    // Least privilege, design "Lambda functions". Item-level DynamoDB actions are what the
    // adapters call; a transaction is authorized through the actions of its parts, there is no
    // separate IAM action for TransactWriteItems.
    const tableActions = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"];
    const tableResources = [tableArn, `${tableArn}/index/*`];
    const collectionArn = this.formatArn({
      service: "rekognition",
      resource: "collection",
      resourceName: props.householdCollectionId,
    });
    this.judgeFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["rekognition:SearchFacesByImage"], resources: [collectionArn] }),
    );
    this.judgeFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["rekognition:DetectFaces"],
        // DetectFaces works on image bytes and has no resource type, so "*" is required.
        resources: ["*"],
      }),
    );
    this.judgeFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["s3:PutObject"], resources: [props.bucket.arnForObjects("snapshots/*")] }),
    );
    this.judgeFunction.addToRolePolicy(new iam.PolicyStatement({ actions: tableActions, resources: tableResources }));
    this.judgeFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iot:Publish"],
        resources: [this.formatArn({ service: "iot", resource: "topic", resourceName: "warashi/*/commands" })],
      }),
    );
    this.judgeFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["sns:Publish"], resources: [this.topic.topicArn] }),
    );
    this.ingestFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: tableActions, resources: tableResources }),
    );
    // --- Topic rules (R1.7 to R1.10): exactly three, none on `commands` -----------------
    this.addRule("SnapshotsRule", RULE_SNAPSHOTS, SQL_SNAPSHOTS, this.judgeFunction);
    this.addRule("IngestEventsRule", RULE_INGEST_EVENTS, SQL_INGEST_EVENTS, this.ingestFunction);
    this.addRule("IngestStatusRule", RULE_INGEST_STATUS, SQL_INGEST_STATUS, this.ingestFunction);
    // --- Outputs (R19.2) ----------------------------------------------------------------
    new CfnOutput(this, "IotEndpoint", { value: this.iotEndpoint, description: "AWS IoT data endpoint (iot:Data-ATS)" });
    new CfnOutput(this, "DevicePolicyName", { value: this.devicePolicyName, description: "IoT policy to attach to the doll's certificate" });
    new CfnOutput(this, "StrangerTopicArn", { value: this.topic.topicArn, description: "SNS topic for stranger alerts" });
  }
  private makeFunction(
    logicalId: string,
    folder: string,
    timeoutS: number,
    retryAttempts: number | undefined,
    environment: Record<string, string>,
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
      memorySize: FUNCTION_MEMORY_MB,
      timeout: Duration.seconds(timeoutS),
      maxEventAge: Duration.seconds(MAX_EVENT_AGE_S),
      ...(retryAttempts === undefined ? {} : { retryAttempts }),
      logGroup,
      environment,
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: "node24",
        minify: true,
        sourceMap: false,
        // Bundle the SDK clients too: the versions in package-lock.json are the ones tested.
        externalModules: [],
        mainFields: ["module", "main"],
        banner: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
      },
    });
  }
  private addRule(logicalId: string, ruleName: string, sql: string, target: lambda.IFunction): void {
    const rule = new iot.CfnTopicRule(this, logicalId, {
      ruleName,
      topicRulePayload: {
        sql,
        awsIotSqlVersion: "2016-03-23",
        ruleDisabled: false,
        actions: [{ lambda: { functionArn: target.functionArn } }],
      },
    });
    target.addPermission(`${logicalId}Invoke`, {
      principal: new iam.ServicePrincipal("iot.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: rule.attrArn,
      sourceAccount: this.account,
    });
  }
}

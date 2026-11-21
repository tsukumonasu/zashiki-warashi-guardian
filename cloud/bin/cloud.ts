#!/usr/bin/env node
/**
 * CDK app entry point (R19.1, R19.2, R19.5, R19.6, R25.2).
 *
 * Five stacks in dependency order, all in `ap-northeast-1`:
 *
 *   DataStack -> JudgementStack -> ApiStack -> WebStack
 *   BudgetStack (independent)
 *
 * Values that cross a stack boundary are passed as props, so CDK creates the exports and the
 * deployment order. The dashboard URL cannot be read from `WebStack` without a cycle, so
 * `JudgementStack` takes it from the `dashboardUrl` context key (design.md, "Web and API stack
 * cycle"). The account comes from the CLI (`CDK_DEFAULT_ACCOUNT`); no account id is in the code.
 */
import { App, Aspects, Tags, type IAspect } from "aws-cdk-lib";
import { CfnFunction } from "aws-cdk-lib/aws-lambda";
import type { IConstruct } from "constructs";
import { ApiStack, API_RUNTIME } from "../lib/api-stack.js";
import { BudgetStack } from "../lib/budget-stack.js";
import { loadContext } from "../lib/context.js";
import { DataStack } from "../lib/data-stack.js";
import { JudgementStack } from "../lib/judgement-stack.js";
import { WebStack } from "../lib/web-stack.js";

/** Every stack of the app is deployed here (R19.6). Services that need another Region are listed in design.md. */
export const DEPLOY_REGION = "ap-northeast-1";
/** Tag value on every taggable resource (R25.2). */
export const PROJECT_TAG = "zashiki-warashi";

/**
 * Forces the runtime of Lambda functions that CDK itself creates (the `BucketDeployment`
 * handler, the `autoDeleteObjects` and `AwsCustomResource` providers) to `nodejs24.x` (R19.5).
 * Runtimes that are not Node.js (for example Python) are left alone, because the handler code
 * is written for that language and cannot run on Node.js.
 */
export class NodeRuntimeAspect implements IAspect {
  visit(node: IConstruct): void {
    if (node instanceof CfnFunction && typeof node.runtime === "string" && node.runtime.startsWith("nodejs")) {
      node.runtime = API_RUNTIME.name;
    }
  }
}

/** Builds the whole app. Exported so tests can synthesize it without the CLI. */
export function buildApp(app: App = new App()): App {
  const context = loadContext(
    {
      notificationEmail: app.node.tryGetContext("notificationEmail"),
      budgetAmountUsd: app.node.tryGetContext("budgetAmountUsd"),
      budgetEmail: app.node.tryGetContext("budgetEmail"),
      ...tunableContext(app),
    },
    process.env,
  );
  const env = { account: process.env["CDK_DEFAULT_ACCOUNT"], region: DEPLOY_REGION };
  const dashboardUrl = app.node.tryGetContext("dashboardUrl") as string | undefined;

  const data = new DataStack(app, "DataStack", { env, snapshotExpiryDays: context.config.snapshotExpiryDays });

  const judgement = new JudgementStack(app, "JudgementStack", {
    env,
    bucket: data.bucket,
    table: data.table,
    householdCollectionId: data.householdCollectionId,
    notificationEmail: context.notificationEmail,
    config: context.config,
    dashboardUrl,
  });

  const api = new ApiStack(app, "ApiStack", {
    env,
    bucket: data.bucket,
    table: data.table,
    iotDataEndpoint: judgement.iotEndpoint,
    householdCollectionId: data.householdCollectionId,
    demoCollectionId: data.demoCollectionId,
  });

  new WebStack(app, "WebStack", {
    env,
    apiUrl: api.apiUrl,
    apiId: api.apiId,
    userPoolId: api.userPoolId,
    userPoolClientId: api.userPoolClientId,
  });

  new BudgetStack(app, "BudgetStack", { env });

  Tags.of(app).add("project", PROJECT_TAG);
  Aspects.of(app).add(new NodeRuntimeAspect());
  return app;
}

/** Tunable keys given as context (`-c key=value`) override the defaults; unknown keys are ignored by `loadConfig`. */
function tunableContext(app: App): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["snapshotExpiryDays", "familyMin", "strangerMax", "statusIntervalS", "reviewerRealEncounters"]) {
    const value: unknown = app.node.tryGetContext(key);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// Run only when started by the CDK CLI, not when a test imports `buildApp`.
if (process.env["CDK_OUTDIR"] !== undefined && process.env["VITEST"] === undefined) {
  buildApp().synth();
}

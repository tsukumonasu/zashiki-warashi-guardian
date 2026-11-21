/**
 * BudgetStack (R20.1 to R20.3): one monthly cost budget that e-mails the owner at 50, 80 and
 * 100 percent of actual spend. A budget only alerts; it does not stop spending (design C17).
 */
import { Stack, type StackProps } from "aws-cdk-lib";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import type { Construct } from "constructs";
import { readBudgetAmount, readEmail } from "./context.js";

/** Percentages of the budget amount that trigger a notification (R20.1). */
export const BUDGET_THRESHOLD_PERCENTS = [50, 80, 100] as const;

export class BudgetStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Read here, not in the app, so a missing or invalid key fails synthesis of this stack
    // with the key name and no template is produced (R20.3). `readEmail` never echoes the address.
    const amount = readBudgetAmount("budgetAmountUsd", this.node.tryGetContext("budgetAmountUsd"));
    const email = readEmail("budgetEmail", this.node.tryGetContext("budgetEmail"));

    new CfnBudget(this, "MonthlyCostBudget", {
      budget: {
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount, unit: "USD" },
      },
      notificationsWithSubscribers: BUDGET_THRESHOLD_PERCENTS.map((threshold) => ({
        notification: {
          notificationType: "ACTUAL",
          comparisonOperator: "GREATER_THAN",
          thresholdType: "PERCENTAGE",
          threshold,
        },
        subscribers: [{ subscriptionType: "EMAIL", address: email }],
      })),
    });
  }
}

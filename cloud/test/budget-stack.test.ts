/** Template tests for BudgetStack. Validates: Requirements 20.1, 20.2, 20.3. */
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BudgetStack } from "../lib/budget-stack.js";

const EMAIL = "owner@example.invalid";

function synth(context: Record<string, unknown>): Template {
  const app = new App({ context });
  return Template.fromStack(new BudgetStack(app, "BudgetStack"));
}

describe("BudgetStack", () => {
  const template = synth({ budgetAmountUsd: 12.5, budgetEmail: EMAIL });

  it("creates exactly one monthly USD cost budget (R20.1)", () => {
    template.resourceCountIs("AWS::Budgets::Budget", 1);
    template.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: { BudgetType: "COST", TimeUnit: "MONTHLY", BudgetLimit: { Amount: 12.5, Unit: "USD" } },
    });
  });

  it("notifies on actual spend at 50, 80 and 100 percent to the budget e-mail (R20.1)", () => {
    const budget = Object.values(template.findResources("AWS::Budgets::Budget"))[0];
    const items = budget.Properties.NotificationsWithSubscribers as Array<{
      Notification: Record<string, unknown>;
      Subscribers: Array<Record<string, unknown>>;
    }>;
    expect(items.map((i) => i.Notification["Threshold"])).toEqual([50, 80, 100]);
    for (const item of items) {
      expect(item.Notification["NotificationType"]).toBe("ACTUAL");
      expect(item.Notification["ThresholdType"]).toBe("PERCENTAGE");
      expect(item.Subscribers).toEqual([{ SubscriptionType: "EMAIL", Address: EMAIL }]);
    }
  });

  it("accepts a numeric string amount from `cdk -c` (R20.2)", () => {
    synth({ budgetAmountUsd: "5", budgetEmail: EMAIL }).resourceCountIs("AWS::Budgets::Budget", 1);
  });

  it.each([
    ["missing amount", { budgetEmail: EMAIL }, "budgetAmountUsd"],
    ["zero amount", { budgetAmountUsd: 0, budgetEmail: EMAIL }, "budgetAmountUsd"],
    ["negative amount", { budgetAmountUsd: -1, budgetEmail: EMAIL }, "budgetAmountUsd"],
    ["non-numeric amount", { budgetAmountUsd: "abc", budgetEmail: EMAIL }, "budgetAmountUsd"],
    ["missing e-mail", { budgetAmountUsd: 10 }, "budgetEmail"],
    ["e-mail without @", { budgetAmountUsd: 10, budgetEmail: "nobody" }, "budgetEmail"],
    ["e-mail with two @", { budgetAmountUsd: 10, budgetEmail: "a@b@c" }, "budgetEmail"],
    ["e-mail over 254 characters", { budgetAmountUsd: 10, budgetEmail: `${"a".repeat(251)}@x.y` }, "budgetEmail"],
  ])("fails synthesis naming the key: %s (R20.3)", (_name, context, key) => {
    expect(() => synth(context)).toThrow(key);
  });

  it("does not echo the e-mail address in the error (privacy)", () => {
    let message = "";
    try {
      synth({ budgetAmountUsd: 10, budgetEmail: "secret-name.example.invalid" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("budgetEmail");
    expect(message).not.toContain("secret-name");
  });
});

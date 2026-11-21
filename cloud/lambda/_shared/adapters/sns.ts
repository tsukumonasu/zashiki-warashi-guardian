/**
 * SNS adapter for the `Notifier` port (cloud-judgement design).
 *
 * Thin on purpose: subject and body go to the one family topic unchanged. The text is built and
 * checked by `notify.ts`. The adapter does not retry; a failure rejects so the caller can give
 * the notify slot back.
 */

import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";

import type { Notifier } from "../ports.js";

/** Environment variable that holds the topic ARN. Never hard-code it. */
export const NOTIFY_TOPIC_ENV = "NOTIFY_TOPIC_ARN";

/** The one SDK method used, so tests can pass a small fake. */
export type SnsPublisher = Pick<SNSClient, "send">;

let defaultClient: SNSClient | undefined;

function getDefaultClient(): SNSClient {
  defaultClient ??= new SNSClient({});
  return defaultClient;
}

export type SnsNotifierOptions = {
  client?: SnsPublisher;
  /** Defaults to the `NOTIFY_TOPIC_ARN` environment variable. */
  topicArn?: string;
};

export function createSnsNotifier(options: SnsNotifierOptions = {}): Notifier {
  return {
    async send(message: { subject: string; body: string }): Promise<void> {
      const topicArn = options.topicArn ?? process.env[NOTIFY_TOPIC_ENV];
      if (topicArn === undefined || topicArn.length === 0) {
        throw new Error(`${NOTIFY_TOPIC_ENV} is not set`);
      }
      const client = options.client ?? getDefaultClient();
      await client.send(
        new PublishCommand({
          TopicArn: topicArn,
          Subject: message.subject,
          Message: message.body,
        }),
      );
    },
  };
}

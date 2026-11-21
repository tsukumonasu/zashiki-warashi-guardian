/**
 * Pure builder for the device IoT policy (requirements R1.1 to R1.6).
 *
 * Syntax verified with the AWS docs (cited in design.md, "Device policy"):
 * - Thing policy variables and `iot:Connection.Thing.IsAttached`:
 *   https://docs.aws.amazon.com/iot/latest/developerguide/thing-policy-variables.html
 * - `iot:ConnectAttributes` with `ForAllValues:StringEquals` (only `LastWill` allowed, so a
 *   `PersistentConnect` request is refused):
 *   https://docs.aws.amazon.com/iot/latest/developerguide/connect-policy.html
 * - ARN forms `client/`, `topic/` and `topicfilter/`:
 *   https://docs.aws.amazon.com/iot/latest/developerguide/iot-policies.html
 *
 * The `${iot:Connection.Thing.ThingName}` text is an IoT policy variable that AWS IoT expands
 * at connect time. It is deliberately a plain string, not a TypeScript template placeholder.
 * The client id must equal the thing name, which equals the doll's `deviceId`.
 */

/** The IoT policy variable that AWS IoT replaces with the connected thing's name. */
export const THING_NAME_VARIABLE = '${iot:Connection.Thing.ThingName}';

export interface DevicePolicyStatement {
  readonly Effect: 'Allow';
  readonly Action: string;
  readonly Resource: string | readonly string[];
  readonly Condition?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface DevicePolicyDocument {
  readonly Version: '2012-10-17';
  readonly Statement: readonly DevicePolicyStatement[];
}

export interface DevicePolicyParams {
  /** AWS Region of the IoT endpoint, for example `ap-northeast-1`. */
  readonly region: string;
  /** AWS account id (12 digits). May be a CDK token when used inside a stack. */
  readonly account: string;
}

/** Builds the device policy document. Pure: the same input always gives the same document. */
export function buildDevicePolicy(params: DevicePolicyParams): DevicePolicyDocument {
  const base = `arn:aws:iot:${params.region}:${params.account}`;
  const topic = (suffix: string): string =>
    `${base}:topic/warashi/${THING_NAME_VARIABLE}/${suffix}`;

  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: 'iot:Connect',
        Resource: `${base}:client/${THING_NAME_VARIABLE}`,
        Condition: {
          Bool: { 'iot:Connection.Thing.IsAttached': 'true' },
          'ForAllValues:StringEquals': { 'iot:ConnectAttributes': ['LastWill'] },
        },
      },
      {
        Effect: 'Allow',
        Action: 'iot:Publish',
        Resource: [topic('events'), topic('status')],
      },
      {
        Effect: 'Allow',
        Action: 'iot:Subscribe',
        Resource: `${base}:topicfilter/warashi/${THING_NAME_VARIABLE}/commands`,
      },
      {
        Effect: 'Allow',
        Action: 'iot:Receive',
        Resource: topic('commands'),
      },
    ],
  };
}

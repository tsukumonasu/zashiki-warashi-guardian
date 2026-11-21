import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  buildDevicePolicy,
  THING_NAME_VARIABLE,
  type DevicePolicyDocument,
} from '../lib/device-policy.js';

const regionArb = fc
  .tuple(
    fc.constantFrom('ap', 'us', 'eu', 'sa', 'ca'),
    fc.constantFrom('northeast', 'southeast', 'west', 'east', 'central'),
    fc.integer({ min: 1, max: 9 }),
  )
  .map(([a, b, n]) => `${a}-${b}-${n}`);

const accountArb = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 12, maxLength: 12 })
  .map((digits) => digits.join(''));

const paramsArb = fc.record({ region: regionArb, account: accountArb });

function resourcesOf(policy: DevicePolicyDocument): string[] {
  return policy.Statement.flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]));
}

/** The part of an IoT ARN after `:topic/` or `:topicfilter/`, or null for other resources. */
function topicPart(resource: string): string | null {
  const match = /:topic(?:filter)?\/(.*)$/.exec(resource);
  return match ? (match[1] ?? null) : null;
}

const TOPIC_PREFIX = `warashi/${THING_NAME_VARIABLE}/`;

describe('device policy shape', () => {
  it('Feature: cloud-judgement, Property 21: Device policy shape', () => {
    fc.assert(
      fc.property(paramsArb, (params) => {
        const policy = buildDevicePolicy(params);
        const resources = resourcesOf(policy);
        expect(resources.length).toBeGreaterThan(0);
        for (const resource of resources) {
          expect(resource).not.toBe('*');
          expect(resource.includes('*')).toBe(false);
          const topic = topicPart(resource);
          if (topic !== null) {
            expect(topic.startsWith(TOPIC_PREFIX)).toBe(true);
          }
        }
        // Every topic and topic filter ARN is recognized, so the check above is not vacuous.
        expect(resources.filter((r) => topicPart(r) !== null).length).toBe(4);
      }),
      { numRuns: 100 },
    );
  });

  const policy = buildDevicePolicy({ region: 'ap-northeast-1', account: '000000000000' });
  const byAction = (action: string) => policy.Statement.filter((s) => s.Action === action);

  it('R1.1: connect only as the attached thing, with LastWill only', () => {
    const [connect, ...rest] = byAction('iot:Connect');
    expect(rest).toHaveLength(0);
    expect(connect?.Resource).toMatch(/:client\/\$\{iot:Connection\.Thing\.ThingName\}$/);
    expect(connect?.Condition?.Bool).toEqual({ 'iot:Connection.Thing.IsAttached': 'true' });
    expect(connect?.Condition?.['ForAllValues:StringEquals']).toEqual({
      'iot:ConnectAttributes': ['LastWill'],
    });
  });

  it('R1.2: publish only on events and status of its own thing', () => {
    const [publish, ...rest] = byAction('iot:Publish');
    expect(rest).toHaveLength(0);
    expect(publish?.Resource).toEqual([
      expect.stringMatching(/:topic\/warashi\/\$\{iot:Connection\.Thing\.ThingName\}\/events$/),
      expect.stringMatching(/:topic\/warashi\/\$\{iot:Connection\.Thing\.ThingName\}\/status$/),
    ]);
  });

  it('R1.3: subscribe only to the commands topic filter', () => {
    const [subscribe, ...rest] = byAction('iot:Subscribe');
    expect(rest).toHaveLength(0);
    expect(subscribe?.Resource).toMatch(
      /:topicfilter\/warashi\/\$\{iot:Connection\.Thing\.ThingName\}\/commands$/,
    );
  });

  it('R1.4: receive only on the commands topic', () => {
    const [receive, ...rest] = byAction('iot:Receive');
    expect(rest).toHaveLength(0);
    expect(receive?.Resource).toMatch(
      /:topic\/warashi\/\$\{iot:Connection\.Thing\.ThingName\}\/commands$/,
    );
  });

  it('R1.6: only the four IoT actions, all Allow', () => {
    expect(policy.Statement.map((s) => s.Action).sort()).toEqual([
      'iot:Connect',
      'iot:Publish',
      'iot:Receive',
      'iot:Subscribe',
    ]);
    expect(policy.Statement.every((s) => s.Effect === 'Allow')).toBe(true);
  });
});

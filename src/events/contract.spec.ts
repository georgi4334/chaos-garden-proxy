import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contractProblems, contractsDir, validateEvent } from '../../test/contract.js';
import { MAX_EVENT_PATH_LENGTH, type RequestEventV1 } from './request-event.js';

const fixtures = (kind: 'valid' | 'invalid') =>
  readdirSync(join(contractsDir, 'fixtures', kind)).map(
    (f) => [f, JSON.parse(readFileSync(join(contractsDir, 'fixtures', kind, f), 'utf8'))] as const,
  );

describe('request-event v1 contract (producer: proxy)', () => {
  it.each(fixtures('valid'))('the schema accepts valid/%s', (_name, event) => {
    expect(validateEvent(event)).toBe(true);
  });

  it.each(fixtures('invalid'))('the schema rejects invalid/%s', (_name, event) => {
    expect(validateEvent(event)).toBe(false);
  });

  it('the strict producer check flags undocumented properties', () => {
    const [, withExtra] = fixtures('valid').find(([name]) => name === 'unknown-extra-property.json')!;
    expect(contractProblems(withExtra)).toEqual(['undocumented property "newOptionalField"']);
  });

  it('every property of the TypeScript event type is in the schema', () => {
    // Compile-time list: adding a field to RequestEventV1 without this list fails the build.
    const keys: Record<keyof RequestEventV1, true> = {
      v: true, id: true, at: true, gardenId: true, targetId: true, targetName: true, method: true, path: true,
      status: true, completed: true, durationMs: true, faults: true, ruleIds: true, requestId: true,
    };
    const longest: RequestEventV1 = {
      v: 1,
      id: '0b0c6f0e-6f45-4a39-9a4c-2d8a9a1f5c11',
      at: new Date().toISOString(),
      gardenId: '11111111-1111-4111-8111-111111111111',
      targetId: '22222222-2222-4222-8222-222222222222',
      targetName: 'api',
      method: 'GET',
      path: `/${'x'.repeat(MAX_EVENT_PATH_LENGTH - 1)}`,
      status: null,
      completed: false,
      durationMs: 0,
      faults: ['latency', 'drop'],
      ruleIds: [],
      requestId: 'trace-0001-from-proxy',
    };
    expect(Object.keys(keys).sort()).toEqual(Object.keys(longest).sort());
    expect(contractProblems(longest)).toEqual([]);
  });
});

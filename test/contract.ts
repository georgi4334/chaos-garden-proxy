import Ajv2020Import from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type AjvCtor = typeof import('ajv/dist/2020.js').default;
const Ajv2020 = ((Ajv2020Import as unknown as { default?: AjvCtor }).default ?? Ajv2020Import) as AjvCtor;
const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (
  ajv: InstanceType<AjvCtor>,
) => unknown;

export const contractsDir = join(dirname(fileURLToPath(import.meta.url)), '../contracts');
export const schema = JSON.parse(readFileSync(join(contractsDir, 'request-event.v1.schema.json'), 'utf8')) as {
  properties: Record<string, unknown>;
};

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
export const validateEvent = ajv.compile(schema);

/**
 * Producer check: the event must match the schema, and (stricter than what
 * consumers accept) must not carry any property the schema doesn't document.
 * A new field has to be added to the contract first.
 */
export function contractProblems(event: unknown): string[] {
  const problems: string[] = [];
  if (!validateEvent(event)) {
    problems.push(...(validateEvent.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}`));
  }
  if (event && typeof event === 'object') {
    for (const key of Object.keys(event)) {
      if (!(key in schema.properties)) problems.push(`undocumented property "${key}"`);
    }
  }
  return problems;
}

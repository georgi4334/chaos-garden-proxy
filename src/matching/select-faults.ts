import { matchesPath } from './glob.js';

export type FaultType = 'latency' | 'error' | 'drop' | 'corrupt';

export interface Rule {
  id: string;
  method: string;
  pathPattern: string;
  type: FaultType;
  probability: number;
  params: Record<string, unknown>;
}

export interface Selection {
  /** First latency rule that fired, if any. Applied before anything else. */
  latency?: Rule;
  /** First error/drop/corrupt rule that fired, if any. At most one is applied. */
  terminal?: Rule;
}

/**
 * Walks the rules in order (the control API returns them oldest first). A rule
 * is eligible when its method and path match; it then fires with its own
 * probability. `random` must return a number in [0, 1), so probability 0 never
 * fires and probability 1 always does.
 */
export function selectFaults(
  rules: readonly Rule[],
  request: { method: string; path: string },
  random: () => number,
): Selection {
  const selection: Selection = {};
  for (const rule of rules) {
    if (selection.latency && selection.terminal) break;
    if (rule.method !== '*' && rule.method.toUpperCase() !== request.method.toUpperCase()) continue;
    if (!matchesPath(rule.pathPattern, request.path)) continue;

    if (rule.type === 'latency') {
      if (selection.latency) continue;
      if (random() < rule.probability) selection.latency = rule;
    } else {
      if (selection.terminal) continue;
      if (random() < rule.probability) selection.terminal = rule;
    }
  }
  return selection;
}

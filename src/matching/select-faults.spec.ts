import { selectFaults, type Rule } from './select-faults.js';

const rule = (over: Partial<Rule> & Pick<Rule, 'id' | 'type'>): Rule => ({
  method: '*',
  pathPattern: '/*',
  probability: 1,
  params: {},
  ...over,
});

const req = { method: 'GET', path: '/users/1' };
const always = () => 0; // 0 < any probability above 0

describe('selectFaults', () => {
  it('returns nothing when there are no rules', () => {
    expect(selectFaults([], req, always)).toEqual({});
  });

  it('probability 1 always fires and probability 0 never fires', () => {
    const r = rule({ id: 'a', type: 'error', params: { status: 500 } });
    expect(selectFaults([r], req, () => 0.999999).terminal).toBe(r);
    expect(selectFaults([{ ...r, probability: 0 }], req, () => 0).terminal).toBeUndefined();
  });

  it('respects the random roll against the probability', () => {
    const r = rule({ id: 'a', type: 'error', probability: 0.5 });
    expect(selectFaults([r], req, () => 0.49).terminal).toBe(r);
    expect(selectFaults([r], req, () => 0.5).terminal).toBeUndefined();
  });

  it('filters by method (case-insensitive) and path', () => {
    const post = rule({ id: 'p', type: 'error', method: 'post' });
    const orders = rule({ id: 'o', type: 'drop', pathPattern: '/orders/*' });
    expect(selectFaults([post, orders], req, always)).toEqual({});
    expect(selectFaults([post], { method: 'POST', path: '/x' }, always).terminal).toBe(post);
  });

  it('applies one latency and one terminal rule together, first match wins', () => {
    const l1 = rule({ id: 'l1', type: 'latency', params: { ms: 10 } });
    const l2 = rule({ id: 'l2', type: 'latency', params: { ms: 99 } });
    const e = rule({ id: 'e', type: 'error', params: { status: 503 } });
    const d = rule({ id: 'd', type: 'drop' });
    const sel = selectFaults([l1, e, l2, d], req, always);
    expect(sel.latency).toBe(l1);
    expect(sel.terminal).toBe(e);
  });

  it('a rule that does not fire lets a later rule of the same kind fire', () => {
    const first = rule({ id: 'f', type: 'error', probability: 0.1 });
    const second = rule({ id: 's', type: 'drop', probability: 1 });
    const rolls = [0.9, 0.0];
    const sel = selectFaults([first, second], req, () => rolls.shift() ?? 0);
    expect(sel.terminal).toBe(second);
  });

  it('does not roll for rules that do not match', () => {
    const rolls: number[] = [];
    const miss = rule({ id: 'm', type: 'error', pathPattern: '/nope' });
    selectFaults([miss], req, () => (rolls.push(1), 0));
    expect(rolls).toHaveLength(0);
  });
});

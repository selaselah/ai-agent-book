import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildNodes, contextOf, usageOf } from './model.js';

const evidence = JSON.parse(readFileSync(new URL('../validation/latest.json', import.meta.url), 'utf8'));
const arm = mode => evidence.arms.find(a => a.mode === mode);

test('every recorded tool is attached to its response call', () => {
  for (const a of evidence.arms) {
    const tools = buildNodes(a).filter(n => n.kind === 'tool');
    assert.equal(tools.length, a.tool_calls.length);
    for (const node of tools) {
      assert.equal(node.local.tool_name, node.name);
      assert.deepEqual(node.local.arguments, node.args);
    }
  }
});
test('no-history tools have real results, but no observation in the next request', () => {
  for (const node of buildNodes(arm('no_history')).filter(n => n.kind === 'tool')) {
    assert.ok(node.local.result);
    assert.equal(node.sent, undefined);
  }
});
test('hidden results remain distinct from local execution results', () => {
  for (const node of buildNodes(arm('no_tool_results')).filter(n => n.kind === 'tool')) {
    assert.ok(node.local.result);
    if (arm('no_tool_results').api_turns.some(t => t.iteration > node.turn.iteration)) assert.equal(node.sent?.content, '');
    else assert.equal(node.sent, undefined);
  }
});
test('full-context observations are nonempty; repeated tool actions match evidence', () => {
  for (const a of evidence.arms) {
    assert.equal(buildNodes(a).filter(n => n.repeat).length, a.repeated_tool_calls);
  }
  assert.ok(buildNodes(arm('full')).filter(n => n.kind === 'tool').every(n => n.sent?.content));
});
test('context counters reflect actual serialized requests', () => {
  assert.equal(contextOf(arm('no_history').api_turns.at(-1)).messages, 2);
  assert.equal(contextOf(arm('no_tool_calls').api_turns[0]).tools, 0);
  assert.equal(contextOf(arm('no_reasoning').api_turns.at(-1)).reasoning, 0);
  assert.ok(contextOf(arm('full').api_turns.at(-1)).reasoning > 0);
});
test('token totals reconcile with the recorded aggregate', () => {
  const sum = evidence.arms.reduce((sum, a) => { const u = usageOf(a); return sum + u.input + u.output; }, 0);
  assert.equal(sum, evidence.analysis.usage.total_tokens);
});
test('repeat detection ignores JSON argument key order', () => {
  const a = structuredClone(arm('no_history'));
  const first = a.api_turns[0].response.choices[0].message.tool_calls[0];
  const second = a.api_turns[1].response.choices[0].message.tool_calls[0];
  second.function = { ...first.function, arguments: JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(first.function.arguments)).reverse())) };
  assert.equal(buildNodes(a).find(n => n.id === 'tool-2-0').repeat, true);
});
test('a tool called at the iteration ceiling has no claimed next-turn observation', () => {
  const a = structuredClone(arm('full'));
  a.api_turns = a.api_turns.slice(0, 1);
  assert.ok(buildNodes(a).filter(n => n.kind === 'tool').every(n => !n.sent));
});

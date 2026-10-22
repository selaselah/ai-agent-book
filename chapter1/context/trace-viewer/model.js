export const MODES = {
  full: { name: '完整上下文', en: 'Full context', short: '基线', description: '保留完整消息、工具定义和执行结果。', insight: '模型能够接续上一轮工具结果，完成换汇与汇总。', tone: 'green' },
  no_history: { name: '移除历史消息', en: 'No history', short: '无历史', description: '每轮仅发送系统提示词与当前任务。', insight: '每轮都重新开始：工具已经执行，但下一轮请求不再携带这些历史。', tone: 'amber' },
  no_reasoning: { name: '移除历史推理', en: 'No reasoning history', short: '无历史推理', description: '剥离历史 assistant 消息的 reasoning_content；模型仍可在新一轮推理。', insight: '移除的是历史推理内容。本次仍然答对，没有观察到准确性下降。', tone: 'green' },
  no_tool_calls: { name: '移除工具定义', en: 'No tool definitions', short: '无工具定义', description: '请求不提供 tools 和 tool_choice。', insight: '模型没有收到工具定义，无法调用换汇工具；本次说明了限制，没有编造数字。', tone: 'neutral' },
  no_tool_results: { name: '移除工具结果', en: 'No tool results', short: '无工具结果', description: '工具实际执行，但发送给模型的 tool 消息内容为空。', insight: '工具在本地执行成功，不等于模型看到了结果。本次最终回答出现了无依据的金额。', tone: 'red' },
};

export const OUTCOMES = {
  correct: ['结果正确', 'green'], no_terminal_response: ['未完成', 'amber'],
  no_unsupported_numbers: ['未给出无依据数字', 'neutral'], unsupported_numbers: ['无依据数字', 'red'], incorrect: ['结果错误', 'red'],
};
export const json = value => JSON.stringify(value, null, 2);
export const number = value => Number(value || 0).toLocaleString('en-US');
export const messageOf = turn => turn.response?.choices?.[0]?.message || {};
export function usageOf(arm) {
  return arm.api_turns.reduce((out, turn) => {
    const u = turn.response?.usage || {};
    out.input += u.prompt_tokens ?? u.input_tokens ?? 0;
    out.output += u.completion_tokens ?? u.output_tokens ?? 0;
    return out;
  }, { input: 0, output: 0 });
}
export function parseArguments(call) {
  try { return JSON.parse(call.function?.arguments || '{}'); }
  catch { return call.function?.arguments || ''; }
}
function canonicalArguments(value) {
  if (Array.isArray(value)) return value.map(canonicalArguments);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalArguments(value[key])]));
  return value;
}
export function buildNodes(arm) {
  const nodes = [{ id: 'root', kind: 'root', name: MODES[arm.mode]?.name || arm.mode }];
  let toolCursor = 0;
  const seen = new Set();
  for (const turn of arm.api_turns) {
    const i = turn.iteration;
    const message = messageOf(turn);
    const calls = message.tool_calls || [];
    nodes.push({ id: `turn-${i}`, kind: 'llm', name: `第 ${i} 轮`, turn, calls });
    calls.forEach((call, index) => {
      const args = parseArguments(call);
      const signature = `${call.function?.name}:${JSON.stringify(canonicalArguments(args))}`;
      const repeat = seen.has(signature);
      seen.add(signature);
      const local = arm.tool_calls[toolCursor++];
      // Only a subsequent request is evidence that a result reached the model.
      const nextTurn = arm.api_turns.find(t => t.iteration > i);
      const sent = nextTurn?.request?.messages?.find(m => m.role === 'tool' && m.tool_call_id === call.id);
      nodes.push({ id: `tool-${i}-${index}`, kind: 'tool', name: call.function?.name || 'tool', turn, call, args, local, sent, repeat });
    });
  }
  return nodes;
}
export function contextOf(turn) {
  const messages = turn.request.messages || [];
  return {
    messages: messages.length,
    history: messages.filter(m => m.role === 'assistant').length,
    tools: turn.request.tools?.length || 0,
    observations: messages.filter(m => m.role === 'tool' && m.content).length,
    empty: messages.filter(m => m.role === 'tool' && !m.content).length,
    reasoning: messages.filter(m => m.role === 'assistant' && m.reasoning_content).length,
  };
}

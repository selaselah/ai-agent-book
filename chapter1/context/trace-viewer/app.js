import { MODES, OUTCOMES, json, number, messageOf, usageOf, parseArguments, buildNodes, contextOf } from './model.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const state = { evidence: null, arm: null, nodes: [], node: null, tab: 'overview', timer: null, query: '' };
let toastTimer;
const status = outcome => { const [text, tone] = OUTCOMES[outcome] || [outcome, 'neutral']; return `<span class="status ${tone}">${escape(text)}</span>`; };
const label = (title, hint = '') => `<div class="content-label">${title}<span>${escape(hint)}</span></div>`;
const metric = (title, value, unit = '') => `<div class="metric"><div class="metric-label">${title}</div><div class="metric-value">${value}${unit ? ` <small>${unit}</small>` : ''}</div></div>`;
const rawBlock = value => `<pre>${escape(typeof value === 'string' ? value : json(value))}</pre>`;
const kv = (key, value) => `<div class="kv"><span>${escape(key)}</span><span class="mono">${escape(value)}</span></div>`;
const sec = value => `${Number(value).toFixed(2)}s`;
const contextChips = turn => {
  const c = contextOf(turn);
  return `<div class="context-grid">${[
    ['消息总数', c.messages], ['历史 assistant', c.history], ['工具定义', c.tools],
    ['非空工具观测', c.observations], ['空工具消息', c.empty], ['保留历史推理', c.reasoning],
  ].map(([name, count]) => `<div class="context-chip ${!count && name !== '空工具消息' ? 'missing' : ''}">${name}<strong>${count}</strong></div>`).join('')}</div>`;
};

function toast(text) {
  $('#toast').textContent = text;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 2300);
}

function formatDate(date) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(date));
}

function renderCards() {
  $('#experiment-grid').innerHTML = state.evidence.arms.map((arm, index) => {
    const mode = MODES[arm.mode];
    const selected = arm === state.arm;
    return `<button class="experiment-card ${selected ? 'selected' : ''}" data-mode="${escape(arm.mode)}" aria-pressed="${selected}"><div class="card-top"><span class="card-index">0${index + 1}</span><span>${index ? 'ABLATION' : 'BASELINE'}</span>${selected ? '<span class="card-selected">✓</span>' : ''}</div><h2>${mode.name}</h2><div class="card-en">${mode.en}</div><div class="card-status">${status(arm.outcome)}</div><div class="card-metrics"><span><strong>${arm.iterations}</strong> 轮调用</span><span><strong>${arm.tool_calls.length}</strong> 工具</span><strong>${sec(arm.elapsed_seconds)}</strong></div></button>`;
  }).join('');
}

function selectArm(mode, nodeId = 'root') {
  stopReplay();
  state.arm = state.evidence.arms.find(arm => arm.mode === mode) || state.evidence.arms[0];
  state.nodes = buildNodes(state.arm);
  state.node = state.nodes.find(node => node.id === nodeId) || state.nodes[0];
  state.query = '';
  $('#search').value = '';
  const meta = MODES[state.arm.mode];
  $('#active-name').textContent = meta.name;
  $('#insight').innerHTML = `<span class="insight-symbol">i</span><span>${meta.insight}</span>`;
  renderCards();
  renderTree();
  renderDetail();
  updateHash();
}

function updateHash() {
  const hash = `#${state.arm.mode}/${state.node.id}/${state.tab}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

function renderTree() {
  $('#node-count').textContent = `${state.nodes.length} nodes`;
  const visible = state.nodes.filter(node => !state.query || `${node.name} ${node.turn?.iteration || ''} ${json(node.args || {})}`.toLowerCase().includes(state.query));
  $('#trace-tree').innerHTML = visible.length ? visible.map(node => {
    let hint = '', info = '', icon = '◇';
    if (node.kind === 'root') { hint = 'Agent run'; info = sec(state.arm.elapsed_seconds); icon = '⌘'; }
    if (node.kind === 'llm') { hint = `${node.calls.length ? node.calls.length + ' 个工具调用' : '最终文本回答'}`; info = `${number(node.turn.response.usage?.total_tokens)} t`; }
    if (node.kind === 'tool') { hint = node.name === 'convert_currency' ? `${node.args.from_currency} → ${node.args.to_currency}` : 'Python execution'; icon = 'ƒ'; }
    return `<button class="node ${node.kind} ${state.node.id === node.id ? 'selected' : ''}" data-node="${node.id}" aria-current="${state.node.id === node.id ? 'step' : 'false'}"><span class="node-icon ${node.kind}">${icon}</span><span class="node-label">${escape(node.name)}<small>${escape(hint)}</small></span>${node.repeat ? '<span class="repeat-icon" title="与之前相同的工具参数">↻</span>' : `<span class="node-info">${info}</span>`}</button>`;
  }).join('') : '<div class="empty-state">没有匹配的节点</div>';
  updateReplay();
}

function selectNode(id, scroll = false) {
  state.node = state.nodes.find(node => node.id === id) || state.nodes[0];
  renderTree();
  renderDetail();
  updateHash();
  if (scroll) document.querySelector(`[data-node="${state.node.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderDetail() {
  const { node, arm } = state;
  const kind = node.kind === 'root' ? 'AGENT RUN' : node.kind === 'llm' ? 'CHAT MODEL' : 'TOOL EXECUTION';
  const subtitle = node.kind === 'root' ? `${arm.model} · ${formatDate(arm.started_at)}` : node.kind === 'llm' ? `${arm.model} · 第 ${node.turn.iteration} 轮 · ${number(node.turn.response.usage?.total_tokens)} tokens` : `第 ${node.turn.iteration} 轮 · ${node.call.id}`;
  $('#detail-heading').innerHTML = `<div><div class="detail-title"><span class="node-icon ${node.kind}">${node.kind === 'root' ? '⌘' : node.kind === 'tool' ? 'ƒ' : '◇'}</span>${escape(node.kind === 'llm' ? `${arm.model} / ${node.name}` : node.name)}</div><div class="detail-subtitle">${escape(subtitle)}</div></div><div class="detail-actions"><span class="status neutral">${kind}</span><button class="copy-button" data-action="copy">复制 JSON</button></div>`;
  document.querySelectorAll('[data-tab]').forEach(tab => { const active = tab.dataset.tab === state.tab; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', active); });
  $('#detail-body').innerHTML = state.tab === 'raw' ? rawView() : node.kind === 'root' ? rootView() : node.kind === 'llm' ? llmView() : toolView();
  $('#detail-body').scrollTop = 0;
}

function rootView() {
  const { arm, evidence, tab } = state;
  const u = usageOf(arm);
  if (tab === 'input') return label('任务原文', '相同任务用于所有实验组') + rawBlock(evidence.task) + label('上下文设置') + rawBlock({ mode: arm.mode, description: MODES[arm.mode].description, task_variant: evidence.task_variant, hidden_result_style: evidence.hidden_result_style });
  if (tab === 'output') return finalAnswer(arm) + label('自动评分', '完成运行 ≠ 任务正确') + rawBlock({ completed: arm.completed, task_success: arm.task_success, outcome: arm.outcome, groundedness: arm.groundedness });
  return `<div class="summary-metrics">${metric('运行耗时', arm.elapsed_seconds.toFixed(2), '秒')}${metric('模型调用', arm.iterations, '轮')}${metric('工具执行', arm.tool_calls.length, '次')}${metric('Token 用量', number(u.input + u.output))}</div>`
    + label('任务', 'TASK INPUT')
    + `<div class="task-card">将四个季度的营收换算为美元，计算年度总营收与季度平均值。<div class="task-grid"><div><small>Q1 · USD</small><strong>2,500,000</strong></div><div><small>Q2 · EUR</small><strong>2,100,000</strong></div><div><small>Q3 · GBP</small><strong>1,800,000</strong></div><div><small>Q4 · JPY</small><strong>380,000,000</strong></div></div></div>`
    + finalAnswer(arm)
    + label('执行路径', '点击阶段跳转')
    + `<div class="flow">${arm.api_turns.map((turn, i) => `<button class="flow-stage" data-jump="turn-${turn.iteration}">◇ 第 ${turn.iteration} 轮 <small>${messageOf(turn).tool_calls?.length ? messageOf(turn).tool_calls.length + ' tools' : 'response'}</small></button>${i < arm.api_turns.length - 1 ? '<span class="flow-arrow">→</span>' : ''}`).join('')}</div>`
    + `<details><summary>验收与运行元数据</summary>${kv('上下文消融检查', arm.context_contract.passed ? '通过' : '未通过')}${kv('输入 / 输出 tokens', `${number(u.input)} / ${number(u.output)}`)}${kv('重复工具行动', `${arm.repeated_tool_calls} 次`)}${kv('API endpoint', arm.base_url)}${rawBlock(arm.context_contract)}</details>`;
}

function finalAnswer(arm) {
  const tone = OUTCOMES[arm.outcome]?.[1] || 'neutral';
  return label('最终结果', OUTCOMES[arm.outcome]?.[0] || '')
    + `<div class="answer ${tone}">${escape(arm.final_answer || '达到 5 轮迭代上限，没有生成最终回答。')}</div>`
    + (arm.outcome === 'unsupported_numbers' ? `<div class="grounding-numbers">无依据金额：${arm.groundedness.unsupported_quantities.map(x => '$' + number(x)).join(' · ')}</div><div class="modal-footnote">正确年度总额为 $9,602,895.73；季度平均为 $2,400,723.93。</div>` : '');
}

function renderMessage(message, index) {
  const empty = message.role === 'tool' && !message.content;
  const content = typeof message.content === 'string' ? message.content : message.content ? json(message.content) : '';
  return `<article class="message ${empty ? 'empty' : ''}"><div class="message-head"><span class="role">${escape(message.role)} <span class="muted">/ ${index + 1}</span></span><span class="mono">${message.tool_call_id ? escape(message.tool_call_id) : message.tool_calls?.length ? `${message.tool_calls.length} tool calls` : `${content.length} chars`}</span></div><div class="message-body">${empty ? '∅ 空字符串：这条消息存在，但没有任何工具观测。' : escape(content) || '<span class="muted">无文本内容</span>'}${message.tool_calls?.length ? `<details><summary>工具调用定义 (${message.tool_calls.length})</summary>${rawBlock(message.tool_calls)}</details>` : ''}${message.reasoning_content ? `<details><summary>已记录的 reasoning_content</summary>${rawBlock(message.reasoning_content)}</details>` : ''}</div></article>`;
}

function llmView() {
  const { node, tab, arm } = state;
  const { turn } = node;
  const message = messageOf(turn);
  const c = contextOf(turn);
  if (tab === 'input') return label('实际发出的上下文', 'REQUEST · 精确记录') + contextChips(turn)
    + (arm.mode === 'no_history' && turn.iteration > 1 ? '<div class="empty-note">此前的工具已在本地执行，但本轮请求只有 system 和 user。模型看不到之前的行动与结果。</div>' : '')
    + (arm.mode === 'no_tool_results' && c.empty ? `<div class="empty-note">本轮有 ${c.empty} 条工具消息，但 content 都为空。工具执行成功与观测可见是两回事。</div>` : '')
    + turn.request.messages.map(renderMessage).join('')
    + `<details><summary>本轮工具定义 (${c.tools})</summary>${rawBlock(turn.request.tools || [])}</details>`;
  if (tab === 'output') return label('模型返回文本', 'RESPONSE') + `<div class="answer neutral">${escape(message.content || '无文本内容，模型返回工具调用。')}</div>`
    + (node.calls.length ? label('请求执行的工具', `${node.calls.length} CALLS`) + node.calls.map(call => `<article class="message"><div class="message-head"><span class="mono">ƒ ${escape(call.function.name)}</span></div><div class="message-body">${rawBlock(parseArguments(call))}</div></article>`).join('') : '')
    + `<details><summary>已记录的模型推理字段（原始 reasoning_content）</summary>${message.reasoning_content ? rawBlock(message.reasoning_content) : '<div class="empty-state">该响应没有 reasoning_content。</div>'}</details>`;
  const u = turn.response.usage || {};
  return `<div class="summary-metrics">${metric('输入 tokens', number(u.prompt_tokens))}${metric('输出 tokens', number(u.completion_tokens))}${metric('上下文消息', c.messages)}${metric('工具调用', node.calls.length)}</div>`
    + label('模型此刻能看到什么') + contextChips(turn)
    + `<div class="task-card">${escape(turnInsight(node))}</div>`
    + label('本轮行动', node.calls.length ? 'TOOL CALLS' : 'TERMINAL RESPONSE')
    + (node.calls.length ? node.calls.map((call, index) => `<button class="flow-stage" data-jump="tool-${turn.iteration}-${index}" style="margin:0 7px 7px 0">ƒ ${escape(call.function.name)}<small>查看执行结果 ↗</small></button>`).join('') : `<div class="answer ${OUTCOMES[arm.outcome]?.[1]}">${escape(message.content || '空响应')}</div>`)
    + (message.content && node.calls.length ? `<details open><summary>模型回复文本</summary><div class="message-body">${escape(message.content)}</div></details>` : '')
    + `<details><summary>调用元数据</summary>${kv('Response ID', turn.response.id)}${kv('Finish reason', turn.response.choices?.[0]?.finish_reason)}${kv('缓存 tokens', number(u.prompt_tokens_details?.cached_tokens))}${kv('API endpoint', turn.base_url)}<p class="modal-footnote">证据未记录逐轮起止时间，因此不显示推测的单轮耗时。</p></details>`;
}

function turnInsight(node) {
  const c = contextOf(node.turn);
  switch (state.arm.mode) {
    case 'no_history': return node.turn.iteration === 1 ? '首次请求只包含系统提示词与任务。后续每轮也会重新发送同样的两条消息。' : `这是第 ${node.turn.iteration} 轮，但历史消息为 0：模型再次从任务起点选择行动。`;
    case 'no_tool_results': return c.empty ? `${c.empty} 条工具消息被置空。查看工具节点，可以对比本地真实结果与模型收到的空内容。` : '首次请求可以正常选择工具；工具执行后，观测会在后续请求中被置空。';
    case 'no_reasoning': return '历史工具调用与结果仍然保留；历史 reasoning_content 被剥离，模型在当前轮仍可产生新推理。';
    case 'no_tool_calls': return '请求没有提供工具定义。模型不能发起这些工具的调用，本次转而说明无法完成换汇。';
    default: return c.observations ? `本轮收到 ${c.observations} 条非空工具观测，可以接续已完成的行动。` : '首次请求提供系统提示词、任务和工具定义；模型接下来选择要执行的工具。';
  }
}

function toolView() {
  const { node, tab } = state;
  if (tab === 'input') return label('工具执行参数', node.name) + rawBlock(node.args);
  if (tab === 'output') return visibilityView(node);
  const canSee = !!node.sent?.content;
  return `<div class="context-grid"><div class="context-chip">本地执行<strong>${node.local?.result?.error ? '失败' : node.local ? '完成' : '未记录'}</strong></div><div class="context-chip ${!canSee ? 'missing' : ''}">下一轮模型可见<strong>${canSee ? '是' : '否'}</strong></div><div class="context-chip ${node.repeat ? 'missing' : ''}">相同参数重调<strong>${node.repeat ? '是' : '否'}</strong></div></div>`
    + label('输入参数', 'TOOL INPUT') + rawBlock(node.args) + visibilityView(node);
}

function visibilityView(node) {
  const nextExists = state.arm.api_turns.some(turn => turn.iteration > node.turn.iteration);
  let note = '';
  if (!node.sent) note = nextExists ? '下一轮请求没有携带这条工具消息，模型无法接续这个执行结果。' : '该工具执行后没有下一轮模型请求，证据中没有结果被回传给模型的记录。';
  else if (!node.sent.content) note = '本地有真实结果，但发给模型的 tool.content 是空字符串。';
  else note = '下面这条非空 tool 消息出现在下一轮请求中，模型能够读取结果。';
  return label('本地真实执行结果', 'LOCAL EXECUTION') + (node.local ? rawBlock(node.local.result) : '<div class="empty-note">未找到执行结果记录。</div>')
    + label('下一轮实际发送的工具消息', 'MODEL OBSERVATION')
    + `<div class="${node.sent?.content ? 'task-card' : 'empty-note'}">${note}</div>`
    + (node.sent ? rawBlock(node.sent) : '')
    + (node.local?.timestamp ? `<div class="modal-footnote">本地工具时间：${escape(node.local.timestamp.replace('T', ' '))}</div>` : '');
}

function currentRaw() {
  const { node, arm } = state;
  if (node.kind === 'root') return arm;
  if (node.kind === 'llm') return node.turn;
  return { tool_call: node.call, local_execution: node.local, sent_in_next_request: node.sent || null };
}
function rawView() { return label('原始记录', 'JSON · 不含认证头') + rawBlock(currentRaw()); }

function updateReplay() {
  const position = state.nodes.indexOf(state.node);
  $('#replay-position').textContent = `${String(position + 1).padStart(2, '0')} / ${String(state.nodes.length).padStart(2, '0')}`;
  $('#previous').disabled = position === 0;
  $('#next').disabled = position === state.nodes.length - 1;
}
function step(direction) {
  const index = Math.max(0, Math.min(state.nodes.length - 1, state.nodes.indexOf(state.node) + direction));
  selectNode(state.nodes[index].id, true);
}
function stopReplay() {
  clearInterval(state.timer);
  state.timer = null;
  $('#play').textContent = '▶ 自动回放';
}
function play() {
  if (state.timer) { stopReplay(); return; }
  if (state.nodes.indexOf(state.node) === state.nodes.length - 1) selectNode('root');
  state.query = ''; $('#search').value = ''; renderTree();
  $('#play').textContent = 'Ⅱ 暂停回放';
  state.timer = setInterval(() => {
    step(1);
    if (state.nodes.indexOf(state.node) === state.nodes.length - 1) stopReplay();
  }, 2000);
}

function modalHeader(title, subtitle) {
  return `<div class="modal-header"><div><h2>${title}</h2><p>${subtitle}</p></div><button class="icon-button" data-action="close" aria-label="关闭弹窗">×</button></div>`;
}
function showCompare() {
  stopReplay();
  const arms = state.evidence.arms;
  const max = Math.max(...arms.map(arm => usageOf(arm).input + usageOf(arm).output));
  $('#modal-content').innerHTML = modalHeader('五种上下文，同一个任务', '判断任务是否正确，也要判断模型的数字有没有观测依据。')
    + `<div class="modal-body"><table class="comparison-table"><thead><tr><th>实验组</th><th>结果</th><th>轮次</th><th>工具 / 重复</th><th>耗时</th><th>模型输入 / 输出</th></tr></thead><tbody>${arms.map(arm => { const u = usageOf(arm); return `<tr><td><button data-compare-mode="${arm.mode}">${MODES[arm.mode].name}<small>${MODES[arm.mode].en} ↗</small></button></td><td>${status(arm.outcome)}</td><td class="mono">${arm.iterations}</td><td class="mono">${arm.tool_calls.length} / ${arm.repeated_tool_calls}</td><td class="mono">${sec(arm.elapsed_seconds)}</td><td class="mono">${number(u.input)} / ${number(u.output)}</td></tr>`; }).join('')}</tbody></table>`
    + label('TOKEN 用量对比', '输入与输出合计；不代表费用')
    + `<div class="bar-chart">${arms.map(arm => { const u = usageOf(arm); const n = u.input + u.output; return `<div class="bar-row"><span>${MODES[arm.mode].name}</span><div class="bar-track"><div class="bar-fill ${OUTCOMES[arm.outcome]?.[1]}" style="width:${n / max * 100}%"></div></div><span class="mono">${number(n)}</span></div>`; }).join('')}</div>`
    + `<p class="modal-footnote">“移除历史推理”仅剥离历史 reasoning_content，模型仍可在新一轮推理，本次并未退化。<br>“未给出无依据数字”不等于完成任务。本次移除工具定义组说明了限制，未计算最终数值。<br>此页展示一次真实运行；不能从单次记录推断模型的稳定表现。</p></div>`;
  $('#modal').showModal();
}
function showTask() {
  stopReplay();
  $('#modal-content').innerHTML = modalHeader('任务与评分依据', '五组使用相同任务、相同模型与最多 5 轮的执行上限。')
    + `<div class="modal-body">${label('原始任务')}${rawBlock(state.evidence.task)}${label('预期数值')}<div class="task-card">年度总额：<strong>$9,602,895.73</strong><br>季度平均：<strong>$2,400,723.93</strong></div>${label('如何理解评分')}<div class="task-card">completed：循环收到终止文本，不代表答案正确。<br>task_success：最终回答是否包含预期的两个金额。<br>unsupported_numbers：最终回答出现任务与实际观测均未提供的营收金额。<br>context_contract：检查每轮真实请求是否符合该组消融设置。</div><p class="modal-footnote">本实验换汇使用仓库工具内置的示例汇率，并非实时市场报价。逐轮起止时间未被记录，因此界面仅展示真实的整组耗时与 Token 用量。</p>${label('运行验收')}${rawBlock(state.evidence.analysis.manuscript_behavior_claims)}</div>`;
  $('#modal').showModal();
}

async function handleAction(action) {
  if (action === 'compare') showCompare();
  if (action === 'task') showTask();
  if (action === 'close') $('#modal').close();
  if (action === 'traces') { $('#modal').close(); $('.workbench').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  if (action === 'download') {
    const url = URL.createObjectURL(new Blob([json(state.evidence)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'experiment-1-1-evidence.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); toast('实验记录已导出');
  }
  if (action === 'copy') {
    try { await navigator.clipboard.writeText(json(currentRaw())); toast('当前节点 JSON 已复制'); }
    catch { toast('浏览器未授权复制，请从原始 JSON 中手动选择'); }
  }
}

document.addEventListener('click', event => {
  const action = event.target.closest('[data-action]');
  if (action) { handleAction(action.dataset.action); return; }
  const card = event.target.closest('[data-mode]');
  if (card) { selectArm(card.dataset.mode); return; }
  const node = event.target.closest('[data-node], [data-jump]');
  if (node) { stopReplay(); selectNode(node.dataset.node || node.dataset.jump); return; }
  const tab = event.target.closest('[data-tab]');
  if (tab) { state.tab = tab.dataset.tab; renderDetail(); updateHash(); return; }
  const comparison = event.target.closest('[data-compare-mode]');
  if (comparison) { $('#modal').close(); selectArm(comparison.dataset.compareMode); }
});
$('#search').addEventListener('input', event => { state.query = event.target.value.trim().toLowerCase(); renderTree(); });
$('#previous').addEventListener('click', () => { stopReplay(); step(-1); });
$('#next').addEventListener('click', () => { stopReplay(); step(1); });
$('#play').addEventListener('click', play);
document.addEventListener('keydown', event => {
  if (!state.evidence || $('#modal').open || ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); stopReplay(); step(event.key === 'ArrowLeft' ? -1 : 1); }
  if (event.key === '/') { event.preventDefault(); $('#search').focus(); }
});
$('#modal').addEventListener('click', event => { if (event.target === $('#modal')) $('#modal').close(); });
window.addEventListener('hashchange', restoreHash);
function restoreHash() {
  const [mode, id, tab] = location.hash.slice(1).split('/');
  if (['overview', 'input', 'output', 'raw'].includes(tab)) state.tab = tab;
  selectArm(mode, id);
}

try {
  const response = await fetch('/api/evidence');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  state.evidence = await response.json();
  if (state.evidence.experiment_id !== '1-1' || !state.evidence.arms?.length) throw new Error('证据文件不是实验 1-1 的运行记录');
  const { evidence } = state;
  const elapsed = evidence.arms.reduce((sum, arm) => sum + arm.elapsed_seconds, 0);
  $('#run-info').innerHTML = `<span><span class="live-dot"></span>真实 API 运行</span><span class="info-divider"></span><span>模型 <strong class="mono">${escape(evidence.arms[0].model)}</strong></span><span>来源 <strong>公司 New API</strong></span><span>${formatDate(evidence.arms[0].started_at)} <span class="muted">UTC+8</span></span><span>总耗时 <strong class="mono">${sec(elapsed)}</strong></span><span><strong class="mono">${number(evidence.analysis.usage.total_tokens)}</strong> tokens</span>`;
  restoreHash();
} catch (error) {
  $('.page').innerHTML = `<div class="fatal"><h1>未能加载实验记录</h1><p>${escape(error.message)}</p><p>请用 trace_viewer.py 启动本地服务，并检查 --evidence 指向正确的 evidence.json。</p></div>`;
}

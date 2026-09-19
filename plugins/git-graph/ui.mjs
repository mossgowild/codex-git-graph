import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';
import { layout, colors } from './graph.mjs';
import { columns, maxColumnWidth, widthsSchema } from './column-layout.mjs';

const $ = id => document.getElementById(id);
const app = new App({ name: 'Git Graph', version: '0.2.1' });
const state = { repo: '', branch: '', historyNotice: '', parent: 0, commits: [], refs: [], tips: [], selected: '', detail: null, file: '', matches: [], match: -1,
  hasMore: false, historyVersion: 0, detailVersion: 0, diffVersion: 0, connected: false, loading: false };
let retry = null;
let columnWidths = {}, graphWidth = 20, layoutReady = false, layoutRetry = null;
let saveQueue = Promise.resolve(), saveVersion = 0;

function applyColumnWidths() {
  let minimum = 20 + (columns.length - 1) * 8;
  for (const column of columns) {
    let width = columnWidths[column.id];
    if (column.id === 'graph') width = Math.max(graphWidth, width || 0);
    minimum += width ?? column.initial;
    if (width == null) $('history-pane').style.removeProperty(`--${column.id}-width`);
    else $('history-pane').style.setProperty(`--${column.id}-width`, `${width}px`);
  }
  $('history-pane').style.setProperty('--table-min-width', `${minimum}px`);
}
function layoutError(message, action) {
  $('layout-error').hidden = false;
  $('layout-error').querySelector('span').textContent = message;
  layoutRetry = action;
}
async function loadColumnWidths() {
  try {
    const result = await call('git_graph_layout', {});
    columnWidths = widthsSchema.parse(result.widths);
    layoutReady = true;
    applyColumnWidths();
    $('layout-error').hidden = true;
    updateResizeHandles();
  } catch (e) { layoutError(`无法读取已保存的布局。${e.message}`, loadColumnWidths); }
}
function saveColumnWidths() {
  const widths = { ...columnWidths }, version = ++saveVersion;
  saveQueue = saveQueue.then(async () => {
    try {
      await call('git_graph_save_layout', { widths });
      if (version === saveVersion) $('layout-error').hidden = true;
    } catch (e) {
      if (version === saveVersion) layoutError(`列宽尚未保存。${e.message}`, saveColumnWidths);
    }
  });
  return saveQueue;
}
function columnMinimum(column) { return column.id === 'graph' ? Math.max(column.min, graphWidth) : column.min; }
function updateResizeHandles() {
  for (const [index, column] of columns.entries()) {
    const cell = $('columns').children[index], handle = cell.querySelector('.column-resize');
    handle.setAttribute('aria-valuenow', Math.round(cell.getBoundingClientRect().width));
    handle.setAttribute('aria-valuemin', columnMinimum(column));
    handle.setAttribute('aria-valuemax', Math.max(maxColumnWidth, columnMinimum(column)));
    handle.setAttribute('aria-disabled', String(!layoutReady));
    handle.tabIndex = layoutReady ? 0 : -1;
  }
}
for (const [index, column] of columns.entries()) {
  const cell = $('columns').children[index], handle = node('span', null, 'column-resize');
  handle.role = 'separator'; handle.dataset.column = column.id;
  handle.setAttribute('aria-label', `调整${column.label}列宽`);
  handle.setAttribute('aria-orientation', 'vertical');
  handle.title = '拖动调整列宽；双击恢复自动宽度；方向键微调';
  cell.append(handle);
  const resize = width => {
    if (column.id !== 'message' && columnWidths.message == null) {
      columnWidths.message = Math.round($('columns').children[1].getBoundingClientRect().width);
    }
    columnWidths[column.id] = Math.min(maxColumnWidth, Math.max(columnMinimum(column), Math.round(width)));
    applyColumnWidths(); updateResizeHandles();
  };
  const reset = () => { delete columnWidths[column.id]; applyColumnWidths(); updateResizeHandles(); saveColumnWidths(); };
  let drag = null;
  handle.addEventListener('pointerdown', event => {
    if (!layoutReady || event.button !== 0 || drag) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    drag = { pointer: event.pointerId, x: event.clientX, scroll: $('history-scroll').scrollLeft,
      width: cell.getBoundingClientRect().width, previous: { ...columnWidths } };
    handle.setPointerCapture(event.pointerId);
    handle.dataset.active = ''; document.documentElement.classList.add('resizing');
  });
  handle.addEventListener('pointermove', event => {
    if (drag?.pointer === event.pointerId) resize(drag.width + event.clientX - drag.x + $('history-scroll').scrollLeft - drag.scroll);
  });
  const finish = cancelled => {
    if (!drag) return;
    const previous = drag.previous; drag = null;
    delete handle.dataset.active; document.documentElement.classList.remove('resizing');
    if (cancelled) {
      columnWidths = previous;
      applyColumnWidths(); updateResizeHandles();
    } else if (columns.some(({ id }) => previous[id] !== columnWidths[id])) saveColumnWidths();
  };
  handle.addEventListener('pointerup', () => finish(false));
  handle.addEventListener('pointercancel', () => finish(true));
  handle.addEventListener('lostpointercapture', () => finish(true));
  handle.addEventListener('dblclick', () => { if (layoutReady) reset(); });
  handle.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopPropagation(); finish(true); return; }
    if (!layoutReady || drag) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      resize(cell.getBoundingClientRect().width + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 1 : 8));
      saveColumnWidths();
    } else if (event.key === 'Home') { event.preventDefault(); reset(); }
  });
}
const columnsObserver = new ResizeObserver(updateResizeHandles);
for (const cell of $('columns').children) columnsObserver.observe(cell);
updateResizeHandles();
$('layout-retry').addEventListener('click', () => layoutRetry?.());

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function error(message, action) {
  $('error').hidden = false;
  $('error').querySelector('span').textContent = message;
  retry = action;
  $('retry').hidden = !action;
}
async function call(name, args) {
  if (!state.connected) throw new Error('尚未连接到 Codex，请重新打开 Git Graph 窗口。');
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || 'Git 查询失败。');
  if (!result.structuredContent) throw new Error('Git Graph 返回了无效的数据。');
  return result.structuredContent;
}
function theme(context) {
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context['openai/interactionCursor']) document.documentElement.style.setProperty('--interaction-cursor', context['openai/interactionCursor']);
}
function refsLabel(ref) { return ref.name.replace(/^refs\/(heads|remotes|tags)\//, ''); }
function refDisplayName(ref) {
  const label = refsLabel(ref);
  if (state.refCounts.get(label) < 2) return label;
  const kind = ref.name.startsWith('refs/heads/') ? '本地' : ref.name.startsWith('refs/remotes/') ? '远程' : '标签';
  return `${kind} · ${label}`;
}
function refBadge(ref) {
  const label = node('span', refDisplayName(ref), `ref${ref.name.startsWith('refs/tags/') ? ' tag' : ''}`);
  label.title = ref.name;
  return label;
}
function renderCommitRefs() {
  const refs = state.refs.filter(ref => ref.hash === state.selected);
  $('commit-refs').replaceChildren(...(refs.length
    ? [node('span', '指向此提交：'), ...refs.map(refBadge)]
    : [node('span', '无分支或标签直接指向此提交')]));
}

function acceptHistory(data, append = false, notice = '') {
  state.repo = data.repo;
  state.commits = append ? [...state.commits, ...data.commits] : data.commits;
  state.refs = data.refs;
  state.branch = data.branch;
  state.historyNotice = data.missingBranch ? `所选分支或标签“${refsLabel({ name: data.missingBranch })}”已不存在，已显示所有分支与标签` : notice;
  state.refCounts = new Map();
  for (const ref of state.refs) {
    const label = refsLabel(ref);
    state.refCounts.set(label, (state.refCounts.get(label) || 0) + 1);
  }
  state.tips = data.tips;
  state.hasMore = data.hasMore;
  state.head = data.head;
  state.headName = data.headName;
  $('repo-label').textContent = data.repo.split('/').at(-1);
  $('repo-label').title = data.repo;
  $('toolbar').hidden = false;
  $('searchbar').hidden = false;
  $('columns').hidden = !state.commits.length;
  $('branch').replaceChildren(new Option('所有分支与标签', ''));
  const groups = [['本地分支', 'refs/heads/'], ['远程分支', 'refs/remotes/'], ['标签', 'refs/tags/']];
  for (const [label, prefix] of groups) {
    const refs = data.refs.filter(ref => ref.name.startsWith(prefix));
    if (!refs.length) continue;
    const group = node('optgroup'); group.label = label; group.append(node('legend', label));
    for (const ref of refs) group.append(new Option(refDisplayName(ref), ref.name));
    $('branch').append(group);
  }
  $('branch').value = state.branch;
  renderHistory();
  if (state.selected && !state.commits.some(commit => commit.hash === state.selected)) closeDetail();
}

async function loadHistory(append = false, branch = $('branch').value) {
  if (append && (state.loading || !state.hasMore)) return;
  const version = ++state.historyVersion;
  const switching = branch !== state.branch;
  if (switching) closeDetail();
  state.loading = true;
  $('branch').value = branch;
  $('history-table').hidden = switching;
  $('searchbar').inert = switching;
  $('empty').hidden = true;
  $('history-status').textContent = '正在读取提交历史…';
  $('load-more').disabled = true;
  $('error').hidden = true;
  try {
    const args = { branch };
    if (append) { args.offset = state.commits.length; args.tips = state.tips; }
    let result = await call('git_graph_history', args);
    if (version !== state.historyVersion) return;
    let notice = '';
    if (append && !result.missingBranch && (result.head !== state.head || result.headName !== state.headName
      || JSON.stringify(result.refs) !== JSON.stringify(state.refs))) {
      result = await call('git_graph_history', { branch });
      if (version !== state.historyVersion) return;
      append = false;
      notice = '仓库引用已更新，已重新加载';
    }
    if (result.missingBranch) append = false;
    acceptHistory(result, append, notice);
    if (!append) $('history-scroll').scrollTop = 0;
    if (state.selected && !append && !$('detail').hidden) selectCommit(state.selected, state.parent, false, state.file);
  } catch (e) {
    if (version !== state.historyVersion) return;
    $('branch').value = state.branch;
    $('empty').hidden = state.commits.length > 0;
    $('history-status').textContent = '读取失败';
    error(e.message, () => loadHistory(append, branch));
  } finally {
    if (version === state.historyVersion) {
      state.loading = false; $('load-more').disabled = false; $('history-table').hidden = false; $('searchbar').inert = false;
    }
  }
}

function graphSvg(row, width) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', width); svg.setAttribute('height', '28'); svg.setAttribute('aria-hidden', 'true');
  const x = lane => lane * 18 + 10;
  for (const line of row.lines) {
    const path = document.createElementNS(ns, 'path');
    const from = x(line.from), to = x(line.to);
    let d = `M${from} 0V28`;
    if (line.kind === 'incoming') d = `M${from} 0V14`;
    if (line.kind === 'parent') d = from === to ? `M${from} 14V28` : `M${from} 14C${from} 23 ${to} 20 ${to} 28`;
    path.setAttribute('d', d); path.setAttribute('fill', 'none'); path.setAttribute('stroke', colors[line.color]);
    path.setAttribute('stroke-width', '1.6'); svg.append(path);
  }
  const dot = document.createElementNS(ns, 'circle');
  dot.setAttribute('cx', x(row.column)); dot.setAttribute('cy', 14); dot.setAttribute('r', row.parents.length > 1 ? 3.5 : 2.8);
  dot.setAttribute('stroke', colors[row.color]); dot.setAttribute('stroke-width', '1.8');
  dot.setAttribute('fill', row.parents.length > 1 ? 'var(--bg)' : colors[row.color]); svg.append(dot);
  return svg;
}
function renderHistory() {
  const graph = layout(state.commits);
  const width = graph.width * 18 + 2;
  graphWidth = width;
  applyColumnWidths();
  const refs = new Map();
  for (const ref of state.refs) { if (!refs.has(ref.hash)) refs.set(ref.hash, []); refs.get(ref.hash).push(ref); }
  const fragment = document.createDocumentFragment();
  for (const row of graph.rows) {
    const button = node('button', null, 'commit-row');
    button.role = 'option'; button.dataset.hash = row.hash;
    button.setAttribute('aria-selected', row.hash === state.selected ? 'true' : 'false');
    button.setAttribute('aria-label', `${row.subject}，${row.author}，${row.hash.slice(0, 8)}`);
    button.tabIndex = row.hash === state.selected || (!state.selected && fragment.childNodes.length === 0) ? 0 : -1;
    button.append(graphSvg(row, width));
    const message = node('span', null, 'message');
    if (row.hash === state.head) message.append(node('span', 'HEAD', 'ref head'));
    message.append(...(refs.get(row.hash) || []).map(refBadge));
    const subject = node('span', row.subject || '（无提交标题）', 'subject'); subject.title = row.subject;
    message.append(subject);
    const author = node('span', row.author, 'author'); author.title = `${row.author} <${row.email}>`;
    const date = node('span', new Date(row.date).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }), 'date');
    date.title = new Date(row.date).toLocaleString('zh-CN');
    const hash = node('span', row.hash.slice(0, 7), 'hash'); hash.title = row.hash;
    button.append(message, author, date, hash); fragment.append(button);
  }
  $('rows').replaceChildren(fragment);
  $('empty').hidden = state.commits.length > 0;
  if (!state.commits.length) $('empty').replaceChildren(node('strong', '这个仓库还没有提交'), node('span', '创建提交后点击刷新。'));
  $('load-more').hidden = !state.hasMore;
  $('history-status').textContent = `${state.commits.length} 条提交${state.hasMore ? ' · 可继续加载' : ' · 已加载全部'}${state.headName ? ` · 当前检出分支：${state.headName}` : state.head ? ` · 当前检出：分离的 HEAD（${state.head.slice(0, 7)}）` : ''}${state.historyNotice ? ` · ${state.historyNotice}` : ''}`;
  if (state.selected) renderCommitRefs();
  updateSearch();
}
function updateSearch() {
  const query = $('search').value.trim().toLocaleLowerCase();
  // ponytail: search covers loaded commits; load further pages to extend its scope without hiding graph ancestry.
  state.matches = query ? state.commits.filter(commit => [commit.hash, commit.author, commit.email, commit.subject,
    ...state.refs.filter(ref => ref.hash === commit.hash).map(refsLabel)].some(text => text.toLocaleLowerCase().includes(query))).map(commit => commit.hash) : [];
  state.match = state.matches.indexOf(state.selected);
  for (const row of $('rows').children) row.classList.toggle('is-match', state.matches.includes(row.dataset.hash));
  $('search-count').textContent = query ? `${state.match < 0 ? 0 : state.match + 1}/${state.matches.length} · 已加载历史` : '';
  $('prev-match').disabled = $('next-match').disabled = !state.matches.length;
}
function stepMatch(direction) {
  if (!state.matches.length) return;
  const index = state.match < 0 ? (direction > 0 ? 0 : state.matches.length - 1)
    : (state.match + direction + state.matches.length) % state.matches.length;
  selectCommit(state.matches[index], 0, true);
}
function closeDetail(resetSelection = true) {
  ++state.detailVersion; ++state.diffVersion;
  if (resetSelection) state.selected = '';
  state.detail = null; state.file = '';
  $('detail').hidden = true;
  for (const row of $('rows').children) {
    const selected = row.dataset.hash === state.selected;
    row.setAttribute('aria-selected', String(selected)); row.tabIndex = selected ? 0 : -1;
    if (selected) row.focus({ preventScroll: true });
  }
  if (!state.selected && $('rows').firstElementChild) $('rows').firstElementChild.tabIndex = 0;
  updateSearch();
}
async function selectCommit(hash, parent = 0, focus = false, file = '') {
  const version = ++state.detailVersion; ++state.diffVersion;
  $('error').hidden = true;
  state.selected = hash; state.parent = parent; state.detail = null; state.file = file;
  for (const row of $('rows').children) {
    const selected = row.dataset.hash === hash;
    row.setAttribute('aria-selected', String(selected)); row.tabIndex = selected ? 0 : -1;
    if (selected && focus) { row.scrollIntoView({ block: 'nearest' }); row.focus({ preventScroll: true }); }
  }
  updateSearch();
  $('detail').hidden = false; $('detail-hash').textContent = hash.slice(0, 12);
  renderCommitRefs();
  $('commit-message').textContent = '正在读取提交…'; $('commit-meta').textContent = '';
  $('files').replaceChildren(); $('patch').replaceChildren(); $('parent-label').hidden = true;
  $('open-file').disabled = true;
  $('diff-title').textContent = '选择文件查看差异'; $('files-label').textContent = '变更文件';
  try {
    const detail = await call('git_graph_commit', { hash, parent });
    if (version !== state.detailVersion) return;
    state.detail = detail;
    $('commit-message').textContent = detail.message || '（无提交说明）';
    $('commit-meta').replaceChildren(node('div', `${detail.author} <${detail.email}>`), node('div', new Date(detail.date).toLocaleString('zh-CN')));
    $('parent-label').hidden = detail.parents.length < 2;
    $('parent').replaceChildren(...detail.parents.map((hash, i) => new Option(`${i + 1} · ${hash.slice(0, 12)}`, i)));
    $('parent').value = String(parent);
    $('files-label').textContent = `变更文件 · ${detail.files.length}${detail.parents.length > 1 ? ` · 相对父提交 ${parent + 1}` : ''}`;
    for (const file of detail.files) {
      const button = node('button'); button.dataset.path = file.path; button.setAttribute('aria-pressed', 'false');
      button.title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
      button.setAttribute('aria-label', `${file.status[0]} ${button.title}`);
      const slash = file.path.lastIndexOf('/');
      button.append(node('span', file.path.slice(slash + 1), 'file-path'));
      if (slash !== -1) button.append(node('span', file.path.slice(0, slash), 'file-directory'));
      button.append(node('span', file.status[0], `file-status ${file.status[0]}`)); $('files').append(button);
    }
    if (detail.files.length) await selectFile(detail.files.some(item => item.path === file) ? file : detail.files[0].path);
    else $('patch').append(node('span', '相对所选父提交没有文件变更。', 'notice'));
  } catch (e) {
    if (version !== state.detailVersion) return;
    $('commit-message').textContent = '提交读取失败'; error(e.message, () => selectCommit(hash, parent, false, file));
  }
}
async function selectFile(path) {
  const detail = state.detail;
  if (!detail) return;
  const version = ++state.diffVersion;
  $('error').hidden = true;
  state.file = path;
  $('open-file').disabled = false;
  for (const button of $('files').children) button.setAttribute('aria-pressed', String(button.dataset.path === path));
  $('diff-title').textContent = path;
  $('diff-title').title = path;
  $('patch').replaceChildren(node('span', '正在读取差异…', 'notice'));
  try {
    const result = await call('git_graph_diff', { hash: detail.hash, parent: detail.parent, path });
    if (version !== state.diffVersion) return;
    const fragment = document.createDocumentFragment();
    let inHunk = false;
    for (const text of result.patch.split('\n')) {
      if (text.startsWith('diff ')) inHunk = false;
      let type = '';
      if (text.startsWith('@@')) { inHunk = true; type = 'hunk'; }
      else if (inHunk) type = text.startsWith('+') ? 'add' : text.startsWith('-') ? 'remove' : '';
      else if (/^(diff |index |---|\+\+\+|rename |similarity |new file|deleted file|Binary)/.test(text)) type = 'header';
      fragment.append(node('span', text || ' ', `line ${type}`));
    }
    $('patch').replaceChildren(fragment); $('patch').scrollTop = 0; $('patch').scrollLeft = 0;
  } catch (e) {
    if (version !== state.diffVersion) return;
    $('patch').replaceChildren(node('span', '差异读取失败。', 'notice')); error(e.message, () => selectFile(path));
  }
}

async function openWorkspaceFile() {
  const detail = state.detail, file = state.file, version = state.diffVersion;
  if (!detail || !file) return;
  $('open-file').disabled = true;
  try {
    const { path } = await call('git_graph_workspace_file', { hash: detail.hash, parent: detail.parent, path: file });
    if (version !== state.diffVersion) return;
    const result = await app.request({ method: 'openai/files/open', params: { path } }, z.object({ isError: z.boolean().optional() }).passthrough());
    if (result.isError) throw new Error('Codex 未能打开工作区文件。');
  } catch (e) {
    if (version === state.diffVersion) error(e.message, openWorkspaceFile);
  } finally {
    if (version === state.diffVersion) $('open-file').disabled = false;
  }
}

$('branch').addEventListener('change', () => loadHistory());
$('refresh').addEventListener('click', () => loadHistory());
$('load-more').addEventListener('click', () => { if (!state.loading) loadHistory(true); });
$('search').addEventListener('input', updateSearch);
$('search').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); stepMatch(event.shiftKey ? -1 : 1); } });
$('prev-match').addEventListener('click', () => stepMatch(-1));
$('next-match').addEventListener('click', () => stepMatch(1));
$('rows').addEventListener('click', event => { const row = event.target.closest('.commit-row'); if (row) selectCommit(row.dataset.hash); });
$('rows').addEventListener('keydown', event => {
  const row = event.target.closest('.commit-row'); if (!row) return;
  let target = null;
  if (event.key === 'ArrowDown') target = row.nextElementSibling;
  if (event.key === 'ArrowUp') target = row.previousElementSibling;
  if (event.key === 'Home') target = $('rows').firstElementChild;
  if (event.key === 'End') target = $('rows').lastElementChild;
  if (target) { event.preventDefault(); selectCommit(target.dataset.hash, 0, true); }
});
$('files').addEventListener('click', event => { const button = event.target.closest('button'); if (button) selectFile(button.dataset.path); });
$('parent').addEventListener('change', () => selectCommit(state.selected, Number($('parent').value)));
$('close-detail').addEventListener('click', () => closeDetail(false));
$('open-file').addEventListener('click', openWorkspaceFile);
$('files').addEventListener('keydown', event => {
  const button = event.target.closest('button');
  if (!button) return;
  const target = event.key === 'ArrowDown' ? button.nextElementSibling : event.key === 'ArrowUp' ? button.previousElementSibling : null;
  if (target) { event.preventDefault(); target.focus(); selectFile(target.dataset.path); }
});
$('copy-hash').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(state.selected); $('copy-hash').textContent = '已复制'; setTimeout(() => $('copy-hash').textContent = '复制', 1200); }
  catch { error(`当前窗口不允许访问剪贴板。完整 SHA：${state.selected}`, null); }
});
$('dismiss-error').addEventListener('click', () => { $('error').hidden = true; });
$('retry').addEventListener('click', () => { $('error').hidden = true; retry?.(); });
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && state.repo) { event.preventDefault(); $('search').focus(); }
  if (event.key === 'Escape' && !$('detail').hidden && !document.activeElement.closest('input, select')) closeDetail(false);
});

app.onhostcontextchanged = theme;
app.ontoolresult = result => {
  if (result.isError) { error(result.content?.find(item => item.type === 'text')?.text || '打开失败', null); return; }
  const data = result.structuredContent;
  if (data?.repo && data.commits) {
    ++state.historyVersion; closeDetail(); acceptHistory(data);
    state.loading = false; $('load-more').disabled = false; $('history-table').hidden = false; $('searchbar').inert = false;
  } else if (data?.contextCwd) {
    ++state.historyVersion; closeDetail();
    state.repo = ''; state.branch = ''; state.historyNotice = ''; state.commits = []; state.refs = []; state.tips = []; state.hasMore = false;
    $('rows').replaceChildren(); $('toolbar').hidden = true; $('searchbar').hidden = true; $('columns').hidden = true;
    $('load-more').hidden = true;
    $('repo-label').textContent = ''; $('repo-label').title = data.contextCwd;
    $('empty').hidden = false;
    $('empty').replaceChildren(node('strong', '当前任务目录不属于 Git 仓库'), node('span', data.contextCwd));
    $('history-status').textContent = '当前任务没有可显示的 Git 历史';
  }
};
app.onteardown = async () => {
  ++state.historyVersion; ++state.detailVersion; ++state.diffVersion;
  columnsObserver.disconnect(); await saveQueue; return {};
};
app.connect().then(() => {
  state.connected = true; theme(app.getHostContext() || {});
  $('open-file').hidden = !app.getHostCapabilities()?.experimental?.['openai/files'];
  loadColumnWidths();
}).catch(e => {
  $('history-status').textContent = '连接失败'; error(e.message, null);
});

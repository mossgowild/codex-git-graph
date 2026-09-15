import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rename, rm, copyFile, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { git, history, commit, diff, repository, workspaceFile } from './git.mjs';
import { layout } from './graph.mjs';

function checkGraph(commits) {
  const graph = layout(commits);
  for (const [index, row] of graph.rows.entries()) {
    const edges = row.lines.filter(line => line.kind === 'parent');
    assert.equal(edges.length, row.parents.length);
    for (const [edgeIndex, edge] of edges.entries()) {
      const parent = row.parents[edgeIndex];
      const destination = graph.rows.findIndex(row => row.hash === parent);
      const end = destination === -1 ? graph.rows.length : destination;
      assert.ok(destination === -1 || destination > index, 'topological order');
      for (let next = index + 1; next < end; next++) {
        assert.ok(graph.rows[next].lines.some(line => line.kind === 'through' && line.from === edge.to),
          `edge ${row.hash} -> ${parent} must continue through row ${next}`);
      }
      if (destination !== -1) assert.equal(graph.rows[destination].column, edge.to, 'edge must reach the real parent');
    }
  }
}

test('real Git history, merge parents, renames, paths, pagination, read-only state and MCP window contract', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'git graph 测试-'));
  const worktree = `${repo}-linked`;
  const noGit = await mkdtemp(join(tmpdir(), 'git graph empty-'));
  const client = new Client({ name: 'git-graph-test', version: '1.0.0' });
  const linkedClient = new Client({ name: 'git-graph-linked-test', version: '1.0.0' });
  const emptyClient = new Client({ name: 'git-graph-empty-test', version: '1.0.0' });
  try {
    await git(repo, ['init', '-b', 'main']);
    await git(repo, ['config', 'user.name', 'Graph Test']);
    await git(repo, ['config', 'user.email', 'graph@example.invalid']);
    assert.equal((await history({ repoPath: repo })).commits.length, 0);
    await writeFile(join(repo, 'alpha.txt'), 'one\ntwo\nthree\n');
    await git(repo, ['add', '--', 'alpha.txt']); await git(repo, ['commit', '-m', 'Initial commit']);
    const root = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', '-b', 'feature']);
    await writeFile(join(repo, 'feature.txt'), 'feature\n');
    await git(repo, ['add', '--', 'feature.txt']); await git(repo, ['commit', '-m', '<img src=x onerror=alert(1)> feature']);
    const feature = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', 'main']);
    await writeFile(join(repo, 'alpha.txt'), 'one\ntwo changed\nthree\n');
    await git(repo, ['add', '--', 'alpha.txt']); await git(repo, ['commit', '-m', 'Update alpha']);
    await git(repo, ['merge', '--no-ff', 'feature', '-m', 'Merge feature']);
    const merge = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    const strange = 'renamed\t中文\nfile.txt';
    await rename(join(repo, 'alpha.txt'), join(repo, strange));
    await git(repo, ['add', '-A']); await git(repo, ['commit', '-m', 'Rename alpha']);
    await git(repo, ['tag', '-a', 'v1.0', '-m', 'version one']);
    const latest = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await writeFile(join(repo, 'untracked.txt'), 'do not touch');
    const before = await git(repo, ['status', '--porcelain=v1', '-z']);
    const indexBefore = await readFile(join(repo, '.git/index'));
    const logBefore = await readFile(join(repo, '.git/logs/HEAD'));
    const all = await history({ repoPath: repo });
    assert.equal(all.commits.length, 5);
    assert.equal(all.head, latest);
    assert.equal(all.refs.find(ref => ref.name === 'refs/tags/v1.0').hash, latest);
    checkGraph(all.commits);
    const first = await history({ repoPath: repo, limit: 2 });
    assert.equal(first.hasMore, true);
    const next = await history({ repoPath: repo, limit: 3, offset: 2, tips: first.tips });
    assert.deepEqual([...first.commits, ...next.commits].map(c => c.hash), all.commits.map(c => c.hash));
    checkGraph(first.commits);
    const branch = await history({ repoPath: repo, branch: 'refs/heads/feature' });
    assert.deepEqual(branch.commits.map(c => c.hash), [feature, root]);
    const detail = await commit({ repoPath: repo, hash: merge });
    assert.equal(detail.parents.length, 2);
    assert.deepEqual(detail.files.map(file => file.path), ['feature.txt']);
    assert.deepEqual((await commit({ repoPath: repo, hash: merge, parent: 1 })).files.map(file => file.path), ['alpha.txt']);
    const renamed = await commit({ repoPath: repo, hash: latest });
    assert.deepEqual(renamed.files, [{ status: 'R100', oldPath: 'alpha.txt', path: strange }]);
    assert.match((await diff({ repoPath: repo, hash: latest, path: strange })).patch, /rename from/);
    assert.match((await diff({ repoPath: repo, hash: root, path: 'alpha.txt' })).patch, /\+one/);
    assert.equal((await workspaceFile({ repoPath: repo, hash: latest, path: strange })).path, await realpath(join(repo, strange)));
    await assert.rejects(workspaceFile({ repoPath: repo, hash: root, path: 'alpha.txt' }), /已没有/);
    await assert.rejects(workspaceFile({ repoPath: repo, hash: latest, path: '../outside' }), /不在/);
    await assert.rejects(diff({ repoPath: repo, hash: root, path: '../../etc/passwd' }), /不在/);
    await assert.rejects(commit({ repoPath: repo, hash: '--output=x' }), /无效/);
    await assert.rejects(commit({ repoPath: repo, hash: root, parent: 1 }), /无效/);
    await assert.rejects(repository('relative/path'), /绝对路径/);
    assert.equal(await git(repo, ['status', '--porcelain=v1', '-z']), before);
    assert.deepEqual(await readFile(join(repo, '.git/index')), indexBefore);
    assert.deepEqual(await readFile(join(repo, '.git/logs/HEAD')), logBefore);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, 'dist/server.mjs')], cwd: repo }));
    const tools = await client.listTools();
    const tool = tools.tools.find(tool => tool.name === 'git_graph');
    assert.deepEqual(tool._meta['openai/ui'].entrypoints, [{ type: 'thread' }]);
    assert.equal(tool.annotations.readOnlyHint, true);
    const opened = await client.callTool({ name: 'git_graph', arguments: {} });
    assert.equal(opened.isError, undefined);
    assert.equal(opened.structuredContent.commits.length, 5);
    const current = await client.callTool({ name: 'git_graph', arguments: {} });
    assert.equal(current.structuredContent.repo, await repository(repo));
    assert.equal(current.structuredContent.commits[0].hash, latest);
    assert.equal((await client.callTool({ name: 'git_graph_history', arguments: {} })).structuredContent.head, latest);
    assert.equal((await client.callTool({ name: 'git_graph_commit', arguments: { hash: merge } })).structuredContent.parents.length, 2);
    assert.match((await client.callTool({ name: 'git_graph_diff', arguments: { hash: root, path: 'alpha.txt' } })).structuredContent.patch, /\+one/);
    assert.equal((await client.callTool({ name: 'git_graph_workspace_file', arguments: { hash: latest, path: strange } })).structuredContent.path, await realpath(join(repo, strange)));
    for (const name of ['git_graph', 'git_graph_history', 'git_graph_commit', 'git_graph_diff', 'git_graph_workspace_file']) {
      const changed = await client.callTool({ name, arguments: { repoPath: noGit, ...(['git_graph_commit', 'git_graph_diff', 'git_graph_workspace_file'].includes(name) ? { hash: root } : {}), ...(['git_graph_diff', 'git_graph_workspace_file'].includes(name) ? { path: 'alpha.txt' } : {}) } });
      assert.equal(changed.isError, true, 'the task repository cannot be overridden');
    }
    const resource = await client.readResource({ uri: tool._meta.ui.resourceUri });
    assert.match(resource.contents[0].text, /Git Graph/);
    assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
    const denied = await client.callTool({ name: 'git_graph_diff', arguments: { hash: root, path: '../outside' } });
    assert.equal(denied.isError, true);
    await writeFile(join(noGit, 'external.txt'), 'outside repository');
    await rename(join(repo, strange), join(repo, 'saved.txt'));
    await symlink(join(noGit, 'external.txt'), join(repo, strange));
    await assert.rejects(workspaceFile({ repoPath: repo, hash: latest, path: strange }), /仓库之外/);
    await rm(join(repo, strange)); await rename(join(repo, 'saved.txt'), join(repo, strange));
    await git(repo, ['worktree', 'add', '--detach', worktree, feature]);
    await linkedClient.connect(new StdioClientTransport({ command: process.execPath,
      args: [join(import.meta.dirname, 'dist/server.mjs')], cwd: worktree }));
    const linked = await linkedClient.callTool({ name: 'git_graph', arguments: {} });
    assert.equal(linked.structuredContent.repo, await repository(worktree));
    assert.equal(linked.structuredContent.head, feature);
    assert.equal((await client.callTool({ name: 'git_graph', arguments: {} })).structuredContent.head, latest);
    await emptyClient.connect(new StdioClientTransport({ command: process.execPath,
      args: [join(import.meta.dirname, 'dist/server.mjs')], cwd: noGit }));
    const empty = await emptyClient.callTool({ name: 'git_graph', arguments: {} });
    assert.equal(empty.isError, undefined);
    assert.equal(empty.structuredContent.repo, null);
    assert.ok(empty.structuredContent.contextCwd.endsWith(noGit.split('/').at(-1)));
  } finally {
    await client.close();
    await linkedClient.close(); await emptyClient.close();
    await rm(worktree, { recursive: true, force: true });
    await rm(noGit, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test('graph edges preserve ancestry across multi-parent DAGs and partial histories', () => {
  let seed = 49213;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let run = 0; run < 30; run++) {
    const commits = Array.from({ length: 80 }, (_, i) => ({ hash: String(i), parents: i === 79 ? [] :
      [...new Set(Array.from({ length: 1 + Math.floor(random() * 3) }, () => String(i + 1 + Math.floor(random() * (79 - i)))))] }));
    checkGraph(commits); checkGraph(commits.slice(0, 25));
  }
});

test('changed UI content gets a new host cache identity', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'git-graph-resource-')));
  const uris = [];
  try {
    await copyFile(new URL('./dist/server.mjs', import.meta.url), join(directory, 'server.mjs'));
    for (const html of ['<p>Original theme</p>', '<p>Updated theme</p>']) {
      await writeFile(join(directory, 'window.html'), html);
      const client = new Client({ name: 'resource-cache-test', version: '1.0.0' });
      try {
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(directory, 'server.mjs')] }));
        const { tools } = await client.listTools();
        const uri = tools.find(tool => tool.name === 'git_graph')._meta.ui.resourceUri;
        assert.equal((await client.readResource({ uri })).contents[0].text, html);
        uris.push(uri);
      } finally { await client.close(); }
    }
    assert.notEqual(uris[0], uris[1], 'a host must not reuse the previous UI after an update');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('column layout persists across MCP processes and repositories with bounded app-only writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'git-graph-layout-'));
  const data = join(directory, 'data');
  const settings = join(data, 'column-widths.json');
  const runner = join(directory, 'server.mjs');
  const clients = [];
  try {
    await writeFile(runner, `import { createServer } from ${JSON.stringify(new URL('./dist/server.mjs', import.meta.url).href)};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/server/stdio'))};
await createServer({ preferencesDirectory: ${JSON.stringify(data)} }).connect(new StdioServerTransport());`);
    const connect = async cwd => {
      const client = new Client({ name: 'layout-test', version: '1.0.0' });
      clients.push(client);
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [runner], cwd }));
      return client;
    };
    const first = await connect(import.meta.dirname);
    const { tools } = await first.listTools();
    const save = tools.find(tool => tool.name === 'git_graph_save_layout');
    assert.equal(save.annotations.readOnlyHint, false);
    assert.equal(save.annotations.destructiveHint, false);
    assert.deepEqual(save._meta.ui.visibility, ['app']);
    assert.ok(tools.filter(tool => tool !== save).every(tool => tool.annotations.readOnlyHint));
    assert.deepEqual((await first.callTool({ name: 'git_graph_layout', arguments: {} })).structuredContent, { widths: {} });
    const widths = { graph: 100, message: 720, author: 160, date: 90, hash: 100 };
    assert.ok(!(await first.callTool({ name: 'git_graph_save_layout', arguments: { widths } })).isError);
    await first.close();
    const second = await connect(directory);
    assert.deepEqual((await second.callTool({ name: 'git_graph_layout', arguments: {} })).structuredContent, { widths });
    const saved = await readFile(settings, 'utf8');
    for (const args of [{ widths: { graph: -1 } }, { widths: { message: 99 } }, { widths: { author: 2401 } },
      { widths: { date: 64.5 } }, { widths: { hash: '80' } }, { widths: { extra: 100 } },
      { widths: {}, preferencesDirectory: directory }, { widths: {}, repoPath: directory }]) {
      assert.equal((await second.callTool({ name: 'git_graph_save_layout', arguments: args })).isError, true);
      assert.equal(await readFile(settings, 'utf8'), saved);
    }
    await writeFile(settings, '{broken');
    const invalid = await second.callTool({ name: 'git_graph_layout', arguments: {} });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /读取列宽布局失败/);
    assert.equal(await readFile(settings, 'utf8'), '{broken');
    assert.ok(!(await second.callTool({ name: 'git_graph_save_layout', arguments: { widths: {} } })).isError);
    await second.close();
    const third = await connect(import.meta.dirname);
    assert.deepEqual((await third.callTool({ name: 'git_graph_layout', arguments: {} })).structuredContent, { widths: {} });
    await rm(data, { recursive: true }); await writeFile(data, 'not a directory');
    assert.equal((await third.callTool({ name: 'git_graph_save_layout', arguments: { widths } })).isError, true);
    assert.equal(await readFile(data, 'utf8'), 'not a directory');
  } finally {
    for (const client of clients) await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

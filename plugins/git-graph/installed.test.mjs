import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { repository } from './git.mjs';

test('installed plugin launcher preserves the task repository and non-Git directory', { timeout: 10000 }, async () => {
  const repo = await repository(process.cwd());
  const noGit = await realpath(await mkdtemp(join(tmpdir(), 'git-graph-installed-')));
  const { git_graph: config } = JSON.parse(await readFile(new URL('.mcp.json', import.meta.url))).mcpServers;
  const env = Object.fromEntries(config.env_vars.filter(name => process.env[name]).map(name => [name, process.env[name]]));
  try {
    for (const cwd of [repo, noGit]) {
      const client = new Client({ name: 'git-graph-installed-check', version: '1.0.0' });
      try {
        await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env, cwd }));
        const result = await client.callTool({ name: 'git_graph', arguments: {} });
        assert.ok(!result.isError, JSON.stringify(result));
        assert.equal(result.structuredContent.contextCwd, cwd);
        assert.equal(result.structuredContent.repo, cwd === repo ? repo : null);
      } finally { await client.close(); }
    }
  } finally { await rm(noGit, { recursive: true, force: true }); }
});

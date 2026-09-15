import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { history, commit, diff, workspaceFile } from './git.mjs';

const html = await readFile(new URL('./window.html', import.meta.url), 'utf8');
// Hosts cache UI by resource URI. Changed content must have a different identity.
const resourceUri = `ui://git-graph/window-${createHash('sha256').update(html).digest('hex').slice(0, 16)}.html`;
const hash = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
async function openGraph() {
  const cwd = process.cwd();
  try {
    return { ...await history({ repoPath: cwd }), contextCwd: cwd };
  } catch (error) {
    if (!/not a git repository/i.test(error.cause?.stderr || '')) throw error;
    return { repo: null, contextCwd: cwd };
  }
}
export const definitions = {
  git_graph: { title: 'Git Graph', description: 'Browse Git history for the current Codex task working directory. Read-only.',
    schema: z.strictObject({}), run: openGraph },
  git_graph_history: { title: '读取提交历史', schema: z.strictObject({ branch: z.string().max(1024).optional(),
    offset: z.number().int().min(0).max(1000000).optional(), tips: z.array(hash).max(10000).optional(),
    limit: z.number().int().min(1).max(500).optional() }), run: history },
  git_graph_commit: { title: '查看提交', schema: z.strictObject({ hash, parent: z.number().int().min(0).optional() }), run: commit },
  git_graph_diff: { title: '查看文件差异', schema: z.strictObject({ hash, parent: z.number().int().min(0).optional(),
    path: z.string().min(1).max(4096) }), run: diff },
  git_graph_workspace_file: { title: '定位工作区文件', schema: z.strictObject({ hash, parent: z.number().int().min(0).optional(),
    path: z.string().min(1).max(4096) }), run: workspaceFile },
};

export async function call(name, args) {
  try {
    const definition = definitions[name];
    if (!definition) throw new Error('未知的 Git Graph 操作。');
    const data = await definition.run({ ...definition.schema.parse(args), repoPath: process.cwd() });
    return { content: [{ type: 'text', text: name === 'git_graph' ? 'Git Graph 窗口数据已准备。' : '只读查询完成。' }], structuredContent: data };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
}

export function createServer() {
  const server = new McpServer({ name: 'git-graph', title: 'Git Graph', version: '0.1.5' });
  for (const [name, definition] of Object.entries(definitions)) {
    registerAppTool(server, name, { title: definition.title, description: definition.description || definition.title,
      inputSchema: definition.schema, annotations,
      _meta: name === 'git_graph' ? {
        ui: { resourceUri, visibility: ['app', 'model'] },
        // Codex Desktop 26.908 supports these window entrypoints; keep standard MCP UI metadata too.
        'openai/ui': { entrypoints: [{ type: 'thread' }], preferredModelDisplayMode: 'fullscreen' },
      } : { ui: { visibility: ['app'] } },
    }, args => call(name, args));
  }
  registerAppResource(server, 'Git Graph', resourceUri, { mimeType: RESOURCE_MIME_TYPE }, async () => ({ contents: [{
    uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html,
    _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
  }] }));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createServer().connect(new StdioServerTransport());
}

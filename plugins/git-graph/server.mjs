import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { history, commit, diff, workspaceFile } from './git.mjs';
import { widthsSchema } from './column-layout.mjs';

const html = await readFile(new URL('./window.html', import.meta.url), 'utf8');
// Hosts cache UI by resource URI. Changed content must have a different identity.
const resourceUri = `ui://git-graph/window-${createHash('sha256').update(html).digest('hex').slice(0, 16)}.html`;
const hash = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const preferencesDirectory = join(process.env.CODEX_HOME || join(homedir(), '.codex'),
  'plugins/data/git-graph-codex-git-graph');

async function readLayout({ preferencesDirectory }) {
  try {
    return { widths: widthsSchema.parse(JSON.parse(await readFile(join(preferencesDirectory, 'column-widths.json'), 'utf8'))) };
  } catch (error) {
    if (error.code === 'ENOENT') return { widths: {} };
    throw new Error(`读取列宽布局失败：${error.message}`);
  }
}
async function saveLayout({ widths, preferencesDirectory }) {
  const temporary = join(preferencesDirectory, `column-widths.${randomUUID()}.tmp`);
  try {
    await mkdir(preferencesDirectory, { recursive: true });
    try {
      await writeFile(temporary, JSON.stringify(widths) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, join(preferencesDirectory, 'column-widths.json'));
    } finally { await rm(temporary, { force: true }); }
    return { widths };
  } catch (error) {
    throw new Error(`保存列宽布局失败：${error.message}`);
  }
}
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
  git_graph_layout: { title: '读取列宽布局', schema: z.strictObject({}), run: readLayout },
  git_graph_save_layout: { title: '保存列宽布局', description: 'Save global Git Graph column widths in plugin data. Does not modify Git repositories.',
    schema: z.strictObject({ widths: widthsSchema }), run: saveLayout, annotations: { ...annotations, readOnlyHint: false } },
};

export async function call(name, args, directory = preferencesDirectory) {
  try {
    const definition = definitions[name];
    if (!definition) throw new Error('未知的 Git Graph 操作。');
    const data = await definition.run({ ...definition.schema.parse(args), repoPath: process.cwd(), preferencesDirectory: directory });
    return { content: [{ type: 'text', text: 'Git Graph 操作完成。' }], structuredContent: data };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
}

export function createServer({ preferencesDirectory: directory = preferencesDirectory } = {}) {
  const server = new McpServer({ name: 'git-graph', title: 'Git Graph', version: '0.2.1' });
  for (const [name, definition] of Object.entries(definitions)) {
    registerAppTool(server, name, { title: definition.title, description: definition.description || definition.title,
      inputSchema: definition.schema, annotations: definition.annotations || annotations,
      _meta: name === 'git_graph' ? {
        ui: { resourceUri, visibility: ['app', 'model'] },
        // Codex Desktop 26.908 supports these window entrypoints; keep standard MCP UI metadata too.
        'openai/ui': { entrypoints: [{ type: 'thread' }], preferredModelDisplayMode: 'fullscreen' },
      } : { ui: { visibility: ['app'] } },
    }, args => call(name, args, directory));
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

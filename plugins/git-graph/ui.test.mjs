import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { git } from './git.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = import.meta.dirname;
const require = createRequire(`${root}/package.json`);
const { build } = require('esbuild');
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')));
const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client/stdio')));
const temporary = await mkdtemp(join(tmpdir(), 'git-graph-ui-'));
const data = join(temporary, 'data');
const runner = join(temporary, 'server.mjs');
await writeFile(runner, `import { createServer } from ${JSON.stringify(pathToFileURL(`${root}/dist/server.mjs`).href)};
import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(require.resolve('@modelcontextprotocol/server/stdio')).href)};
await createServer({preferencesDirectory:${JSON.stringify(data)}}).connect(new StdioServerTransport());`);
const client = new Client({ name: 'layout-ui-check', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [runner], cwd: root }));
let failSave = false;
let historyFixture, historyClient, intercept;
async function callTool(request) {
  if (intercept) { const result=await intercept(request); if (result) return result; }
  if (historyClient) return historyClient.callTool(['git_graph','git_graph_history'].includes(request.name)
    ? {name:'git_graph_history',arguments:{...request.arguments,limit:2}} : request);
  const commit=historyFixture?.commits.find(commit=>commit.hash===request.arguments?.hash);
  if (historyFixture&&['git_graph','git_graph_history'].includes(request.name)) return {content:[],structuredContent:historyFixture};
  if (commit&&request.name==='git_graph_commit') return {content:[],structuredContent:{...commit,message:commit.subject,files:[],parent:0}};
  if (failSave&&request.name==='git_graph_save_layout') return {isError:true,content:[{type:'text',text:'模拟存储不可写'}]};
  return client.callTool(request);
}
const script = `import {AppBridge,PostMessageTransport} from '@modelcontextprotocol/ext-apps/app-bridge';
const frame=document.querySelector('iframe');
const variables={'--color-background-primary':'#0d1117','--color-background-secondary':'#292d33','--color-text-primary':'#e6edf3','--color-text-secondary':'#7d838b','--color-border-secondary':'#23282f','--color-ring-primary':'#76a7f3','--color-text-success':'#3fb950','--color-text-danger':'#f85149','--font-sans':'system-ui','--font-text-sm-size':'13px','--font-text-xs-size':'12px'};
const bridge=new AppBridge(null,{name:'UI test host',version:'1.0.0'},{serverTools:{}},{hostContext:{theme:'dark',styles:{variables},displayMode:'fullscreen',containerDimensions:{maxHeight:2000}}});
async function call(params){return(await fetch('/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(params)})).json();}
bridge.oncalltool=call;
bridge.oninitialized=async()=>{await bridge.sendToolInput({arguments:{}});await bridge.sendToolResult(await call({name:'git_graph',arguments:{}}));};
window.light=()=>bridge.sendHostContextChange({theme:'light',styles:{variables:{...variables,'--color-background-primary':'#ffffff','--color-text-primary':'#202020','--color-text-secondary':'#777777','--color-border-secondary':'#dddddd'}}});
await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));frame.src='/frame.html';`;
const built = await build({ stdin: { contents: script, resolveDir: root, sourcefile: 'host.js' }, bundle:true,format:'esm',write:false });
const server = createServer(async (req,res)=>{
  try {
    if(req.url==='/call') {
      let text='';for await(const part of req)text+=part;
      const request=JSON.parse(text);
      const result=await callTool(request);
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
    }
    if(req.url==='/host.js'){res.setHeader('Content-Type','text/javascript');res.end(built.outputFiles[0].text);return;}
    if(req.url==='/frame.html'){res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; font-src data:; img-src data: blob:; worker-src blob:; connect-src blob: data:");res.end(await readFile(`${root}/dist/window.html`));return;}
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><style>html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style><iframe sandbox="allow-scripts"></iframe><script type="module" src="/host.js"></script></html>');
  }catch(e){res.writeHead(500).end(e.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM});
  const context=await browser.newContext({viewport:{width:1000,height:760}});
  let page=await context.newPage();
  const errors=[], workers=[];
  const observe = page => {
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',message=>{if (message.type()==='error' || /Could not create web worker/.test(message.text())) errors.push(message.text());});
    page.on('worker',worker=>workers.push(worker.url()));
  };
  observe(page);
  const url=`http://127.0.0.1:${server.address().port}`;
  const open=async()=>{
    await page.goto(url);
    const f=page.frameLocator('iframe');
    await f.locator('.commit-row').first().waitFor();
    await f.locator('[data-column="message"][aria-disabled="false"]').waitFor();return f;
  };
  let frame=await open();
  const widths=()=>frame.locator('#columns > span').evaluateAll(cells=>cells.map(c=>Math.round(c.getBoundingClientRect().width)));
  const aligned=async()=>{
    const difference=await frame.locator('#history-table').evaluate(table=>{
      const h=[...table.querySelector('#columns').children].map(e=>e.getBoundingClientRect());
      return [...table.querySelector('.commit-row').children].map((e,i)=>Math.abs(e.getBoundingClientRect().x-h[i].x));
    });assert.ok(difference.every(d=>d<1),JSON.stringify(difference));
  };
  // Resize every non-message column first: the flexible message track must not absorb the drag.
  for (const [index, id] of [[2, 'author'], [3, 'date'], [4, 'hash'], [0, 'graph']]) {
    const target=frame.locator(`[data-column="${id}"]`);
    const originalWidths=await widths(), start=await target.boundingBox();
    await page.mouse.move(start.x+8,start.y+12);await page.mouse.down();
    for (const delta of (id === 'hash' ? [-4, -2, -6, -3] : [12, 4, 20, 8])) {
      await page.mouse.move(start.x+8+delta,start.y+12,{steps:3});
      const now=await target.boundingBox();
      assert.ok(Math.abs(now.x-start.x-delta)<1, `${id} boundary must follow pointer: expected ${delta}, got ${now.x-start.x}`);
      const current=await widths();
      for (let i=0;i<current.length;i++) assert.equal(current[i],originalWidths[i]+(i===index?delta:0));
      await aligned();
    }
    await page.keyboard.press('Escape');await page.mouse.up();
    assert.deepEqual(await widths(),originalWidths,'cancel restores the flexible layout');
    await target.press('ArrowRight');
    assert.equal((await widths())[1],originalWidths[1],'keyboard resizing also preserves the message width');
    for(let attempt=0;attempt<100;attempt++) {
      try { if(JSON.parse(await readFile(join(data,'column-widths.json'),'utf8'))[id]===originalWidths[index]+8) break; } catch(e) { if(e.code!=='ENOENT') throw e; }
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(JSON.parse(await readFile(join(data,'column-widths.json'),'utf8'))[id],originalWidths[index]+8);
    const result=await client.callTool({name:'git_graph_save_layout',arguments:{widths:{}}});
    assert.ok(!result.isError);
    frame=await open();
  }
  await aligned();
  const original=await widths();
  const handle=frame.locator('[data-column="message"]');
  const bounds=await handle.boundingBox();
  await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.down();
  await page.mouse.move(bounds.x+bounds.width/2-180,bounds.y+bounds.height/2,{steps:10});await page.mouse.up();
  assert.equal((await widths())[1],original[1]-180);await aligned();
  await handle.press('Shift+ArrowRight');assert.equal((await widths())[1],original[1]-179);
  const changed=await widths();
  await frame.locator('#refresh').click();await frame.locator('.commit-row').first().waitFor();assert.deepEqual(await widths(),changed);
  const saved=async()=>JSON.parse(await readFile(join(data,'column-widths.json'),'utf8'));
  for(let i=0;i<50&&(await saved()).message!==changed[1];i++)await new Promise(r=>setTimeout(r,20));
  assert.equal((await saved()).message,changed[1]);
  await page.close();page=await context.newPage();observe(page);frame=await open();
  assert.deepEqual(await widths(),changed);await aligned();
  await frame.locator('[data-column="author"]').press('ArrowRight');assert.equal((await widths())[2],108);
  const author=await frame.locator('[data-column="author"]').boundingBox();
  await page.mouse.move(author.x+8,author.y+12);await page.mouse.down();await page.mouse.move(author.x+70,author.y+12);
  await page.keyboard.press('Escape');await page.mouse.up();assert.equal((await widths())[2],108);
  await page.setViewportSize({width:400,height:700});
  assert.equal(await frame.locator('.commit-row').first().locator('.author').isVisible(),true);
  assert.equal(await frame.locator('#history-scroll').evaluate(e=>e.scrollWidth>e.clientWidth),true);
  await frame.locator('#history-scroll').evaluate(e=>{e.scrollLeft=e.scrollWidth;});await aligned();
  const sha=frame.locator('[data-column="hash"]');await sha.press('ArrowRight');assert.equal((await widths())[4],72);await aligned();
  await page.screenshot({path:join(temporary, 'narrow.png')});
  await page.setViewportSize({width:1000,height:760});await frame.locator('#history-scroll').evaluate(e=>{e.scrollLeft=0;});
  failSave=true;await frame.locator('[data-column="date"]').press('ArrowRight');
  await frame.locator('#layout-error').waitFor({state:'visible'});
  assert.match(await frame.locator('#layout-error').innerText(),/列宽尚未保存/);
  await frame.locator('#refresh').click();assert.equal(await frame.locator('#layout-error').isVisible(),true);
  failSave=false;await frame.locator('#layout-retry').click();await frame.locator('#layout-error').waitFor({state:'hidden'});
  await frame.locator('[data-column="date"]').dblclick();assert.equal((await widths())[3],60);
  await frame.locator('[data-column="message"]').press('Home');assert.equal((await widths())[1],original[1]-16);
  await page.evaluate(()=>window.light());
  await page.screenshot({path:join(temporary, 'light.png')});
  const branchNames=['codex/web-formily-before-dev-20260918','codex/web-formily-schema'];
  const commits=branchNames.map((name,index)=>({hash:String(index+1).repeat(40),parents:[],author:'Graph Test',
    email:'graph@example.invalid',date:'2026-09-19T00:00:00Z',subject:'refactor: align project structure with current conventions'}));
  historyFixture={repo:root,branch:'',missingBranch:'',head:commits[1].hash,headName:branchNames[1],hasMore:false,tips:commits.map(commit=>commit.hash),commits,
    refs:branchNames.map((name,index)=>({name:`refs/heads/${name}`,hash:commits[index].hash,type:'commit',symbolic:''}))};
  await client.callTool({name:'git_graph_save_layout',arguments:{widths:{message:478,author:62}}});
  frame=await open();
  for (const width of [1000,400]) {
    await page.setViewportSize({width,height:760});
    assert.deepEqual(await frame.locator('#rows .ref:not(.head)').allTextContents(),branchNames);
    const labels=await frame.locator('#rows .ref:not(.head)').evaluateAll(elements=>elements.map(label=>({
      name:label.textContent,visible:label.clientWidth,content:label.scrollWidth,
      insideMessage:label.getBoundingClientRect().right<=label.parentElement.getBoundingClientRect().right,
    })));
    assert.ok(labels.every(label=>label.content<=label.visible&&label.insideMessage),
      `branch names must remain distinguishable at ${width}px: ${JSON.stringify(labels)}`);
    await aligned();
  }
  const status=`2 条提交 · 已加载全部 · 当前检出分支：${branchNames[1]}`;
  assert.equal(await frame.locator('#history-status').textContent(),status);
  for (const [index,commit] of commits.entries()) {
    await frame.locator(`[data-hash="${commit.hash}"]`).click();
    await frame.locator('#commit-message').getByText(commit.subject,{exact:true}).waitFor();
    assert.equal(await frame.locator('#detail-hash').textContent(),commit.hash.slice(0,12));
    assert.deepEqual(await frame.locator('#commit-refs .ref').allTextContents(),[branchNames[index]]);
    assert.equal(await frame.locator('#commit-refs .ref').getAttribute('title'),`refs/heads/${branchNames[index]}`);
    assert.equal(await frame.locator('#history-status').textContent(),status,'selection must not change the checkout context');
    assert.equal(await frame.locator('#commit-refs').evaluate(element=>element.scrollWidth<=element.clientWidth),true);
  }
  // Keyboard selection and refreshed refs must update the same detail display.
  await frame.locator(`[data-hash="${commits[1].hash}"]`).press('ArrowUp');
  await frame.locator('#commit-refs').getByText(branchNames[0],{exact:true}).waitFor();
  historyFixture.refs.push({name:`refs/remotes/origin/${branchNames[0]}`,hash:commits[0].hash},
    {name:'refs/tags/v1.0.0',hash:commits[0].hash});
  await frame.locator('#refresh').click();
  await frame.locator('#commit-refs .tag').waitFor();
  assert.deepEqual(await frame.locator('#commit-refs .ref').allTextContents(),[branchNames[0],`origin/${branchNames[0]}`,'v1.0.0']);
  historyFixture.refs=historyFixture.refs.filter(ref=>ref.hash!==commits[0].hash);
  historyFixture.head=commits[0].hash;historyFixture.headName='';
  await frame.locator('#refresh').click();
  await frame.locator('#commit-refs').getByText('无分支或标签直接指向此提交',{exact:true}).waitFor();
  assert.equal(await frame.locator('#commit-refs .ref').count(),0,'unreferenced commits must not inherit the checkout branch');
  assert.equal(await frame.locator('#history-status').textContent(),`2 条提交 · 已加载全部 · 当前检出：分离的 HEAD（${commits[0].hash.slice(0,7)}）`);
  // Exercise history transitions against a real, isolated repository via the bundled MCP server.
  {
    const repo=join(temporary,'repo');
    await mkdir(repo);await git(repo,['init','-b','main']);
    for (const [key,value] of [['user.name','Graph Test'],['user.email','graph@example.invalid'],['commit.gpgsign','false'],['core.hooksPath','/dev/null']]) await git(repo,['config',key,value]);
    const save=async(name,contents,message)=>{
      await writeFile(join(repo,name),contents);await git(repo,['add','--',name]);await git(repo,['commit','-m',message]);
      return (await git(repo,['rev-parse','HEAD'])).trim();
    };
    await writeFile(join(repo,'extra.txt'),'extra\n');await git(repo,['add','extra.txt']);
    const base=await save('base.txt','root\n--old\n-- old header lookalike\n','Root');
    await git(repo,['checkout','-b','side']);
    const side=await save('side.txt','side\n','Side');
    await git(repo,['checkout','main']);
    const main=await save('base.txt','root\n++new\n++ new header lookalike\n','Main');
    await git(repo,['merge','--no-ff','side','-m','Merge side']);
    const merge=(await git(repo,['rev-parse','HEAD'])).trim();
    await git(repo,['checkout','-b','topic',base]);
    await save('topic.txt','one\n','Topic 1');
    await save('topic.txt','two\n','Topic 2');
    const topic=await save('topic.txt','three\n','Topic 3');
    await git(repo,['checkout','main']);
    await git(repo,['branch','release',main]);await git(repo,['tag','release',side]);
    await git(repo,['branch','origin/main',main]);await git(repo,['update-ref','refs/remotes/origin/main',side]);
    historyFixture=undefined;
    historyClient=new Client({name:'history-ui-check',version:'1.0.0'});
    await historyClient.connect(new StdioClientTransport({command:process.execPath,args:[runner],cwd:repo}));
    await page.setViewportSize({width:1000,height:850});
    const reopen=async()=>{intercept=null;frame=await open();};
    const settled=()=>frame.locator('#history-status').getByText('条提交',{exact:false}).waitFor();
    const selectMain=async()=>{await frame.locator('#branch').selectOption('refs/heads/main');await settled();};
    const loadAllMain=async()=>{await selectMain();await frame.locator('#load-more').click();await frame.locator('#history-status').getByText('4 条提交',{exact:false}).waitFor();};

    // A failed filter restores the loaded filter, while retry keeps the requested filter.
    await reopen();await selectMain();
    const oldRows=await frame.locator('.commit-row').evaluateAll(rows=>rows.map(row=>row.dataset.hash));
    intercept=async request=>request.name==='git_graph_history'&&request.arguments.branch==='refs/heads/topic'
      ?{isError:true,content:[{type:'text',text:'模拟读取失败'}]}:null;
    await frame.locator('#branch').selectOption('refs/heads/topic');await frame.locator('#error').waitFor({state:'visible'});
    assert.equal(await frame.locator('#branch').inputValue(),'refs/heads/main');
    assert.deepEqual(await frame.locator('.commit-row').evaluateAll(rows=>rows.map(row=>row.dataset.hash)),oldRows);
    intercept=null;await frame.locator('#retry').click();await frame.locator(`[data-hash="${topic}"]`).waitFor();
    assert.equal(await frame.locator('#branch').inputValue(),'refs/heads/topic');
    await selectMain();
    intercept=async request=>request.name==='git_graph_history'&&request.arguments.branch==='refs/heads/topic'
      ?{isError:true,content:[{type:'text',text:'模拟读取失败'}]}:null;
    await frame.locator('#branch').selectOption('refs/heads/topic');await frame.locator('#error').waitFor({state:'visible'});
    await frame.locator('#load-more').click();await frame.locator('#history-status').getByText('4 条提交',{exact:false}).waitFor();
    assert.equal(await frame.locator('#branch').inputValue(),'refs/heads/main');
    assert.equal(await frame.locator(`[data-hash="${topic}"]`).count(),0);

    // Refresh retains both the comparison parent and a non-first selected file.
    await reopen();await loadAllMain();
    await frame.locator(`[data-hash="${merge}"]`).click();await frame.locator('#parent').selectOption('1');
    await frame.locator('#files-label').getByText('相对父提交 2',{exact:false}).waitFor();
    await frame.locator('#refresh').click();await settled();
    await frame.locator('#commit-meta').getByText('Graph Test',{exact:false}).waitFor();
    assert.equal(await frame.locator('#parent').inputValue(),'1');
    assert.equal(await frame.locator('#diff-title').innerText(),'base.txt');
    await frame.locator('#load-more').click();await frame.locator(`[data-hash="${base}"]`).click();
    await frame.locator('#files button[data-path="extra.txt"]').click();
    // Filter to the root to keep this selection in the refreshed first page.
    await git(repo,['branch','root-only',base]);
    await frame.locator('#refresh').click();await settled();
    await frame.locator('#branch').selectOption('refs/heads/root-only');await settled();
    await frame.locator(`[data-hash="${base}"]`).click();await frame.locator('#files button[data-path="extra.txt"]').click();
    await frame.locator('#refresh').click();await settled();
    await frame.locator('#diff-status').getByText('1 处差异',{exact:true}).waitFor();
    assert.equal(await frame.locator('#files button[aria-pressed="true"]').getAttribute('data-path'),'extra.txt');
    await frame.locator('#close-detail').click();await frame.locator('#refresh').click();await settled();
    assert.equal(await frame.locator('#detail').isVisible(),false);

    // Deleted filters recover explicitly on both refresh and pagination.
    for (const button of ['refresh','load-more']) {
      await reopen();await frame.locator('#branch').selectOption('refs/heads/topic');await settled();
      await git(repo,['branch','-D','topic']);await frame.locator(`#${button}`).click();
      await frame.locator('#history-status').getByText('已显示所有分支与标签',{exact:false}).waitFor();
      assert.equal(await frame.locator('#branch').inputValue(),'');
      assert.equal(await frame.locator('#branch option[value="refs/heads/topic"]').count(),0);
      assert.equal(await frame.locator('#error').isVisible(),false);
      await git(repo,['branch','topic',topic]);
    }

    // Namespaces remain distinguishable in the picker, timeline and detail.
    await reopen();
    const names=['refs/heads/release','refs/tags/release','refs/heads/origin/main','refs/remotes/origin/main'];
    const labels=['本地 · release','标签 · release','本地 · origin/main','远程 · origin/main'];
    for (const [index,name] of names.entries()) {
      await frame.locator('#branch').selectOption(name);await settled();
      assert.equal(await frame.locator('#branch').evaluate(el=>el.selectedOptions[0].textContent),labels[index]);
      const badge=frame.locator(`#rows .ref[title="${name}"]`);
      assert.equal(await badge.innerText(),labels[index]);await badge.click();
      assert.equal(await frame.locator(`#commit-refs .ref[title="${name}"]`).innerText(),labels[index]);
    }

    // Full revision models preserve text that used to be mistaken for patch headers.
    await reopen();await loadAllMain();await frame.locator(`[data-hash="${main}"]`).click();
    await frame.locator('#diff-status').getByText('1 处差异',{exact:true}).waitFor();
    assert.match((await frame.locator('#diff-editor .view-lines').allTextContents()).join(' ').replaceAll('\u00a0',' '),/\+\+new/);
    assert.ok(await frame.locator('#diff-editor .char-insert').count()>0);
    assert.ok(await frame.locator('#diff-editor .char-delete').count()>0);
    assert.equal(await frame.locator('#diff-editor .monaco-editor').first().evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(13, 17, 23)');
    await frame.locator('#diff-mode').selectOption('split');
    assert.equal(await frame.locator('#diff-editor .editor.original').evaluate(el=>el.getBoundingClientRect().width>0),true);
    await frame.locator('#expand-detail').click();
    assert.equal(await frame.locator('#history-pane').isVisible(),false);
    if (process.env.UI_TEST_ARTIFACTS) {
      await mkdir(process.env.UI_TEST_ARTIFACTS,{recursive:true});
      await page.screenshot({path:join(process.env.UI_TEST_ARTIFACTS,'diff-dark.png')});
    }
    await page.evaluate(()=>window.light());
    await page.waitForTimeout(50);
    assert.equal(await frame.locator('#diff-editor .monaco-editor').first().evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');
    if (process.env.UI_TEST_ARTIFACTS) await page.screenshot({path:join(process.env.UI_TEST_ARTIFACTS,'diff-light.png')});
    await frame.locator('#expand-detail').click();

    // Compare two commits, swap the direction, and preserve the range on refresh.
    await frame.locator(`[data-hash="${base}"]`).click();
    await frame.locator(`[data-hash="${merge}"]`).click({modifiers:[process.platform==='darwin'?'Meta':'Control']});
    await frame.locator('#detail-hash').getByText(`${base.slice(0,7)} → ${merge.slice(0,7)}`,{exact:true}).waitFor();
    await frame.locator('#diff-status').getByText('处差异',{exact:false}).waitFor();
    assert.deepEqual(await frame.locator('#files button').evaluateAll(items=>items.map(el=>el.dataset.path)),['base.txt','side.txt']);
    assert.equal(await frame.locator('#rows [aria-selected="true"]').count(),2);
    await frame.locator('#files button[data-path="side.txt"]').click();
    await frame.locator('#diff-original').getByText('文件不存在',{exact:false}).waitFor();
    await frame.locator('#refresh').click();await settled();
    await frame.locator('#diff-status').getByText('处差异',{exact:false}).waitFor();
    assert.equal(await frame.locator('#files button[aria-pressed="true"]').getAttribute('data-path'),'side.txt');
    assert.equal(await frame.locator('#detail-hash').textContent(),`${base.slice(0,7)} → ${merge.slice(0,7)}`);
    await frame.locator('#swap-comparison').click();
    await frame.locator('#diff-status').getByText('处差异',{exact:false}).waitFor();
    assert.equal(await frame.locator('#detail-hash').textContent(),`${merge.slice(0,7)} → ${base.slice(0,7)}`);
    await frame.locator('#files button[data-path="side.txt"]').click();
    await frame.locator('#diff-modified').getByText('文件不存在',{exact:false}).waitFor();
    await frame.locator('#compare').click();
    await frame.locator('#detail-hash').getByText(base.slice(0,12),{exact:true}).waitFor();
    await frame.locator('#load-more').click();await frame.locator(`[data-hash="${main}"]`).waitFor();
    await frame.locator('#compare').click();
    assert.equal(await frame.locator('#compare-hint').isVisible(),true);
    await frame.locator(`[data-hash="${main}"]`).click();
    await frame.locator('#detail-hash').getByText(`${base.slice(0,7)} → ${main.slice(0,7)}`,{exact:true}).waitFor();

    // A late response from a previously selected file must not replace the current diff.
    await frame.locator('#compare').click();await frame.locator(`[data-hash="${base}"]`).click();
    await frame.locator('#diff-status').getByText('处差异',{exact:false}).waitFor();
    let releaseDiff, enteredDiff;
    const heldDiff=new Promise(resolve=>releaseDiff=resolve), startedDiff=new Promise(resolve=>enteredDiff=resolve);
    intercept=async request=>{
      if(request.name==='git_graph_diff'&&request.arguments.path==='extra.txt') {
        const result=await historyClient.callTool(request);enteredDiff();await heldDiff;return result;
      }
    };
    await frame.locator('#files button[data-path="extra.txt"]').click();await startedDiff;
    await frame.locator('#files button[data-path="base.txt"]').click();
    await frame.locator('#diff-status').getByText('处差异',{exact:false}).waitFor();
    const lateDiff=page.waitForResponse(response=>response.url().endsWith('/call')&&response.request().postDataJSON().name==='git_graph_diff'&&response.request().postDataJSON().arguments.path==='extra.txt');
    releaseDiff();await (await lateDiff).finished();await page.waitForTimeout(50);
    assert.equal(await frame.locator('#diff-title').innerText(),'base.txt');
    assert.doesNotMatch((await frame.locator('#diff-editor .view-lines').allTextContents()).join(' '),/extra/);
    intercept=async request=>request.name==='git_graph_diff'&&request.arguments.path==='extra.txt'
      ?{isError:true,content:[{type:'text',text:'模拟差异读取失败'}]}:null;
    await frame.locator('#files button[data-path="extra.txt"]').click();await frame.locator('#error').waitFor({state:'visible'});
    assert.equal(await frame.locator('#diff-editor').isVisible(),false);
    intercept=null;await frame.locator('#retry').click();await frame.locator('#diff-status').getByText('处差异',{exact:false}).waitFor();

    // A larger text file exercises folding, navigation, editor search and narrow layout.
    const lines=Array.from({length:100},(_,i)=>`const value${i} = ${i};`);
    await save('sample.ts',lines.join('\n')+'\n','Text base');
    lines[12]='const value12 = 1200;';lines[85]='const value85 = 8500;';
    const textTarget=await save('sample.ts',lines.join('\n')+'\n','Text changes');
    await reopen();await frame.locator(`[data-hash="${textTarget}"]`).click();
    await frame.locator('#diff-status').getByText('2 处差异',{exact:true}).waitFor();
    await frame.locator('#expand-detail').click();
    const linesBefore=(await frame.locator('#diff-editor .view-lines').allTextContents()).join(' ');
    assert.match(linesBefore,/value12/);assert.doesNotMatch(linesBefore,/value50/);
    await frame.locator('#next-change').click();await page.waitForTimeout(50);
    await frame.locator('#prev-change').click();
    const input=frame.locator('#diff-editor .editor.modified').getByRole('textbox',{name:'目标版本，只读'});
    await input.press('x');
    assert.equal((await frame.locator('#diff-editor .view-lines').allTextContents()).join(' '),linesBefore,'historical models remain read-only');
    await input.press(process.platform==='darwin'?'Meta+f':'Control+f');
    await frame.locator('#diff-editor .find-widget.visible').waitFor();
    await input.press('Escape');
    assert.equal(await frame.locator('#detail').isVisible(),true,'editor Escape does not close the commit');
    await page.setViewportSize({width:400,height:700});await frame.locator('#expand-detail').click();
    await page.waitForTimeout(50);
    if(process.env.UI_TEST_ARTIFACTS) await page.screenshot({path:join(process.env.UI_TEST_ARTIFACTS,'diff-narrow.png')});
    assert.equal(await frame.locator('#app').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    assert.equal(await frame.locator('#diff-status').evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight),true,'diff footer remains reachable in a narrow panel');
    await page.setViewportSize({width:1000,height:850});

    await save('eol.txt','\uFEFFone\r\ntwo','Original line endings');
    await writeFile(join(repo,'binary.bin'),Buffer.from([0,1,2]));await git(repo,['add','binary.bin']);
    const special=await save('eol.txt','one\ntwo','Encoding and binary changes');
    await reopen();await frame.locator(`[data-hash="${special}"]`).click();
    await frame.locator('#diff-notice').getByText('二进制文件',{exact:false}).waitFor();
    assert.equal(await frame.locator('#diff-editor').isVisible(),false);
    await frame.locator('#files button[data-path="eol.txt"]').click();
    await frame.locator('#diff-status').getByText('文本相同；换行符或 BOM 有变化',{exact:true}).waitFor();

    // Changing refs between pages reloads a coherent history, including HEAD.
    await reopen();await selectMain();
    const added=await save('new.txt','new\n','New commit during pagination');
    await frame.locator('#load-more').click();await frame.locator(`[data-hash="${added}"]`).waitFor();
    assert.equal(await frame.locator(`[data-hash="${added}"] .head`).count(),1);
    assert.equal(await frame.locator(`[data-hash="${added}"] .ref[title="refs/heads/main"]`).count(),1);
    assert.match(await frame.locator('#history-status').innerText(),/仓库引用已更新/);
    assert.equal(await frame.locator('.commit-row').count(),2,'a new snapshot starts at its first page');
    await frame.locator('#load-more').click();await frame.locator('#history-status').getByText('4 条提交',{exact:false}).waitFor();
    assert.equal(new Set(await frame.locator('.commit-row').evaluateAll(rows=>rows.map(row=>row.dataset.hash))).size,4);

    // A delayed old filter cannot expose the wrong rows or replace the newer result.
    await reopen();
    let release,entered;
    const held=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
    intercept=async request=>{
      if(request.name==='git_graph_history'&&request.arguments.branch==='refs/heads/main') {
        const result=await historyClient.callTool({...request,arguments:{...request.arguments,limit:2}});
        entered();await held;return result;
      }
    };
    await frame.locator('#branch').selectOption('refs/heads/main');await started;
    assert.equal(await frame.locator('#history-table').isVisible(),false);
    assert.equal(await frame.locator('#searchbar').evaluate(element=>element.inert),true);
    await frame.locator('#branch').selectOption('refs/heads/topic');await frame.locator(`[data-hash="${topic}"]`).waitFor();
    const delayed=page.waitForResponse(response=>response.url().endsWith('/call')&&response.request().postDataJSON().arguments?.branch==='refs/heads/main');
    release();await (await delayed).finished();await page.waitForTimeout(50);
    assert.equal(await frame.locator('#branch').inputValue(),'refs/heads/topic');
    assert.equal(await frame.locator(`[data-hash="${added}"]`).count(),0);
    assert.equal(await frame.locator('#history-table').isVisible(),true);
    assert.equal(await frame.locator('#searchbar').evaluate(element=>element.inert),false);
  }
  assert.ok(workers.length>0&&workers.every(url=>url.startsWith('blob:')),'diff computation uses bundled blob workers');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks:['column resizing and persistence','reference identities','history filtering and pagination','parent and file refresh','Monaco inline/split diff','host theme sync','comparison and swap','comparison refresh','stale diff responses','diff retry','read-only models','unchanged region folding','change navigation','editor search and focus','narrow diff layout','bundled CSP worker','stale history responses'],original,changed}));
}finally{
  await browser?.close();server.closeAllConnections();server.close();await client.close();await historyClient?.close();await rm(temporary,{recursive:true,force:true});
}

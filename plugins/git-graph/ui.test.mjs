import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
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
let historyFixture;
const script = `import {AppBridge,PostMessageTransport} from '@modelcontextprotocol/ext-apps/app-bridge';
const frame=document.querySelector('iframe');
const variables={'--color-background-primary':'#0d1117','--color-background-secondary':'#292d33','--color-text-primary':'#e6edf3','--color-text-secondary':'#7d838b','--color-border-secondary':'#23282f','--color-ring-primary':'#76a7f3','--font-sans':'system-ui','--font-text-sm-size':'13px','--font-text-xs-size':'12px'};
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
      const result=historyFixture&&request.name==='git_graph'?{content:[],structuredContent:historyFixture}:
        failSave&&request.name==='git_graph_save_layout'?{isError:true,content:[{type:'text',text:'模拟存储不可写'}]}:await client.callTool(request);
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
    }
    if(req.url==='/host.js'){res.setHeader('Content-Type','text/javascript');res.end(built.outputFiles[0].text);return;}
    if(req.url==='/frame.html'){res.setHeader('Content-Type','text/html');res.end(await readFile(`${root}/dist/window.html`));return;}
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><style>html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style><iframe sandbox="allow-scripts"></iframe><script type="module" src="/host.js"></script></html>');
  }catch(e){res.writeHead(500).end(e.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM});
  const context=await browser.newContext({viewport:{width:1000,height:760}});
  let page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
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
  await page.close();page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));frame=await open();
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
  historyFixture={repo:root,head:'',headName:'',hasMore:false,tips:commits.map(commit=>commit.hash),commits,
    refs:branchNames.map((name,index)=>({name:`refs/heads/${name}`,hash:commits[index].hash,type:'commit',symbolic:''}))};
  await client.callTool({name:'git_graph_save_layout',arguments:{widths:{message:478,author:62}}});
  frame=await open();
  for (const width of [1000,400]) {
    await page.setViewportSize({width,height:760});
    assert.deepEqual(await frame.locator('.ref').allTextContents(),branchNames);
    const labels=await frame.locator('.ref').evaluateAll(elements=>elements.map(label=>({
      name:label.textContent,visible:label.clientWidth,content:label.scrollWidth,
      insideMessage:label.getBoundingClientRect().right<=label.parentElement.getBoundingClientRect().right,
    })));
    assert.ok(labels.every(label=>label.content<=label.visible&&label.insideMessage),
      `branch names must remain distinguishable at ${width}px: ${JSON.stringify(labels)}`);
    await aligned();
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks:['author-first drag','date-first drag','hash-first drag','graph-first drag','drag','keyboard','alignment','refresh','new-page persistence','cancel','narrow scroll','save retry','double-click reset','Home reset','light theme','long branch names'],original,changed}));
}finally{
  await browser?.close();server.closeAllConnections();server.close();await client.close();await rm(temporary,{recursive:true,force:true});
}

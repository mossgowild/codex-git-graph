# Git Graph for Codex

在 Codex Desktop 的任务侧面板中，交互式浏览当前 Git 仓库。当前版本：0.2.1。

- 提交关系图、本地及远程分支、标签筛选。
- 搜索已加载的提交，查看提交详情、文件差异及合并父节点。
- 跟随 Codex 的颜色、字体与主题，支持窄面板和键盘导航。
- 插件列表与任务侧面板使用统一的 Git 分支图标，适配浅色、深色主题。
- 拖动表头分隔线调整各列宽度，跨任务、重启及插件更新保留布局。
- 自动使用当前任务目录及 linked worktree，不提供仓库切换。
- 宿主支持时，可将工作区当前文件打开到 Codex 原生文件面板。

所有 Git 操作只读，不执行 fetch、checkout 或 commit。每次加载 250 条提交，可继续加载；搜索覆盖已加载的历史。

## 通过 GitHub 安装

需要支持插件市场和 MCP Apps 任务侧面板的 Codex Desktop、Node.js 20.11+ 和 Git。`node` 与 `git` 必须在 Codex 可用的 PATH 中。私有仓库需要本机 Git 具有相应的 GitHub 读取权限。

```sh
codex plugin marketplace add https://github.com/mossgowild/codex-git-graph-plugin.git
codex plugin add git-graph@codex-git-graph
```

仓库包含已构建的 `dist/`，安装时无需运行 npm。安装后重启 Codex，进入目标仓库的任务，在右侧面板“新建标签页”中选择 Git Graph。新任务会加载新安装的插件。

如果此前曾用 `codex mcp add git_graph` 手动注册开发版，在插件安装成功后执行一次 `codex mcp remove git_graph`，避免重复入口。

更新：

```sh
codex plugin marketplace upgrade codex-git-graph
codex plugin add git-graph@codex-git-graph
```

卸载：

```sh
codex plugin remove git-graph@codex-git-graph
```

市场采用 [OpenAI 官方插件目录格式](https://developers.openai.com/plugins/build/plugins)。已通过上述 GitHub 链接完成安装，并由 Codex app-server 验证插件身份、任务侧面板入口、目标仓库、非 Git 目录及默认任务目录。

## 操作与边界

点击提交查看变更文件，方向键切换文件及 diff。关闭详情后保留选中提交并恢复焦点；刷新不会重新展开已关闭的详情。搜索框支持 Enter 跳转和 Shift+Enter 反向跳转。

分支标签按完整名称宽度显示，不使用固定宽度截断；提交列空间不足时，可拖宽该列查看完整名称。

拖动列标题右侧的分隔线调整宽度；分隔线跟随鼠标，其余列保持宽度，右侧列随之移动。首次调宽时固定提交列的当前宽度，避免自动伸缩抵消拖动；双击恢复该列默认宽度。分隔线支持 Tab 聚焦、左右键调整 8 px、Shift + 左右键微调 1 px，Home 恢复默认，Escape 取消拖动。窄面板保留所有列并允许横向滚动。关系图始终保留容纳全部分支线的最小宽度。

列宽只写入插件数据目录 `~/.codex/plugins/data/git-graph-codex-git-graph/column-widths.json`，使用 `CODEX_HOME` 时跟随该目录；不写入仓库或 Codex 设置。所有任务共享最近一次保存的布局，已经打开的其他面板在重新打开时读取更新。保存失败会显示错误并提供重试。

“在 Codex 中打开工作区文件”打开的是当前内容。不存在的历史文件仍可在 Git Graph 内查看差异；服务器拒绝打开指向仓库外的符号链接及非普通文件。

指定历史提交暂不能交给原生审查面板：当前宿主接口不接受任意提交 SHA 或合并父节点。任务侧面板入口与原生文件打开使用实验性宿主扩展，已对照 Codex Desktop 26.908.40834；后续版本可能需要适配。真实 Codex 窗口的最终视觉效果和原生文件打开仍待用户验证。

## 开发

```sh
git clone https://github.com/mossgowild/codex-git-graph-plugin.git
cd codex-git-graph-plugin/plugins/git-graph
npm ci
npm run build
npm test
```

源码和构建产物都在 `plugins/git-graph/`；仓库市场入口位于 `.agents/plugins/marketplace.json`。发布修改时一起提交更新后的 `dist/` 和 `.mcp.json`。图布局、SVG 与界面为本地实现，第三方 SDK 负责 MCP 和宿主通信。图标源文件位于 `assets/`，插件清单引用 SVG，构建时将同一组图标内嵌到 MCP `serverInfo.icons`，不发起图标网络请求。

当前 Codex 兼容格式不会展开 MCP 参数中的 `${PLUGIN_ROOT}`。构建脚本按插件清单版本生成启动命令，从 `CODEX_HOME`（未设置时为 `~/.codex`）下的 `plugins/cache/codex-git-graph/git-graph/<version>/` 加载插件，保持进程工作目录为当前任务目录。这依赖 Codex 的缓存目录结构；以后宿主支持直接传入插件路径且保留任务目录时应替换。修改清单版本后需要重新构建；不要单独复制 `.mcp.json` 到别的市场。

测试覆盖真实 Git 历史、合并父节点、特殊路径和重命名、分页、只读状态、任务仓库隔离、文件定位边界、图连接关系、UI 缓存标识、列宽跨进程保存和设置参数校验。界面已在独立 Chromium 测试宿主中验证列宽拖动、键盘微调、取消和恢复默认、重新打开后的布局恢复、窄面板横向对齐及保存失败重试。

浏览器回归检查使用 `npm run test:ui`，需要可用的 Playwright 和 Chromium。可通过 `PLAYWRIGHT_MODULE` 指向现有 Playwright 的模块入口，通过 `PLAYWRIGHT_CHROMIUM` 指向现有浏览器可执行文件；未设置时使用本地 Playwright 及其默认浏览器。检查会在临时数据目录中覆盖各列首次拖动的边界位移、取消、布局恢复和错误重试，不修改个人布局。

在本机已安装当前清单版本后，运行 `npm run test:installed` 可额外检查实际缓存中的启动程序，确认它保留任务仓库及非 Git 目录；该检查不会安装插件或修改 Codex 配置。

依赖许可见 [THIRD-PARTY-LICENSES.txt](plugins/git-graph/THIRD-PARTY-LICENSES.txt)。

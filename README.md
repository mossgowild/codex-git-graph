# Git Graph for Codex

在 Codex Desktop 的任务侧面板中，交互式浏览当前 Git 仓库。当前版本：0.1.5。

- 提交关系图、本地及远程分支、标签筛选。
- 搜索已加载的提交，查看提交详情、文件差异及合并父节点。
- 跟随 Codex 的颜色、字体与主题，支持窄面板和键盘导航。
- 自动使用当前任务目录及 linked worktree，不提供仓库切换。
- 宿主支持时，可将工作区当前文件打开到 Codex 原生文件面板。

所有 Git 操作只读，不执行 fetch、checkout 或 commit。每次加载 250 条提交，可继续加载；搜索覆盖已加载的历史。

## 通过 GitHub 安装

需要支持插件市场和 MCP Apps 任务侧面板的 Codex Desktop、Node.js 20.11+ 和 Git。`node` 与 `git` 必须在 Codex 可用的 PATH 中。私有仓库需要本机 Git 具有相应的 GitHub 读取权限。

```sh
codex plugin marketplace add https://github.com/mossgowild/codex-git-graph.git
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

市场采用 [OpenAI 官方插件目录格式](https://developers.openai.com/plugins/build/plugins)，上述命令已对照 Codex 自带 CLI 的安装接口。

## 操作与边界

点击提交查看变更文件，方向键切换文件及 diff。关闭详情后保留选中提交并恢复焦点；刷新不会重新展开已关闭的详情。搜索框支持 Enter 跳转和 Shift+Enter 反向跳转。

“在 Codex 中打开工作区文件”打开的是当前内容。不存在的历史文件仍可在 Git Graph 内查看差异；服务器拒绝打开指向仓库外的符号链接及非普通文件。

指定历史提交暂不能交给原生审查面板：当前宿主接口不接受任意提交 SHA 或合并父节点。任务侧面板入口与原生文件打开使用实验性宿主扩展，已对照 Codex Desktop 26.908.40834；后续版本可能需要适配。真实 Codex 窗口的最终视觉效果和原生文件打开仍待用户验证。

## 开发

```sh
git clone https://github.com/mossgowild/codex-git-graph.git
cd codex-git-graph/plugins/git-graph
npm ci
npm run build
npm test
```

源码和构建产物都在 `plugins/git-graph/`；仓库市场入口位于 `.agents/plugins/marketplace.json`。发布修改时一起提交更新后的 `dist/` 和 `.mcp.json`。图布局、SVG 与界面为本地实现，第三方 SDK 负责 MCP 和宿主通信。

当前 Codex 兼容格式不会展开 MCP 参数中的 `${PLUGIN_ROOT}`。构建脚本按插件清单版本生成启动命令，从 `CODEX_HOME`（未设置时为 `~/.codex`）下的 `plugins/cache/codex-git-graph/git-graph/<version>/` 加载插件，保持进程工作目录为当前任务目录。这依赖 Codex 的缓存目录结构；以后宿主支持直接传入插件路径且保留任务目录时应替换。修改清单版本后需要重新构建；不要单独复制 `.mcp.json` 到别的市场。

测试覆盖真实 Git 历史、合并父节点、特殊路径和重命名、分页、只读状态、任务仓库隔离、文件定位边界、图连接关系与 UI 缓存标识。界面已在独立测试宿主中验证深浅主题、窄面板及键盘导航。

依赖许可见 [THIRD-PARTY-LICENSES.txt](plugins/git-graph/THIRD-PARTY-LICENSES.txt)。

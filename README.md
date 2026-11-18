# DeepSeek Chat H5

一个仿 DeepSeek App 的移动端聊天页面，使用**自己的 DeepSeek API Key** 聊天，对话自动保存到**自己的 GitHub 仓库**。纯静态前端，无需服务器、无需构建，可直接部署到 GitHub Pages 或任意静态托管。

## 功能

- 仿 DeepSeek App 的界面：左侧抽屉式历史记录、底部输入框、思考过程折叠、代码块复制
- 支持 `deepseek-chat` / `deepseek-reasoner`（R1 的思考过程单独展示）
- SSE 流式输出，可中途停止、可重新生成
- 每轮对话结束后自动保存：
  1. 调用模型总结不超过 12 字的标题
  2. 文件名 = `时间_标题.json`，例如 `2026-11-18_165012_浏览器流式输出.json`
  3. 通过 GitHub Contents API 提交到仓库指定目录
- 历史列表通过 GitHub **git tree API**（`GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1`）读取文件名生成，按时间倒序、按月分组
- 未配置 GitHub 时，对话暂存在浏览器本地，不会丢
- 支持深色 / 浅色 / 跟随系统

## 快速开始

```bash
# 任意静态服务器即可
python3 -m http.server 8080
# 打开 http://localhost:8080
```

首次打开会自动弹出「开始使用」配置框，填写两项即可：

### 1. DeepSeek API Key

在 <https://platform.deepseek.com/api_keys> 创建，形如 `sk-...`。API 地址默认 `https://api.deepseek.com`。

### 2. GitHub 存储

1. 新建一个仓库（建议 **Private**），并确保有目标分支（默认 `main`）
2. 创建 Fine-grained token：GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
   - Repository access：只勾选这个仓库
   - Permissions → Repository permissions → **Contents: Read and write**
3. 在设置里填入 Token、用户名/组织、仓库名、分支、目录（默认 `chats`）

点「测试连接」确认两项都正常。

## 部署到 GitHub Pages

1. 把本目录文件推到仓库（或单独建一个 pages 仓库）
2. Settings → Pages → Source 选择分支根目录
3. 手机 Safari/Chrome 打开地址，「添加到主屏幕」即可当 App 使用

> 页面是公开的，但 API Key 和 Token 只存在各自浏览器的 localStorage 里，不会随页面发布。首次在新设备打开需要重新填写。

## 存储格式

每个对话是一个 JSON 文件：

```json
{
  "id": "chats/2026-11-18_165012_浏览器流式输出.json",
  "title": "浏览器流式输出",
  "model": "deepseek-chat",
  "createdAt": "2026-11-18T08:50:12.000Z",
  "updatedAt": "2026-11-18T08:52:40.000Z",
  "messages": [
    { "role": "user", "content": "…", "time": "2026-11-18T08:50:12.000Z" },
    { "role": "assistant", "content": "…", "reasoning": "…", "time": "2026-11-18T08:50:14.000Z" }
  ]
}
```

- 标题只在首次保存时生成一次，之后续聊沿用文件名，不会重命名
- 同一秒内重名会自动加 `_1`、`_2` 后缀
- 在抽屉里点垃圾桶可从仓库删除该文件

## 文件结构

```
index.html            页面结构
styles.css            样式（深色/浅色）
app.js                全部逻辑：DeepSeek 流式请求、GitHub 读写、渲染
icon.svg / icon-180.png / icon-512.png / manifest.webmanifest   添加到主屏幕
```

## 说明

- DeepSeek API 与 GitHub API 都允许浏览器跨域直连，因此不需要任何代理服务
- 对话内容会以明文提交到你自己的仓库，仓库若是 Public 则所有人可见

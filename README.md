# Store DeepSeek Chat

一个仿 DeepSeek App 的聊天页面（桌面与手机自适应），使用**自己的 DeepSeek API Key** 聊天，对话自动保存到**自己的 GitHub 仓库**。纯静态前端，无需服务器、无需构建，可直接部署到 GitHub Pages 或任意静态托管。

**Store-Deepseek-Chat**: [https://winfirm.top/stored-deepseek-chat/](https://winfirm.top/stored-deepseek-chat/)

## 功能

- 参考 DeepSeek 官方 chat-demo 的界面：桌面常驻侧边栏（可收起）、移动端抽屉、居中的对话栏、卡片式输入框
- 输入框内只有 `DeepThink` / `Search` 两个开关，模型固定 `deepseek-flash`
- **DeepThink**：通过 `thinking: { type: "enabled" }` 开启思考，右侧可选 `reasoning_effort`：Low / High / Max（默认 High，每次开启都重置为 High）；思考过程实时展开、结束后折叠并显示耗时
- **Search**：先联网检索再把网页摘要作为上下文交给模型，回答带 [1] 引用，消息上方可展开查看来源
- 搜索走 DeepSeek 官方接口 `POST /v1/tools/search`，与聊天共用一个 API Key
- **两个开关默认关闭**，新建对话时复位；标题总结不开启思考，由 Flash 直接生成
- SSE 流式输出，可中途停止、可重新生成
- 每轮对话结束后自动保存：
  1. 调用模型总结不超过 12 字的标题
  2. 文件名 = `时间_标题.json`，例如 `2026-11-18_165012_浏览器流式输出.json`
  3. 通过 GitHub Contents API 提交到仓库指定目录
- 历史列表通过 GitHub **git tree API**（`GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1`）读取文件名生成，按时间倒序、按月分组
- 未配置 GitHub 时，对话暂存在浏览器本地，不会丢
- 支持深色 / 浅色 / 跟随系统

## 联网搜索

Search 开关使用 DeepSeek 官方文档中的网页搜索接口（<https://api-docs.deepseek.com/zh-cn/api/search>）：

```
POST https://api.deepseek.com/v1/tools/search
Authorization: Bearer <同一个 DeepSeek API Key>
{ "query": "...", "count": 5, "ori_question": "..." }
```

- 返回的 `summary`（长摘要）作为上下文交给模型，回答里用 `[1]` 标注来源
- 消息上方可展开「搜索到 N 个网页」，列表来自返回的 `title` / `site_name` / `url`
- 搜索失败或无结果时会提示并直接回答，不会中断对话
- 该接口按次计费，具体见官方指南 <https://api-docs.deepseek.com/zh-cn/guides/search>

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
>
> 想让聊天记录不公开，可以页面仓库保持 Public、记录仓库单独建一个 Private，在设置里填记录仓库即可。

## 存储格式

每个对话是一个 JSON 文件：

```json
{
  "id": "chats/2026-11-18_165012_浏览器流式输出.json",
  "title": "浏览器流式输出",
  "model": "deepseek-flash",
  "thinking": true,
  "effort": "high",
  "createdAt": "2026-11-18T08:50:12.000Z",
  "updatedAt": "2026-11-18T08:52:40.000Z",
  "messages": [
    { "role": "user", "content": "…", "time": "2026-11-18T08:50:12.000Z" },
    {
      "role": "assistant",
      "content": "…",
      "reasoning": "…",
      "thinkMs": 3200,
      "search": true,
      "sources": [{ "title": "…", "url": "https://example.com", "host": "example.com" }],
      "time": "2026-11-18T08:50:14.000Z"
    }
  ]
}
```

- `thinking` / `effort` 是整个对话的思考设置，打开历史对话时会一并恢复
- `sources` / `search` 只在开启 Search 的回复里出现
- 标题只在首次保存时生成一次，之后续聊沿用文件名，不会重命名
- 同一秒内重名会自动加 `_1`、`_2` 后缀
- 在侧边栏（手机为抽屉）里点垃圾桶可从仓库删除该文件

## 文件结构

```
index.html            页面结构
styles.css            样式（深色/浅色）
app.js                全部逻辑：DeepSeek 流式请求、GitHub 读写、渲染
icon.svg / icon-180.png / icon-512.png / manifest.webmanifest   添加到主屏幕
```

## 说明

- DeepSeek API 与 GitHub API 都允许浏览器跨域直连，因此不需要任何代理服务
- Markdown 渲染依赖 jsDelivr 上的 marked / DOMPurify；加载失败时退化为纯文本显示，聊天本身不受影响
- Search 每次会按官方计费规则消耗搜索调用次数；Key 无权限或额度不足时会提示「网页搜索暂不可用」并直接回答
- 对话内容会以明文提交到你自己的仓库，仓库若是 Public 则所有人可见

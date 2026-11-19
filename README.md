# Store DeepSeek Chat

一个仿 DeepSeek App 的聊天页面（桌面与手机自适应），使用**自己的 DeepSeek API Key** 聊天，对话自动保存到**自己的 GitHub 仓库**。纯静态前端，无需服务器、无需构建，可直接部署到 GitHub Pages 或任意静态托管。

**Store-Deepseek-Chat**: [https://chat.winfirm.top/](https://chat.winfirm.top/)

## 功能

- 参考 DeepSeek 官方 chat-demo 的界面：桌面常驻侧边栏（可收起）、移动端抽屉、居中的对话栏、卡片式输入框
- 输入框内只有 `DeepThink` / `Search` 两个开关，模型固定 `deepseek-flash`
- **DeepThink**：默认关闭（省 Token），通过 `thinking: { type: "enabled" }` + `reasoning_effort` 控制，右侧可选 Low / High / Max（默认 High，每次开启都重置为 High）；关闭时同时发 `thinking: disabled` 与 `reasoning_effort: "none"`（该参数默认 high 会重新打开思考，只发 disabled 不够）；思考过程实时展开、结束后折叠并显示耗时
- **Search**：先联网检索再把网页摘要作为上下文交给模型，回答带 [1] 引用，消息上方可展开查看来源
- **文件上传**：输入框回车键旁的回形针按钮，可一次选多个文件；上传后可单独删除，发送时以 `file` 内容块把 `file_id` 关联进对话，直接提问分析
- 搜索走 DeepSeek 官方接口 `POST /v1/tools/search`，与聊天共用一个 API Key
- **两个开关默认关闭**，新建对话复位；历史对话按保存时的开关状态恢复；标题总结不开启思考，由 Flash 直接生成
- SSE 流式输出，可中途停止、可重新生成
- 每轮对话结束后自动保存：
  1. 调用模型总结不超过 12 字的标题
  2. 文件名 = `时间_标题.json`，例如 `2026-11-18_165012_浏览器流式输出.json`
  3. 通过 GitHub Contents API 提交到仓库指定目录
- 历史列表通过 GitHub **git tree API**（`GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1`）读取文件名生成，按时间倒序、按月分组
- **标题可改**：点顶部标题进入编辑（Enter 保存、Esc 取消、焦点移走也会保存），自动生成的标题不合题意时直接改
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

## 文件上传

点击输入框左下角的回形针（回车键旁边）选择文件，也可以直接多选。上传时按扩展名选择 Files API 的 `purpose`：

| 类型 | 扩展名 | purpose | 单文件上限 |
| --- | --- | --- | --- |
| 图片 | jpg / jpeg / png / gif / webp | `user_data` | 64 MiB |
| 文档 | pdf / doc / docx / ppt / pptx | `rich_layout_recognition` | 100 MiB |
| 文本、表格、电子书 | txt / md / csv / json / 代码，xlsx / xls，epub / mobi | `user_data` | 32 MiB |

- 表单里 `purpose` 排在 `file` 之前（文档解析要求），上传用 XHR 展示百分比，文档解析期间显示「解析中…」
- 发送时把每个文件以 `{"type":"file","file_id":"file-api-..."}` 放进用户消息的 `content` 数组，与文字一起提交
- 点附件右侧的 × 移除：未发送的文件会同时调用 `DELETE /files/{file_id}`，不在账号里留垃圾；已发送的消息只做展示
- 每条消息最多 20 个文件（与「每个请求最多引用 20 个文档」一致），上传中不能发送
- 文件与 API Key 属于同一账号，默认不设有效期，历史对话重新打开后仍能引用；在 DeepSeek 账号里删除该文件后，旧对话再提问会返回 400
- 文档解析按页计费、对话引用按输入 Token 计费，见官方 [Files API](https://api-docs.deepseek.com/zh-cn/guides/files_api) 与 [文件解析](https://api-docs.deepseek.com/zh-cn/guides/document_parsing)
- 设置里的「文件存储」显示账号已用空间与文件数（`GET /files` 分页统计，10 分钟缓存，可手动刷新），超过 80% 标黄，上传成功后提醒一次；只做提示，不提供清理入口，避免误删导致历史对话失效

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
- 带附件的用户消息多一个 `files` 字段：`[{ "id": "file-api-…", "name": "report.pdf", "size": 1234, "kind": "doc", "purpose": "rich_layout_recognition" }]`，重新打开对话时用它还原附件并继续提问
- 标题只在首次保存时生成一次；手动改标题会按新标题写一个新文件（`时间_新标题.json` 并带上当前全部消息），成功后删除旧文件，所以文件名始终等于列表标题；新标题也会写回 JSON 的 `title`
- 同一秒内重名会自动加 `_1`、`_2` 后缀
- 在侧边栏（手机为抽屉）里点垃圾桶会先弹出自定义确认框（默认焦点在「取消」，Esc / 点遮罩也可取消），确认后才从仓库删除，删除不可恢复

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

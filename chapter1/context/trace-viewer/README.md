# Context Lab — 实验 1-1 轨迹查看器

无需前端依赖，读取真实实验记录，展示五组消融对照、逐轮模型上下文、工具执行与模型可见观测、原始 JSON、Token 比较和逐步回放。

在仓库根目录启动：

```bash
.venv/bin/python chapter1/context/trace_viewer.py
```

打开 <http://127.0.0.1:8761>。默认读取 `chapter1/context/validation/latest.json`；指定文件和端口：

```bash
.venv/bin/python chapter1/context/trace_viewer.py \
  --evidence chapter1/context/langfuse/releases/2026-10-22/evidence.json \
  --port 8761
```

点击实验卡片切换组；点击调用树查看节点；在“模型输入”里核对实际请求。在工具节点中，“本地真实执行结果”与“下一轮实际发送的工具消息”并列展示，帮助理解无历史或空观测消融。方向键逐步查看，自动回放按两秒一节点播放已记录的过程，不重发模型请求。URL hash 可定位实验组、节点和详情页签。

服务仅监听 loopback，仅提供四个固定界面资源与 `/api/evidence`，不提供仓库目录列表或 `.env`。界面没有外部资源和运行时依赖。

整组耗时、调用与 Token 数据直接来自证据。证据没有记录每次推理的起止时间，因此不展示虚构的逐轮耗时或时间瀑布。工具结果的“模型可见”以**下一轮实际请求**中相应 `tool_call_id` 消息为依据；最后一轮已执行但没有下一次推理的工具不会被误标为可见。

运行数据映射测试（Node.js 18+）：

```bash
node --test chapter1/context/trace-viewer/model.test.mjs
```

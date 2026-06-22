---
title: Canvas类详细解析
date: 2026-06-22 10:00:00
categories: RAG
tags:
  - rag
  - ragflow
  - agent
---

# Canvas 类详细解析

## 概述

`canvas.py` 是 RAGFlow Agent 系统的核心执行引擎，定义了 **Graph**（基础图执行器）和 **Canvas**（完整的 Agent 画布）两个类。整个文件共 848 行，实现了：

- **DSL 驱动的组件图**的加载、执行和序列化
- **变量引用系统**：`{component_id@variable}` 语法，支持跨组件取值和赋值
- **异步执行引擎**：基于 `asyncio` + `ThreadPoolExecutor` 的并发调度
- **流式消息输出**：支持 TTS（文字转语音）的实时流式响应
- **任务取消机制**：基于 Redis 的取消信号传递
- **异常处理与路径跳转**：运行时错误可触发 goto 跳转或默认值回退

文件路径：`agent/canvas.py`

---

## 1. 依赖关系

```python
import asyncio, base64, datetime, inspect, json, logging, re, time
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from functools import partial
from typing import Any, Union, Tuple

from agent.component import component_class          # 动态组件工厂
from agent.component.base import ComponentBase         # 组件基类
from agent.dsl_migration import normalize_chunker_dsl  # DSL 版本迁移
from api.db.services.file_service import FileService   # 文件解析服务
from api.db.services.llm_service import LLMBundle      # LLM 调用封装
from api.db.services.task_service import has_canceled  # 取消状态查询
from api.db.joint_services.tenant_model_service import get_tenant_default_model_by_type
from common.constants import LLMType
from common.misc_utils import get_uuid, hash_str2int
from common.exceptions import TaskCanceledException
from rag.prompts.generator import chunks_format
from rag.utils.redis_conn import REDIS_CONN
from rag.utils.tts_cache import synthesize_with_cache
```

关键依赖说明：
- **`component_class()`**：动态组件工厂函数，从 `agent.component`、`agent.tools`、`rag.flow` 三个模块中按类名查找并返回组件类
- **`normalize_chunker_dsl()`**：DSL 版本兼容层，将旧版 `Splitter`/`HierarchicalMerger` 等命名自动迁移到 `TokenChunker`/`TitleChunker`
- **`LLMBundle`**：LLM 调用的统一封装，绑定 tenant_id 和模型配置
- **`partial`**：用于标记"尚未完成的流式输出"，是一个核心的惰性求值模式

---

## 2. 类层次结构

```
Graph                    ← 基础图：DSL 加载、变量系统、取消机制
  └── Canvas             ← Agent 画布：完整执行引擎、历史、检索、TTS、文件处理

ComponentBase            ← 组件基类（在 component/base.py 中）
  └── Begin, Retrieval, Generate, Message, Switch, Loop, Iteration, ...  ← 具体组件
```

`Graph` 是抽象基类，定义了图的基本操作，其 `run()` 方法只是 `raise NotImplementedError()`。**所有真正的执行逻辑都在 `Canvas` 中**。

---

## 3. Graph 类（第 43-282 行）

### 3.1 DSL 数据结构

Graph/Canvas 的核心数据模型是一个称为 **DSL** 的字典结构：

```python
dsl = {
    "components": {        # 组件映射表，key 为组件实例ID
        "begin": {
            "obj": {       # 组件对象及其参数
                "component_name": "Begin",
                "params": {},
            },
            "downstream": ["answer_0"],   # 下游组件 ID 列表
            "upstream": [],               # 上游组件 ID 列表
        },
        "retrieval_0": {
            "obj": { "component_name": "Retrieval", "params": {} },
            "downstream": ["generate_0"],
            "upstream": ["answer_0"],
        },
        # ... 更多组件
    },
    "history": [],         # 对话历史
    "path": ["begin"],     # 当前执行路径（组件 ID 的有序列表）
    "retrieval": [         # 检索结果栈
        {"chunks": [], "doc_aggs": []}
    ],
    "globals": {           # 全局变量
        "sys.query": "",
        "sys.user_id": tenant_id,
        "sys.conversation_turns": 0,
        "sys.files": []
    }
}
```

### 3.2 `__init__` 方法

```python
def __init__(self, dsl: str, tenant_id=None, task_id=None, custom_header=None):
    self.path = []
    self.components = {}
    self.error = ""
    self.dsl = normalize_chunker_dsl(json.loads(dsl))  # ① DSL迁移
    self._tenant_id = tenant_id
    self.task_id = task_id if task_id else get_uuid()
    self.custom_header = custom_header
    self._thread_pool = ThreadPoolExecutor(max_workers=5)  # ② 线程池
    self.load()
```

执行流程：
1. **DSL 迁移**：`normalize_chunker_dsl()` 自动将旧版命名转换（如 `Splitter` → `TokenChunker`）
2. **线程池**：创建 `max_workers=5` 的线程池，用于执行同步阻塞的组件 `_invoke()`
3. **加载**：调用 `load()` 实例化所有组件

### 3.3 `load()` 方法（第 96-111 行）

```python
def load(self):
    self.components = self.dsl["components"]
    cpn_nms = set([])
    for k, cpn in self.components.items():
        cpn_nms.add(cpn["obj"]["component_name"])
        param = component_class(cpn["obj"]["component_name"] + "Param")()
        param.update(cpn["obj"]["params"])
        try:
            param.check()
        except Exception as e:
            raise ValueError(self.get_component_name(k) + f": {e}")
        cpn["obj"] = component_class(cpn["obj"]["component_name"])(self, k, param)
    self.path = self.dsl["path"]
```

**这是 DSL 编译的核心**，分三步：

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | `component_class(name + "Param")()` | 动态加载参数类（如 `RetrievalParam`），实例化 |
| 2 | `param.update(params)` → `param.check()` | 将 JSON 参数写入对象并进行校验 |
| 3 | `component_class(name)(self, k, param)` | 动态加载组件类（如 `Retrieval`），传入 canvas 引用、ID 和参数 |

**设计要点**：组件实例化时接收 `self`（即 Graph/Canvas 本身），因此每个组件都持有对图的反向引用（`self._canvas`），可以访问全局变量、其他组件输出等。

### 3.4 变量引用系统

RAGFlow 的 DSL 使用一种模板语法引用其他组件的输出：

```
{component_id@variable_name.sub_field}
```

支持的变量前缀：
- `sys.*` — 系统全局变量（如 `sys.query`）
- `env.*` — 环境变量/用户定义变量（如 `env.temperature`）
- `cid@var` — 另一个组件的输出（如 `retrieval_0@content`）

#### `get_value_with_variable()`（第 168-193 行）

替换字符串中的变量引用，返回最终值：

```python
pat = re.compile(r"\{* *\{([a-zA-Z:0-9]+@[A-Za-z0-9_.-]+|sys\.[A-Za-z0-9_.]+|env\.[A-Za-z0-9_.]+)\} *\}*")
```

正则匹配 `{xxx}` 或 `{{xxx}}` 两种格式的变量引用，然后逐段替换。

特殊处理：
- 如果值是 `partial`（惰性生成器），则消费所有 chunk 拼接为字符串
- 如果值是字符串则直接替换
- 其他类型转为 JSON 字符串

#### `get_variable_value()`（第 195-210 行）

```python
def get_variable_value(self, exp: str) -> Any:
    exp = exp.strip("{").strip("}").strip(" ").strip("{").strip("}")
    if exp.find("@") < 0:
        return self.globals[exp]                  # sys.* 或 env.* 全局变量
    cpn_id, var_nm = exp.split("@")
    cpn = self.get_component(cpn_id)
    parts = var_nm.split(".", 1)
    root_key = parts[0]
    rest = parts[1] if len(parts) > 1 else ""
    root_val = cpn["obj"].output(root_key)        # 调用组件的 output() 方法
    if not rest:
        return root_val
    return self.get_variable_param_value(root_val, rest)  # 深度取值
```

**取值路径**：从组件对象的 `_param.outputs` 字典中按 key 取顶层值，再按 `.` 分隔的路径做深度访问。

#### `get_variable_param_value()`（第 212-239 行）

支持字典、列表（索引）、对象属性三种深度访问方式：

```python
for key in path.split('.'):
    if isinstance(cur, dict):
        cur = cur.get(key)        # 字典按键访问
    elif isinstance(cur, (list, tuple)):
        cur = cur[int(key)]       # 列表按索引访问
    else:
        cur = getattr(cur, key, None)  # 对象按属性访问
```

#### `set_variable_value()` / `set_variable_param_value()`（第 241-271 行）

写回变量值，同样支持深度路径写入。

### 3.5 序列化：`__str__()`（第 113-132 行）

```python
def __str__(self):
    self.dsl["path"] = self.path
    self.dsl["task_id"] = self.task_id
    dsl = {"components": {}}
    for k in self.dsl.keys():
        if k in ["components"]:
            continue
        dsl[k] = deepcopy(self.dsl[k])
    for k, cpn in self.components.items():
        dsl["components"][k] = {}
        for c in cpn.keys():
            if c == "obj":
                dsl["components"][k][c] = json.loads(str(cpn["obj"]))
            else:
                dsl["components"][k][c] = deepcopy(cpn[c])
    return json.dumps(dsl, ensure_ascii=False)
```

将运行时状态序列化回 JSON 字符串。关键点：
- **组件对象**通过 `str(cpn["obj"])` 序列化，即调用 `ComponentBase.__str__()`，输出 `{"component_name": "...", "params": {...}}`
- 其他元数据（upstream、downstream、parent_id 等）使用 `deepcopy` 防止引用污染

### 3.6 取消机制（第 273-282 行）

基于 Redis 实现，不使用数据库轮询：

```python
def is_canceled(self) -> bool:
    return has_canceled(self.task_id)  # 检查 Redis key: {task_id}-cancel

def cancel_task(self) -> bool:
    REDIS_CONN.set(f"{self.task_id}-cancel", "x")  # 设置取消信号
```

这是一个**协作式取消**模式：被取消的任务不会立即被杀死，而是在每次 `is_canceled()` 检查点主动抛出 `TaskCanceledException`。

---

## 4. Canvas 类（第 285-848 行）

Canvas 继承 Graph，是完整的 Agent 执行引擎。

### 4.1 `__init__` 方法（第 287-298 行）

```python
def __init__(self, dsl: str, tenant_id=None, task_id=None, canvas_id=None, custom_header=None):
    self.globals = {
        "sys.query": "",
        "sys.user_id": tenant_id,
        "sys.conversation_turns": 0,
        "sys.files": [],
        "sys.history": [],
        "sys.date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    }
    self.variables = {}
    super().__init__(dsl, tenant_id, task_id, custom_header=custom_header)
    self._id = canvas_id
```

新增属性：

| 属性 | 类型 | 说明 |
|------|------|------|
| `globals` | `dict` | 全局变量，包含 `sys.*` 和 `env.*` 两种命名空间 |
| `variables` | `dict` | 用户自定义的环境变量定义（类型、默认值等） |
| `_id` | `str` | Canvas 持久化 ID |
| `history` | `list[tuple]` | 对话历史，格式为 `[(role, content), ...]` |
| `retrieval` | `list[dict]` | 检索结果栈，每个元素为 `{"chunks": {}, "doc_aggs": {}}` |
| `memory` | `list[tuple]` | 长期记忆，格式为 `[(user_msg, assist_msg, summary), ...]` |

### 4.2 `load()` 方法（第 300-324 行）

```python
def load(self):
    super().load()
    self.history = self.dsl["history"]
    if "globals" in self.dsl:
        self.globals = self.dsl["globals"]
        # 确保必要的 key 存在
        if "sys.history" not in self.globals:
            self.globals["sys.history"] = []
        if "sys.date" not in self.globals:
            self.globals["sys.date"] = datetime.datetime.now(...)
    # ...
    self.retrieval = self.dsl["retrieval"]
    self.memory = self.dsl.get("memory", [])
```

从 DSL 恢复持久化的全局变量和历史记录，同时确保必要字段存在（向后兼容）。

### 4.3 `reset()` 方法（第 332-373 行）

```python
def reset(self, mem=False):
    super().reset()
    if not mem:
        self.history = []
        self.retrieval = []
        self.memory = []
    for k in self.globals.keys():
        if k.startswith("sys."):
            # 按类型重置为默认值（"" / 0 / 0.0 / [] / {}）
        if k.startswith("env."):
            # 按用户定义的变量类型重置
```

重置整个画布状态。`mem=True` 时保留对话历史和检索结果（用于同一对话的多轮交互）。

### 4.4 核心执行引擎：`run()` 方法（第 375-669 行）

**这是整个文件最核心的方法**，约 300 行。它是一个 **async generator**，通过 `yield` 输出实时事件流。

#### 整体执行流程图

```
用户输入 (query, files, inputs)
    │
    ▼
┌──────────────────────┐
│  1. 初始化阶段         │
│  - 设置 sys.date      │
│  - 处理 Webhook 输入   │
│  - 处理文件上传         │
│  - conversation_turns++│
│  - 取消检查            │
│  - yield: workflow_started│
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  2. 执行循环 (while)    │
│  ┌────────────────┐   │
│  │ yield: node_started│
│  │ (每个节点)         │
│  │ _run_batch()      │   │  ← 并发执行一组节点
│  │   ├─ begin 节点    │   │
│  │   ├─ 中间节点      │   │
│  │   └─ message 节点  │   │
│  │ post-processing   │   │
│  │   ├─ message → 流式│
│  │   ├─ categorize →  │   │
│  │   ├─ switch → 分支  │
│  │   ├─ iteration →   │
│  │   └─ loop → 循环   │
│  │ 错误处理            │   │
│  │ 路径推进            │   │
│  └────────────────┘   │
│  检查 UserFillUp       │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  3. 结束阶段          │
│  yield: workflow_finished│
└──────────────────────┘
```

#### 事件装饰器（第 414-423 行）

```python
def decorate(event, dt):
    nonlocal created_at
    return {
        "event": event,
        "message_id": self.message_id,
        "created_at": created_at,
        "task_id": self.task_id,
        "data": dt
    }
```

所有 yield 出去的事件都经过此装饰器，统一添加 `message_id`、`task_id`、`created_at` 等元数据。

事件类型：
| 事件 | 说明 |
|------|------|
| `workflow_started` | 工作流开始执行 |
| `node_started` | 节点开始执行 |
| `node_finished` | 节点执行完成（含输入、输出、耗时） |
| `message` | 流式消息块（支持 `start_to_think`/`end_to_think` 标记） |
| `message_end` | 消息结束（含参考文档、状态） |
| `user_inputs` | 需要用户补充输入（UserFillUp 交互） |
| `workflow_finished` | 工作流执行完成 |

#### 输入初始化（第 376-412 行）

```python
self.add_user_input(kwargs.get("query"))
# ...
for k in kwargs.keys():
    if k in ["query", "user_id", "files"] and kwargs[k]:
        if k == "files":
            self.globals[f"sys.{k}"] = await self.get_files_async(kwargs[k], ...)
        else:
            self.globals[f"sys.{k}"] = kwargs[k]
self.globals["sys.conversation_turns"] += 1
```

- 文件上传通过 `FileService` 异步解析（支持图片→base64、文档→文本提取）
- 支持 Webhook 模式的 Begin 组件，直接注入 payload

#### 核心执行循环（第 502-651 行）

```python
idx = len(self.path) - 1     # 当前批次的起始索引
while idx < len(self.path):  # 直到没有新节点加入
    to = len(self.path)       # 当前批次的结束索引
    # ① yield node_started 事件
    for i in range(idx, to):
        yield decorate("node_started", {...})

    # ② 批量并发执行
    await _run_batch(idx, to)

    # ③ post-processing：逐节点处理输出、错误、路径推进
    for i in range(idx, to):
        # ... 处理 Message 流式输出
        # ... 处理错误和异常跳转
        # ... 推进路径（下游节点加入 self.path）

    # ④ UserFillUp 检查
    if any(component_name == "userfillup" for ...):
        yield decorate("user_inputs", {...})
        return  # 等待用户输入
    idx = to
```

##### `_run_batch` 并发执行器（第 437-484 行）

```python
async def _run_batch(f, t):
    loop = asyncio.get_running_loop()
    tasks = []
    max_concurrency = 5
    sem = asyncio.Semaphore(max_concurrency)  # 限制最大并发数为 5

    async def _invoke_one(cpn_obj, sync_fn, call_kwargs, use_async):
        async with sem:
            if use_async:
                await cpn_obj.invoke_async(...)   # 异步调用
            else:
                await loop.run_in_executor(       # 线程池调用
                    self._thread_pool,
                    partial(sync_fn, ...)
                )
    # ...
    await asyncio.gather(*tasks)
```

**并发策略**：
- 使用 `asyncio.Semaphore(5)` 限制最大并发数
- 异步组件（有 `_invoke_async` 协程）直接在事件循环中执行
- 同步组件通过 `run_in_executor` 投递到线程池执行
- 每个 batch 包含从 `idx` 到 `to` 的所有节点，并发执行

##### 依赖检查（第 466-470 行）

```python
for _, ele in cpn.get_input_elements().items():
    if isinstance(ele, dict) and ele.get("_cpn_id") and \
       ele.get("_cpn_id") not in self.path[:i]:
        self.path.pop(i)   # 依赖未就绪，从路径中移除
        t -= 1
        break
```

在执行前检查每个节点的输入依赖：如果某个输入引用的组件尚未执行完，则将该节点从当前批次中移除，等待下一轮。

#### Message 流式输出（第 518-577 行）

```python
if cpn_obj.component_name.lower() == "message":
    if isinstance(cpn_obj.output("content"), partial):
        stream = cpn_obj.output("content")()
        # 处理流式输出，支持:
        # - <think></think> 标签 → start_to_think / end_to_think
        # - TTS 音频合成（每 16 个字符触发一次）
        # - audio_binary 字段传递 base64 编码的音频
```

Message 组件是唯一产生用户可见输出的组件。核心设计：
- **`partial` 模式**：`partial` 是 Python 的 `functools.partial`，这里用作"惰性生成器"标记——如果 output 值是 `partial` 类型，表示这是一个需要被消费的生成器
- **流式消费**：逐 chunk 消费生成器，通过 `yield decorate("message", ...)` 实时推送给前端
- **TTS 集成**：Message 配置 `auto_play=True` 时，自动调用 TTS 模型将文本转为语音

#### 路径推进逻辑（第 601-629 行）

不同类型的组件有不同的下游推进逻辑：

```python
# 迭代/循环内部项结束 → 回到父迭代器
if cpn_obj.component_name.lower() in ("iterationitem","loopitem") and cpn_obj.end():
    iter = cpn_obj.get_parent()
    _extend_path(self.get_component(cpn["parent_id"])["downstream"])

# 分类/分支组件 → 使用 _next 输出决定路径
elif cpn_obj.component_name.lower() in ["categorize", "switch"]:
    _extend_path(cpn_obj.output("_next"))

# 迭代/循环开始 → 进入内部第一个节点
elif cpn_obj.component_name.lower() in ("iteration", "loop"):
    _append_path(cpn_obj.get_start())

# 退出循环 → 到循环体的下游
elif cpn_obj.component_name.lower() == "exitloop":
    _extend_path(self.get_component(cpn["parent_id"])["downstream"])

# 有父组件的叶子节点 → 回到父组件的 start
elif not cpn["downstream"] and cpn_obj.get_parent():
    _append_path(cpn_obj.get_parent().get_start())

# 默认 → 推进到 downstream 列表
else:
    _extend_path(cpn["downstream"])
```

#### 异常处理（第 579-589 行）

```python
if cpn_obj.error():
    ex = cpn_obj.exception_handler()
    if ex and ex["goto"]:
        self.path.extend(ex["goto"])       # 跳转到指定的异常处理路径
        other_branch = True
    elif ex and ex["default_value"]:
        yield decorate("message", {"content": ex["default_value"]})
        # 输出默认值并继续
    else:
        self.error = cpn_obj.error()       # 标记全局错误，终止执行
```

### 4.5 TTS 文字转语音（第 683-717 行）

```python
def tts(self, tts_mdl, text):
    def clean_tts_text(text: str) -> str:
        # 清理控制字符、emoji、多余空格
        # 截断到 500 字符
    if not tts_mdl or not text:
        return None
    text = clean_tts_text(text)
    return synthesize_with_cache(tts_mdl, text)
```

TTS 合成逻辑：
1. **文本清洗**：移除控制字符、emoji，标准化空格
2. **长度限制**：最多 500 字符
3. **缓存**：通过 `synthesize_with_cache` 避免重复合成相同文本
4. **流式触发**：在 Message 的流式输出中，每累积 16 个字符触发一次 TTS

### 4.6 文件处理（第 752-778 行）

```python
async def get_files_async(self, files, layout_recognize=None) -> list[str]:
    # 图片文件 → image_to_base64 (data:image/...;base64,...)
    # 文档文件 → FileService.parse (文本提取)
    tasks = []
    for file in files:
        if file["mime_type"].find("image") >= 0:
            tasks.append(loop.run_in_executor(..., image_to_base64, file))
        else:
            tasks.append(loop.run_in_executor(..., parse_file, file))
    return await asyncio.gather(*tasks)
```

提供异步和同步两个版本的接口：
- `get_files_async()`：在事件循环中异步执行
- `get_files()`：同步包装器，从同步组件 invoke 路径调用时使用

### 4.7 Tool Use 回调（第 780-802 行）

```python
def tool_use_callback(self, agent_id, func_name, params, result, elapsed_time=None):
    # 记录每个组件调用工具的情况到 Redis
    # key: {task_id}-{message_id}-logs, TTL: 10分钟
    # 结构: [{"component_id": ..., "trace": [{path, tool_name, arguments, result, elapsed_time}]}]
```

用于 AgentWithTools 组件的工具调用追踪，结果存储在 Redis 中供前端展示。

### 4.8 参考文档管理（第 804-838 行）

```python
def add_reference(self, chunks, doc_infos):
    # 去重后添加到 retrieval 栈的最顶层
    r = self.retrieval[-1]
    for ck in chunks_format({"chunks": chunks}):
        cid = hash_str2int(ck["id"], 500)
        if cid not in r:
            r["chunks"][cid] = ck
    for doc in doc_infos:
        if doc["doc_name"] not in r:
            r["doc_aggs"][doc["doc_name"]] = doc

def get_reference(self):
    return self.retrieval[-1] if self.retrieval else {"chunks": {}, "doc_aggs": {}}
```

检索到的文档块和聚合信息存储在 `retrieval` 栈中，用于构建最终的引用列表。

### 4.9 对话历史管理（第 719-732 行）

```python
def get_history(self, window_size):
    # 返回最近 window_size 轮的对话
    # window_size <= 0 返回空列表

def add_user_input(self, question):
    self.history.append(("user", question))
    self.globals["sys.history"].append(f"{self.history[-1][0]}: {self.history[-1][1]}")
```

历史记录是双写的：同时保存在 `self.history` 和 `self.globals["sys.history"]` 中。

---

## 5. 组件执行流程（component/base.py 补充）

Canvas 不直接调用组件的业务逻辑，而是通过 `ComponentBase` 定义的标准接口：

### invoke 调用链

```
Canvas._run_batch()
  → ComponentBase.invoke(**kwargs)         # 同步入口
    → set_output("_created_time", ...)
    → _invoke(**kwargs)                    # 业务逻辑
    → set_output("_elapsed_time", ...)
    → return output()

Canvas._run_batch()
  → ComponentBase.invoke_async(**kwargs)   # 异步入口
    → check_if_canceled()
    → _invoke_async(**kwargs) 或 _invoke()
    → set_output("_elapsed_time", ...)
    → return output()
```

### 输入解析（`get_input()`）

```python
def get_input(self, key=None):
    for var, o in self.get_input_elements().items():
        v = self.get_param(var)
        if isinstance(v, str) and self._canvas.is_reff(v):
            self.set_input_value(var, self._canvas.get_variable_value(v))
        elif isinstance(v, str) and re.search(self.variable_ref_patt, v):
            elements = self.get_input_elements_from_text(v)
            kv = {k: e.get('value', '') for k, e in elements.items()}
            self.set_input_value(var, self.string_format(v, kv))
        else:
            self.set_input_value(var, v)
    return res
```

输入解析的三种路径：
1. **纯变量引用**（如 `"retrieval_0@content"`）→ 直接取值
2. **模板字符串**（如 `"查询结果：{retrieval_0@content}"`）→ 解析变量后格式化
3. **常量值**→ 直接使用

---

## 6. DSL 迁移机制（dsl_migration.py）

`normalize_chunker_dsl()` 实现了 DSL 的向后兼容：

```python
COMPONENT_RENAMES = {
    "Splitter": "TokenChunker",
    "HierarchicalMerger": "TitleChunker",
    "PDFGenerator": "DocGenerator",
}
NODE_TYPE_RENAMES = {
    "splitterNode": "chunkerNode",
}
```

迁移范围：
| 迁移目标 | 说明 |
|----------|------|
| `components` 的 key | `Splitter:abc` → `TokenChunker:abc` |
| `obj.component_name` | `Splitter` → `TokenChunker` |
| `downstream`/`upstream` ID | 所有旧 ID 替换为新 ID |
| `parent_id` | 指向旧 ID 的替换为新 ID |
| `path` | 路径中的旧 ID 替换 |
| `graph.nodes` | node ID、parentId、type、label、name 全面更新 |
| `graph.edges` | source、target、id 更新 |
| 变量引用中的 ID | 模板 `{Splitter:abc@var}` → `{TokenChunker:abc@var}` |

---

## 7. 并发模型总结

```
                asyncio Event Loop (主线程)
               ┌─────────────────────────────┐
               │                             │
               │  Canvas.run() [async gen]   │
               │       │                     │
               │  _run_batch() [coroutine]   │
               │       │                     │
               │  asyncio.gather(            │
               │    Semaphore(5)              │
               │    ├─ invoke_async()        │ ← 异步组件直接 await
               │    ├─ run_in_executor(...)  │ ← 同步组件→线程池
               │    ├─ run_in_executor(...)  │
               │    └─ ...                   │
               │       │                     │
               │  yield decorate(event)      │ ← 事件流输出
               │                             │
               └──────────┬──────────────────┘
                          │
              ThreadPoolExecutor(max_workers=5)
               ┌─────────────────────────────┐
               │  Worker-1: LLM API call     │
               │  Worker-2: Retrieval query  │
               │  Worker-3: File parse       │
               │  Worker-4: TTS synthesis    │
               │  Worker-5: (idle)           │
               └─────────────────────────────┘
```

关键设计决策：
1. **异步优先**：主执行循环是 async generator，支持流式输出和并发执行
2. **线程池隔离**：同步阻塞操作（LLM HTTP 调用、文件 I/O）在线程池中执行，不阻塞事件循环
3. **信号量限流**：`Semaphore(5)` 限制并发组件数，防止资源耗尽
4. **协作式取消**：关键检查点处调用 `is_canceled()` 抛出异常终止

---

## 8. 关键设计模式

### 8.1 Partial 惰性求值

`functools.partial` 在 RAGFlow 中被用作**流式输出句柄**：

```python
# 组件设置输出为一个 partial（包装了生成器/迭代器）
cpn_obj.set_output("content", partial(iter_chunks, generator))

# Canvas 检测到 partial，逐 chunk 消费
if isinstance(cpn_obj.output("content"), partial):
    stream = cpn_obj.output("content")()
    for m in stream:
        yield decorate("message", {"content": m})
    cpn_obj.set_output("content", _m)  # 最终替换为完整字符串
```

这允许 Message 组件先产出完整的 `node_finished` 事件，而内容通过后续的 `message` 事件逐步推送。

### 8.2 路径驱动的执行模型

Canvas 不使用显式的拓扑排序（如 BFS/DFS），而是采用**增量路径追加**模型：

- `self.path` 是一个有序列表，记录将要执行的组件 ID
- 每个组件执行完成后，其 `downstream` 被追加到 path 末尾
- 特殊组件（Switch、Categorize、Iteration、Loop）有自定义的路径推进逻辑
- 依赖检查确保引用的上游组件已执行

### 8.3 DSL 序列化与组件实例的双向同步

```
JSON DSL (字符串)                   运行时对象
  ┌──────────┐                    ┌──────────┐
  │ dsl dict │  ─── load() ───→  │ components│
  │  (JSON)  │                    │  (dict)   │
  │          │  ←── __str__() ── │  .obj     │
  └──────────┘                    │  (实例)   │
                                  └──────────┘
```

`load()` 时从 JSON 创建组件实例，`__str__()` 时将组件实例序列化回 JSON。

---

## 9. 交互流程示例

以最简单的 RAG 流程为例：`Begin → Retrieval → Generate → Message`

```
1. Client 发送: {query: "什么是RAG?", files: [...]}
2. Canvas.run() 启动
3. self.path = ["begin"]
4. Batch 0: 执行 Begin 组件
   - 将 query 写入 sys.query
   - 将 files 解析后写入 sys.files
   - downstream = ["retrieval_0"]
5. self.path = ["begin", "retrieval_0"]
6. Batch 1: 执行 Retrieval 组件
   - 读取 sys.query
   - 查询向量数据库，返回 chunks
   - downstream = ["generate_0"]
7. self.path = ["begin", "retrieval_0", "generate_0"]
8. Batch 2: 执行 Generate 组件
   - 读取 retrieval_0@chunks 和 sys.query
   - 构建 Prompt，调用 LLM
   - downstream = ["message_0"]
9. self.path = [..., "message_0"]
10. Batch 3: 执行 Message 组件（流式）
    - yield message 事件（逐 token）
    - yield message_end 事件
11. yield workflow_finished
```

---

## 10. 主要组件类型一览

| 组件名 | 文件 | 功能 |
|--------|------|------|
| `Begin` | `begin.py` | 工作流入口，定义模式（Chat/Agent/Webhook）和输入参数 |
| `Message` | `message.py` | 输出消息给用户，支持流式 + TTS |
| `LLM` | `llm.py` | 通用 LLM 调用组件 |
| `AgentWithTools` | `agent_with_tools.py` | Agent + 工具调用（Function Calling） |
| `Retrieval` | （在 rag/flow 中） | 知识库检索 |
| `Generate` | （在 rag/flow 中） | RAG 生成回答 |
| `Categorize` | `categorize.py` | 多路分类路由 |
| `Switch` | `switch.py` | 条件分支 |
| `Iteration`/`IterationItem` | `iteration.py`/`iterationitem.py` | 迭代执行 |
| `Loop`/`LoopItem`/`ExitLoop` | `loop.py`/`loopitem.py`/`exit_loop.py` | 循环执行 |
| `UserFillUp` | `fillup.py` | 暂停等待用户补充输入 |
| `VariableAssigner` | `variable_assigner.py` | 变量赋值 |
| `VariableAggregator` | `variable_aggregator.py` | 变量聚合 |
| `DocGenerator` | `docs_generator.py` | 文档生成 |
| `ExcelProcessor` | `excel_processor.py` | Excel 处理 |
| `Browser` | `browser.py` | 网页浏览/爬取 |
| `Invoke` | `invoke.py` | 调用其他画布/工作流 |
| `DataOperations` | `data_operations.py` | 数据转换操作 |
| `StringTransform` | `string_transform.py` | 字符串转换 |
| `ListOperations` | `list_operations.py` | 列表操作 |

---

## 11. 关键配置与限制

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `_thread_pool.max_workers` | 5 | 线程池大小，控制同步组件并发数 |
| `Semaphore(5)` | 5 | 异步信号量，控制组件并发执行数 |
| `MAX_CONCURRENT_CHATS` | 10 | 环境变量，全局并发对话限制 |
| `COMPONENT_EXEC_TIMEOUT` | 600s | 环境变量，单组件执行超时 |
| TTS 缓冲区 | 16 字符 | 流式 TTS 触发的字符累积阈值 |
| TTS 最大文本长度 | 500 字符 | 单次 TTS 合成的最大文本 |
| Tool use logs TTL | 10 分钟 | Redis 中工具调用日志过期时间 |
| `PARAM_MAXDEPTH` | （settings） | 参数嵌套最大深度 |

---

## 12. 线程安全与注意事项

1. **组件状态隔离**：每个组件的 `_param.inputs` 和 `_param.outputs` 是独立的，但通过 Canvas 的变量系统可以读写其他组件的输出
2. **并发写入冲突**：多个组件并发执行时，如果同时 `set_variable_value` 写入同一组件的同一 output key，可能存在竞态条件（实际使用中很少出现，因为组件依赖关系天然避免了大部分冲突）
3. **事件循环绑定**：`get_files_async` 必须在运行中的事件循环内调用，`get_files()` 同步包装器通过 `asyncio.run_coroutine_threadsafe` 处理跨线程场景
4. **Redis 依赖**：取消机制、工具调用日志都依赖 Redis，Redis 不可用时这些功能会静默失败（通过 try/except 处理）

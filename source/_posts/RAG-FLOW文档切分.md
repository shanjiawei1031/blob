---
title: RAG FLOW文档切分
date: 2026-06-21 10:00:00
categories: RAG
tags:
  - rag
  - ragflow
  - chunking
---

# RAGFlow 文档切分逻辑详解

## 整体架构

文档切分是 RAGFlow 检索管线中最核心的环节。RAGFlow 中有两套切分实现，共享底层算法：

```
用户上传文档
    │
    ▼
┌─ rag/app/naive.py::chunk()        ◄── 经典路径，文档首次上传
│        │
│        ▼
│   deepdoc/parser/*  解析文档 → sections 列表
│        │
│        ▼
│   rag/nlp/__init__.py::naive_merge()      ← 核心合并算法
│        │
│        ▼
│   rag/nlp/__init__.py::tokenize_chunks()  ← 最终 token 化
│
└─ rag/flow/chunker/token_chunker.py::TokenChunker  ◄── Pipeline 组件路径
         │
         ▼
    _build_json_chunks()
    → _merge_text_chunks_by_token_size()
    → _finalize_json_chunks()
```

**两条路径的底层合并逻辑完全相同**，区别在于：

| 维度 | `naive.py::chunk()` | `TokenChunker` |
|------|---------------------|----------------|
| 定位 | 一体式函数 | Pipeline 组件 |
| 流程 | 解析 + 合并 + token 化一把梭 | 拆成多个阶段，可被 Agent 画布编排 |
| 适用 | 文档首次上传 | Agent 工作流中的切分节点 |

---

## 完整数据流

```
原始文档 (PDF/Word/Markdown/...)
    │
    ▼
deepdoc 解析器
    │  输出: sections = [(text, position_tag), ...]
    │
    ▼
┌── naive_merge() ──────────────────────────────────┐
│                                                    │
│   遍历 sections，逐段累计 token 数                   │
│   到达 chunk_token_num 阈值时切出新 chunk            │
│   如有 overlap，新 chunk 头部带上旧 chunk 的尾部     │
│   如有自定义分隔符，直接按分隔符切分（跳过合并）      │
│                                                    │
│   输出: chunks = ["文本块1", "文本块2", ...]         │
└────────────────────────────────────────────────────┘
    │
    ▼
tokenize_chunks()
    │  - 去掉 PDF 位置标签 @@...##
    │  - 调用 rag_tokenizer.tokenize() 做分词
    │  - 生成 coarse tokens (content_ltks) 和 fine-grained tokens (content_sm_ltks)
    │  - 如有 child_delimiters，对每个 chunk 做二次切分
    │
    ▼
最终输出 (存入 ES/Infinity):
[
    {
        "content_with_weight": "文本块1",
        "content_ltks": ["token1", "token2", ...],       ← 粗粒度 token，用于检索
        "content_sm_ltks": ["t", "to", "tok", ...],      ← 细粒度 token，用于模糊匹配
        "doc_type_kwd": "text",                           ← 类型标记
        "position_int": [(pn, left, right, top, bottom)], ← PDF 坐标
        "image": PIL.Image | None,                        ← 关联图片
    },
    ...
]
```

---

## 第 1 层：解析 → sections

不同文件类型产生不同格式的 sections，最终统一成 `[(text, position_info), ...]`。

### PDF

```python
# 来自 deepdoc/parser/pdf_parser.py
sections = [(b["text"], f"@@{page}\t{left}\t{right}\t{top}\t{bottom}##") for b in boxes]
```

sections 是 PDF 中每个文本框的内容，附带页码和坐标信息。

### Word (DOCX)

```python
# 来自 rag/app/naive.py::Docx.__call__
sections = [(line.get("text"), line.get("image"), line.get("table")) for line in lines]
```

Word 的 sections 是文档中的段落、图片和表格的混合序列。

### 其他格式

| 格式 | 解析器 | 输出 |
|------|--------|------|
| Excel | `ExcelParser` | `[(cell_text, ""), ...]` |
| Markdown | `MarkdownParser` | 按标题/分隔符切分的 blocks |
| HTML | `HtmlParser` | 文本段落列表 |
| TXT | `TxtParser` | 按分隔符切分的文本段 |
| JSON | `JsonParser` | 结构化 key-value 文本段 |

---

## 第 2 层：naive_merge — 核心合并算法

**文件位置：** `rag/nlp/__init__.py:1070`

```python
def naive_merge(sections, chunk_token_num=128, delimiter="\n。；！？", overlapped_percent=0):
```

### 核心思路

**逐段叠加，超限则切：**

```
sections: [sec1, sec2, sec3, sec4, ...]
                │
                ▼
        遍历每个 section:
          1. 计算这个 section 的 token 数
          2. 当前 chunk 是否已超过阈值？
             → Yes: 起新 chunk（带上 overlap 尾巴）
             → No:  追加到当前 chunk
```

### 切分条件判断

```python
def add_chunk(t, pos):
    tnum = num_tokens_from_string(t)
    # 如果文本太短（< 8 tokens），丢弃位置信息，避免碎片化
    if tnum < 8:
        pos = ""

    # 关键判断：当前 chunk 的 token 数是否超过阈值
    # 阈值 = chunk_token_num * (100 - overlapped_percent) / 100
    if cks[-1] == "" or tk_nums[-1] > chunk_token_num * (100 - overlapped_percent) / 100.:
        # 起新 chunk，先带上旧 chunk 的 overlap 尾巴
        if cks:
            overlapped = remove_tag(cks[-1])
            t = overlapped[int(len(overlapped) * (100 - overlapped_percent) / 100.):] + t
        if t.find(pos) < 0:
            t += pos
        cks.append(t)           # 创建新 chunk
        tk_nums.append(tnum)
    else:
        # 追加到当前 chunk（继续累积）
        if cks[-1].find(pos) < 0:
            t += pos
        cks[-1] += t            # 累积文本
        tk_nums[-1] += tnum
```

**关键设计：**

- 切分阈值 = `chunk_token_num * (100 - overlapped_percent) / 100`
  - `chunk_token_num=512, overlapped_percent=0`  → 阈值 = 512
  - `chunk_token_num=512, overlapped_percent=10` → 阈值 = 460（提前触发，为 overlap 留空间）

### Overlap（重叠）机制

相邻 chunk 之间有文本重叠，避免关键信息在 chunk 边界被截断：

```
chunk1: "ABCDEFGHIJKLMNOPQRST"    (20 chars, overlapped_percent=20%)
                          ↓ 到达阈值，起新 chunk
chunk2: "QRST" + new_text          ← 把 chunk1 后 20% 的内容带过来
```

实现：

```python
overlapped = remove_tag(cks[-1])         # 去除 PDF 位置标签，得到纯文本
# 取后半部分作为 overlap
t = overlapped[int(len(overlapped) * 0.8):] + t
```

### 自定义分隔符模式

```
delimiter = "\n。；！？"           ← 默认：换行 + 中文断句符号
delimiter = "\n`##``---`"          ← 支持 backtick 包裹的自定义分隔符
```

当存在 `` `分隔符` `` 时，走**完全不同的切分逻辑**——不再逐段累积合并：

```python
custom_pattern = "##|---"    # 从 `##` 和 `---` 中提取

for sec, pos in sections:
    split_sec = re.split(r"(%s)" % custom_pattern, sec)
    for sub_sec in split_sec:
        cks.append("\n" + sub_sec)    # 每个分隔段直接成为独立 chunk
```

即：**自定义分隔符模式下，按分隔符精确切分，每个段都是独立 chunk，不合并。**

---

## 第 3 层：DOCX 特殊处理 — naive_merge_docx

**文件位置：** `rag/nlp/__init__.py:1463`

Word 文档走这条路径，因为其解析结果是**图片、表格和文本的混合序列**，需要区分 chunk 类型。

### 3.1 构建类型化 chunks — `_build_cks()`

```python
sections = [(text, image, table), ...]
     │
     ▼
cks = [
    {"text": "...", "ck_type": "text",   "tk_nums": 50},
    {"text": "...", "ck_type": "image",  "tk_nums": 0},      ← 图片不参与 token 合并
    {"text": "...", "ck_type": "table",  "tk_nums": 120},
    {"text": "...", "ck_type": "text",   "tk_nums": 80},
    ...
]
```

三种 chunk 类型：`text`（可合并）、`image`（独立保留）、`table`（独立保留）。

### 3.2 附加上下文 — `_add_context()`

为表格/图片 chunks 附加周围的文本上下文，提升检索体验：

```
...text chunk...  |  [IMAGE chunk]  |  ...text chunk...
    上下文上限 ↑       图片本身        上下文下限 ↓
```

```python
def _add_context(cks, idx, context_size):
    # 向前收集文本
    while prev >= 0 and remain_above > 0:
        if cks[prev]["ck_type"] == "text":
            piece = take_sentences_from_end(cks[prev]["text"], remain_above)
            parts_above.insert(0, piece)

    # 向后收集文本
    while after < len(cks) and remain_below > 0:
        if cks[after]["ck_type"] == "text":
            piece = take_sentences_from_start(cks[after]["text"], remain_below)
            parts_below.append(piece)

    cks[idx]["context_above"] = "".join(parts_above)
    cks[idx]["context_below"] = "".join(parts_below)
```

上下文收集是按 token 预算精确控制的，从最近的文本 chunk 开始逐块收集，直到满足 `context_size` 指定的 token 数。

### 3.3 合并文本 chunks — `_merge_cks()`

```python
def _merge_cks(cks, chunk_token_num, has_custom):
    for i in range(len(cks)):
        ck_type = cks[i]["ck_type"]

        if ck_type == "text":
            # 上一个文本 chunk 还没满 → 合并
            if prev_text_ck >= 0 \
               and merged[prev_text_ck]["tk_nums"] < chunk_token_num \
               and not has_custom:         # 自定义分隔符模式下不合并
                merged[prev_text_ck]["text"] += cks[i]["text"]
                merged[prev_text_ck]["tk_nums"] += cks[i]["tk_nums"]
            else:
                merged.append(cks[i])      # 起新 chunk
        else:
            merged.append(cks[i])          # 图片/表格独立保留，不合并
```

**图片和表格永远不参与文本合并**，它们作为独立 chunk 保留。

---

## 第 4 层：TokenChunker — Pipeline 组件版本

**文件位置：** `rag/flow/chunker/token_chunker.py`

这是 Agent 画布中的切分组件，参数更丰富，流程更结构化：

```
_upstream JSON
     │
     ▼
_build_json_chunks()              ← 解析上游 JSON，按类型构建内部 chunk
     │
     ▼
_attach_context_to_media_chunks() ← 给 image/table 附加上下文文本
     │
     ▼
_merge_text_chunks_by_token_size() ← token_size 模式下合并小文本 chunks
     │
     ▼
_split_chunk_docs_by_children()   ← 用 children_delimiters 二次切分
     │
     ▼
_finalize_json_chunks()           ← 转成最终输出，写入 PDF 坐标等元数据
```

### 三种切分模式

```python
self.delimiter_mode = "token_size"  # 默认：按 token 数累积合并
                     = "delimiter"  # 按分隔符切分
                     = "one"        # 一整块，不切
```

| 模式 | 行为 |
|------|------|
| `token_size` | 逐段累计 token，超限起新块（与 `naive_merge` 一致） |
| `delimiter` | 用正则按分隔符切分，不合并 |
| `one` | 整个文档一个 chunk |

### children_delimiters 二次切分

一次切分后，可以用子分隔符对每个 chunk 做更细粒度的切分：

```python
# 第一次切分：按主要分隔符（如 `\n`）
chunks = _split_text_by_pattern(payload, delimiter_pattern)

# 第二次切分：用 children_delimiters 对每个 chunk 再做切分
if custom_pattern:
    for c in cks:
        for text in _split_text_by_pattern(c, custom_pattern):
            docs.append({"text": text, "mom": c})
            # mom 字段保留父 chunk 原文，提供更大范围的上下文
```

**`mom` 字段的作用**：存切分前的父块原文，检索时可以提供原始段落的完整上下文。

### 媒体上下文附加（新版）

```python
def _attach_context_to_media_chunks(chunks, table_context_size, image_context_size):
    for i, chunk in enumerate(chunks):
        if chunk["ck_type"] not in {"table", "image"}:
            continue

        context_size = image_context_size if chunk["ck_type"] == "image" else table_context_size

        # 向前收集文本 chunks，直到满足 token 预算
        prev = i - 1
        while prev >= 0 and remain_above > 0:
            if prev_chunk["ck_type"] == "text":
                if prev_chunk["tk_nums"] >= remain_above:
                    # 只取末尾部分句子
                    parts_above.insert(0, _take_sentences(prev_chunk["text"], remain_above, from_end=True))
                else:
                    parts_above.insert(0, prev_chunk["text"])

        # 向后收集，对称逻辑
        after = i + 1
        while after < len(chunks) and remain_below > 0:
            # ... 对称逻辑

        chunk["context_above"] = "".join(parts_above)
        chunk["context_below"] = "".join(parts_below)
```

---

## 最终输出：tokenize_chunks / tokenize

所有切分路径最终都通过 `tokenize()` 函数生成可检索的数据结构：

```python
def tokenize(d, txt, eng):
    d["content_with_weight"] = txt
    # 去掉 HTML 表格标签后做粗粒度分词
    t = re.sub(r"</?(table|td|caption|tr|th)( [^<>]{0,12})?>", " ", txt)
    d["content_ltks"] = rag_tokenizer.tokenize(t)
    # 细粒度分词（用于模糊匹配）
    d["content_sm_ltks"] = rag_tokenizer.fine_grained_tokenize(d["content_ltks"])
```

**两种 token：**

- `content_ltks`：粗粒度分词，用于精确检索
- `content_sm_ltks`：细粒度分词（字/子词级别），用于模糊匹配和拼写容错

---

## 参数总览

| 参数 | 默认值 | 作用 | 使用位置 |
|------|--------|------|----------|
| `chunk_token_num` | 128 (naive) / 512 (pipeline) | 每个 chunk 的最大 token 数 | naive_merge, TokenChunker |
| `delimiter` | `\n。；！？` | 断句分隔符。用 `` ` `` 包裹自定义分隔符 | naive_merge, _build_cks |
| `overlapped_percent` | 0 | chunk 之间的重叠比例 (0–100) | naive_merge, _merge_text_chunks_by_token_size |
| `children_delimiters` | `[]` | 二次切分分隔符列表 | tokenize_chunks, _split_chunk_docs_by_children |
| `table_context_size` | 0 | 表格附近附带的文本 token 数 | naive_merge_docx, _attach_context_to_media_chunks |
| `image_context_size` | 0 | 图片附近附带的文本 token 数 | naive_merge_docx, _attach_context_to_media_chunks |
| `delimiter_mode` | `token_size` | 切分模式：`token_size` / `delimiter` / `one` | TokenChunker |

---

## 核心文件索引

| 文件 | 核心内容 | 行数 |
|------|----------|------|
| `rag/nlp/__init__.py` | `naive_merge()`, `naive_merge_docx()`, `tokenize_chunks()`, `tokenize()`, `split_with_pattern()` | ~1600 |
| `rag/app/naive.py` | `chunk()` — 文档上传入口，路由解析器 + 调用 merge | ~1150 |
| `rag/flow/chunker/token_chunker.py` | `TokenChunker` — Pipeline 组件版切分器 | ~370 |
| `rag/flow/base.py` | `ProcessBase` — 流水线组件基类 | ~60 |
| `deepdoc/parser/pdf_parser.py` | PDF 解析器，产出 sections | ~2500+ |
| `common/token_utils.py` | `num_tokens_from_string()` — token 计数 | — |

---

## 一句话总结

> 文档先被 deepdoc 解析成最小 text sections，然后逐段累加 token 数，超过 `chunk_token_num` 阈值就切一个新 chunk。同时支持 overlap 避免信息被截断、自定义分隔符精确控制切分边界、以及图片/表格附加上下文增强检索质量。

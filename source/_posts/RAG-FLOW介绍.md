---
title: RAG FLOW介绍
date: 2026-06-21 10:00:00
categories: RAG
tags:
  - rag
  - ragflow
  - llm
---

# RAG 管理平台 — 变更汇总

## 概述

在 RAGFlow 基础上新增一个 RAG 前端管理平台，包含 5 个功能模块：概览、语义搜索、文档管理、配置管理、构建管理。

**共涉及 20 个文件（14 个新增，6 个修改）**

---

## 一、新增后端文件

### 1. `api/apps/restful_apis/management_api.py`

管理平台 API 端点，共 10 个接口，自动注册为 Flask Blueprint（前缀 `/api/v1`）。

| 方法 | 路由 | 用途 |
|------|------|------|
| GET | `/management/overview` | 聚合所有数据集的概览统计 |
| POST | `/management/search` | 跨数据集的语义搜索 + 质量评分 |
| GET | `/management/documents` | 跨数据集的文档列表 |
| GET | `/management/configs` | 所有数据集的配置列表 |
| POST | `/management/configs/validate` | 验证配置参数 |
| POST | `/management/builds` | 触发全量/增量重建 |
| GET | `/management/builds` | 构建历史列表 |
| GET | `/management/builds/<id>` | 构建详情 |
| GET | `/management/builds/<id>/progress` | SSE 实时进度流 |
| POST | `/management/builds/<id>/cancel` | 取消构建 |

### 2. `api/apps/services/management_api_service.py`

业务逻辑层，包含：

- `BuildRecordService` — 构建记录的 CRUD
- `get_overview()` — 跨数据集聚合：文档数、段落数、Token 数、类型分布、解析状态、组件健康
- `search_management()` — 调用现有检索逻辑，附加质量评分计算（置信度/准确度/一致性/覆盖率）
- `list_management_documents()` — 跨数据集文档查询，支持多条件筛选
- `list_management_configs()` — 所有数据集配置导出
- `validate_config_management()` — 配置参数校验
- `create_build()` / `list_builds()` / `get_build_detail()` / `cancel_build()` — 构建全生命周期

### 3. `api/db/db_models.py`（修改）

新增 `BuildRecord` 模型（继承 `DataBaseModel`），字段如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | CharField(32) PK | 构建记录 ID |
| tenant_id | CharField(32) | 租户 ID |
| type | CharField(16) | full / incremental |
| status | CharField(16) | pending / running / completed / failed / cancelled |
| dataset_ids | JSONField | 数据集 ID 列表 |
| progress | IntegerField | 进度 0-100 |
| progress_msg | CharField(255) | 当前步骤描述 |
| current_document | CharField(255) | 正在处理的文件 |
| processed_documents | IntegerField | 已处理文档数 |
| total_documents | IntegerField | 总文档数 |
| chunk_count_before | IntegerField | 构建前段落数 |
| chunk_count_after | IntegerField | 构建后段落数 |
| started_at | DateTimeField | 开始时间 |
| completed_at | DateTimeField | 完成时间 |
| triggered_by | CharField(32) | 触发用户 |
| error_message | TextField | 错误信息 |

表名：`build_record`，启动时自动创建。

---

## 二、新增前端文件（14 个）

### 页面组件（6 个）

```
web/src/pages/management/
├── layout.tsx                          # 侧边栏布局（5 个导航项）
├── overview/index.tsx                  # 模块1：概览仪表盘
├── semantic-search/index.tsx           # 模块2：语义搜索
├── document-management/index.tsx       # 模块3：文档管理
├── configuration-management/index.tsx  # 模块4：配置管理
└── build-management/index.tsx          # 模块5：构建管理
```

#### 模块 1：概览 (`overview/index.tsx`)
- 4 张统计卡片（总文档数、总段落数、总 Token 数、数据集数）
- 文档类型分布饼图（Recharts PieChart）
- 解析状态柱状图（Recharts BarChart）
- 组件健康状态列表（MySQL / ES / Redis / MinIO）
- 30 秒自动刷新数据

#### 模块 2：语义搜索 (`semantic-search/index.tsx`)
- 搜索输入框（debounce 500ms + Enter 触发）
- 搜索结果列表（高亮匹配文本）
- 质量评分雷达图（置信度/准确率/一致性/覆盖率）
- 文档聚合标签侧边栏

#### 模块 3：文档管理 (`document-management/index.tsx`)
- 文档列表表格（TanStack Table）支持关键词搜索
- 按文档类型/状态筛选
- 点击行 → 右侧 Sheet 抽屉展示段落列表
- 段落编辑 Dialog（react-hook-form）
- 段落删除（二次确认）

#### 模块 4：配置管理 (`configuration-management/index.tsx`)
- 每个数据集一张配置卡片
- chunk_size Slider（128-2048）
- 嵌入模型展示（只读）
- 相似度阈值配置
- 验证 + 保存按钮
- 内联验证结果展示（绿勾/红叉）

#### 模块 5：构建管理 (`build-management/index.tsx`)
- 构建类型选择（全量/增量）
- 一键触发构建按钮
- 活动构建进度面板（ProgressBar + SSE 实时更新）
- 取消构建按钮
- 构建历史表格（构建ID / 类型 / 状态 / 进度 / 时间）
- 5 秒轮询刷新（有运行中构建时）

### 服务与状态管理（4 个）

```
web/src/
├── services/management-service.ts      # Axios 服务层 + SSE 流式连接
├── store/management-store.ts           # Zustand：侧边栏状态、构建运行标志
├── constants/management.ts             # 状态颜色映射、常量配置
└── hooks/
    ├── use-management-overview.ts      # 概览数据查询（30s 轮询）
    ├── use-management-search.ts        # 搜索 mutation（debounce）
    ├── use-management-docs.ts          # 文档/段落查询与变更
    ├── use-management-config.ts        # 配置查询与变更
    └── use-management-build.ts         # 构建 CRUD + SSE 进度流
```

---

## 三、修改的前端文件（5 个）

### 1. `web/src/routes.tsx`
- 新增 `Management` 相关 6 个路由枚举值
- 新增 Management 路由组（懒加载），包含 5 个子路由
- 默认重定向到 `/management/overview`

### 2. `web/src/locales/en.ts`
- 新增 `management` 命名空间，约 60 个英文翻译键

### 3. `web/src/locales/zh.ts`
- 新增 `management` 命名空间，约 60 个中文翻译键

### 4. `web/src/layouts/components/global-navbar.tsx`
- `PathMap` 新增 Management 路径映射
- `menuItems` 新增 Management 导航项

---

## 四、数据流设计

```
[Page Component]
    │ 调用
    ▼
[Custom Hook (TanStack Query)]
    │ 调用
    ▼
[Service (Axios)]
    │ HTTP
    ▼
[Backend API (/api/v1/management/*)]
    │ 调用
    ▼
[Service Layer (management_api_service.py)]
    │ 调用
    ▼
[DB Services (DocumentService / KnowledgebaseService / BuildRecordService)]
```

### 状态管理决策

| 状态类型 | 工具 | 适用场景 |
|---------|------|---------|
| 服务端数据 | TanStack Query | 列表、详情、搜索结果 |
| 全局 UI 状态 | Zustand | 侧边栏折叠、构建运行标志 |
| 表单状态 | react-hook-form + zod | 配置编辑、段落编辑 |
| 瞬时 UI 状态 | useState | 搜索输入值、模态框开关 |

---

## 五、技术栈

与 RAGFlow 现有前端完全一致：

- **框架**：React 18 + TypeScript
- **构建**：Vite 7
- **路由**：React Router v7（createBrowserRouter + lazy loading）
- **UI 组件**：shadcn/ui（Radix primitives + Tailwind CSS）
- **数据获取**：TanStack Query（React Query v5）
- **全局状态**：Zustand
- **表单**：react-hook-form + zod
- **表格**：@tanstack/react-table
- **图表**：Recharts（PieChart / BarChart / RadarChart）
- **HTTP**：Axios（新服务）+ 原生 fetch（SSE 流）
- **国际化**：react-i18next
- **实时通信**：Server-Sent Events

---

## 六、启动说明

```bash
# 后端（management_api.py 会被自动发现注册）
docker compose -f docker/docker-compose.yml up -d

# 前端
cd web
npm install
npm run dev
# 访问 http://localhost:5173/management
```

导航栏会自动显示 **Management** 入口，点击进入管理平台。

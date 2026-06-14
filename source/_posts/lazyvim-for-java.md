---
title: lazyvim for java
date: 2025-12-09 07:38:39
categories: others
tags:
  - nvim
  - lazyvim
  - java
  - jdtls
  - dap
---

## lazyvim的java开发环境配置

```
-- ~/.config/nvim/lua/plugins/java.lua
return {
  "mfussenegger/nvim-jdtls",
  ft = "java", -- 仅在打开 .java 文件时启动
  config = function()
    -- 1. 定位 mason 安装的工具路径（自动适配版本/路径）
    local mason_path = vim.fn.glob(vim.fn.stdpath("data") .. "/mason/packages/")
    local jdtls_path = mason_path .. "jdtls/"
    local java_debug_path = vim.fn.glob(mason_path .. "java-debug-adapter/extension/server/com.microsoft.java.debug.plugin-0.53.2.jar")

    -- 2. 确保 java-debug bundle 存在
    if java_debug_path == "" then
      vim.notify("java-debug-adapter 未安装，请执行 :MasonInstall java-debug-adapter", vim.log.levels.ERROR)
      return
    end

    -- 3. jdtls 启动命令（适配 macOS + mason 路径）
    local cmd = {
      jdtls_path .. "bin/jdtls", -- jdtls 可执行文件路径
      "--jvm-arg=-javaagent:" .. jdtls_path .. "lombok.jar", -- 可选：支持 Lombok
    }

    -- 4. 找到 Java 项目根目录（必须有 mvnw/.gradlew/.git 之一）
    local root_dir = vim.fs.dirname(vim.fs.find({ ".gradlew", ".git", "mvnw" }, { upward = true })[1] or vim.fn.getcwd())

    -- 5. jdtls 核心配置（加载调试 bundle）
    local config = {
      cmd = cmd,
      root_dir = root_dir,
      init_options = {
        bundles = { java_debug_path }, -- 加载 java-debug 扩展（关键）
      },
      settings = {
        java = {
          configuration = {
            runtimes = { -- 可选：指定 Java 运行时（若系统有多个版本）
              {
                name = "JavaSE-17",
                path = "/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home",
              },
            },
          },
        },
      },
    }

    -- 6. 启动 jdtls + 关联 nvim-dap 调试
    require("jdtls").start_or_attach(config)
    require("jdtls").setup_dap({ hotcodereplace = "auto" }) -- 让 jdtls 给 nvim-dap 提供适配器

    -- ========== 新增：快捷键触发生成 Java 调试配置 ==========
    -- 定义生成调试配置的核心函数
    local generate_java_dap_config = function()
      -- 检查 jdtls 是否已正常启动（避免无意义执行）
      local jdtls_clients = vim.lsp.get_active_clients({ name = "jdtls" })
      if #jdtls_clients == 0 then
        vim.notify("JDTLS 未启动，请确保打开的是 Java 项目内的 .java 文件！", vim.log.levels.WARN)
        return
      end
      -- 生成调试配置
      require("jdtls.dap").setup_dap_main_class_configs()
      vim.notify("Java 调试配置已生成 ✔️", vim.log.levels.INFO)
    end

    -- 绑定快捷键（<leader>dg 触发，仅在 Java 文件中生效）
    -- leader 键默认是空格，即 空格 + d + g 执行生成操作
    vim.keymap.set(
      "n",
      "<leader>dg",
      generate_java_dap_config,
      {
        noremap = true,
        silent = true,
        buffer = 0, -- 仅在当前 Java 文件缓冲区生效（避免全局冲突）
        desc = "生成 Java 调试配置" -- 快捷键描述（兼容 which-key 菜单）
      }
    )
  end,
  dependencies = {
    "mfussenegger/nvim-dap",
    "rcarriga/nvim-dap-ui",
  },
}
```

```
-- ~/.config/nvim/lua/plugins/dap.lua
return {
  "mfussenegger/nvim-dap",
  config = function()
    local dap = require('dap')
    local dapui = require('dapui') -- 导入 dap-ui 模块（依赖已声明，可直接用）

    -- 仅保留调试配置项（适配器由 nvim-jdtls 自动提供）
    dap.configurations.java = {
      {
        type = "java",
        request = "launch",
        name = "Launch Main Class",
        mainClass = "${file}", -- 自动识别当前文件主类
        projectName = "${workspaceFolderBasename}",
      },
      {
        type = "java",
        request = "attach",
        name = "Debug (Attach) - Remote",
        hostName = "127.0.0.1",
        port = 5005,
      },
    }

    -- ========== 新增：调试核心快捷键（全局生效，Java 调试通用） ==========
    local map_opts = { noremap = true, silent = true } -- 快捷键基础配置
    local keymap = vim.keymap.set

    -- 1. 断点相关
    keymap("n", "<leader>db", dap.toggle_breakpoint,
      vim.tbl_extend("force", map_opts, { desc = "DAP: 切换断点" }))
    keymap("n", "<leader>dB", function()
      dap.set_breakpoint(vim.fn.input("断点条件: ")) -- 条件断点
    end, vim.tbl_extend("force", map_opts, { desc = "DAP: 设置条件断点" }))
    keymap("n", "<leader>dr", dap.clear_breakpoints,
      vim.tbl_extend("force", map_opts, { desc = "DAP: 清空所有断点" }))

    -- 2. 调试流程控制
    keymap("n", "<leader>dc", dap.continue,
      vim.tbl_extend("force", map_opts, { desc = "DAP: 启动/继续调试" }))
    keymap("n", "<leader>ds", dap.step_over,
      vim.tbl_extend("force", map_opts, { desc = "DAP: 单步跳过（逐行执行）" }))
    keymap("n", "<leader>di", dap.step_into,
      vim.tbl_extend("force", map_opts, { desc = "DAP: 单步进入（进入函数）" }))
    keymap("n", "<leader>do", dap.step_out,
      vim.tbl_extend("force", map_opts, { desc = "DAP: 单步退出（退出函数）" }))
    keymap("n", "<leader>dq", dap.terminate,
      vim.tbl_extend("force", map_opts, { desc = "DAP: 终止调试会话" }))

    -- 3. DAP UI 控制（配合 rcarriga/nvim-dap-ui）
    keymap("n", "<leader>du", dapui.toggle,
      vim.tbl_extend("force", map_opts, { desc = "DAP: 切换调试UI" }))

    -- ========== 可选：自动联动 DAP UI（启动调试时打开，终止时关闭） ==========
    dapui.setup() -- 初始化 dap-ui（默认布局，无需额外配置）
    dap.listeners.after.event_initialized["dapui_config"] = function()
      dapui.open() -- 调试启动 → 自动打开 UI
    end
    dap.listeners.before.event_terminated["dapui_config"] = function()
      dapui.close() -- 调试终止 → 自动关闭 UI
    end
    dap.listeners.before.event_exited["dapui_config"] = function()
      dapui.close() -- 调试退出 → 自动关闭 UI
    end
  end,
  dependencies = { "rcarriga/nvim-dap-ui" },
}
```

#### lazyExtras:

#### mason:

![2.png](/Users/garvey/Desktop/blog/source/images/2.png)

#### nvim目录树

![3.png](/Users/garvey/Desktop/blog/source/images/3.png)

# dshd Yellow 🧳 — 整合包工具

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的整合包（modpack）工具：**打包**和**加载** DSH 整合包。一个整合包 = 一份**只存引用**的发行清单——技能、插件、MCP、模式、模型路由、组合补丁、灵魂（人设）全部以"地址 + 版本 + 哈希"的形式引用，**需要时按需下载，哈希校验，绝不重复安装**。

**使用 dshd Yellow 甚至不需要安装 DSH。**

dshd 家族的一员：🟥 **Red**（桌面端）· 🟦 **Blue**（移动端）· 🟩 **Green**（守护者）· 🟨 **Yellow**（整合包）· 🟤 **Brown**（离线预装版，规划中）。

> 社区项目，与 DeepSeek 无隶属关系，亦未获其认可。

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

## 它是怎么工作的

**打包**（`pack`）：把 8 类可改面收集成 `dsh.index.json`（纯引用 + 协议 + 版本声明）+ 独立内容文件（`soul.md` / `models.json` / `plugins.json` / `patches.yaml` / `mcp.json` / `presets/`）→ zip。

**加载**（`load`）：解包 → 校验清单 / **DSH 版本兼容** / 分发协议 → 技能按 **sha1 哈希去重**下载（`~/.dshd-yellow/installed.json` 台账，命中即复用）→ 插件 `dsh plugin add` → MCP / 模式 / 模型 / 补丁 → **派生预设**（基础模式 + 技能白名单 + MCP 行 + soul 人设）→ **加载成新会话或分叉**（不做热切换——对话中换工具集会破坏历史日志一致性）。

**设计铁律**：
1. **清单只存引用，零实质内容**（内容在独立文件；API key 只写环境变量名，绝不进包）
2. **哈希去重**：装前查台账，同一技能/MCP 绝不重复安装
3. **版本兼容声明**：每个包必须带 `dshVersion`（打包时版本）+ `dependencies.dsh`（兼容范围）——DSH 是预览版，兼容性差，不匹配拒绝加载
4. **分发协议**：包和每个组件必须标明 license（如 MC 社区）
5. **只走 DSH 公开机制**：不碰内部实现，DSH 升级换实现也照用

## 安装

```bash
npm install -g dshd-yellow
# 或直接跑:
npx dshd-yellow --version
```

## 用法

```bash
# 创建包工作目录
dshd-yellow init my-pack

# 编辑: dsh.json(元数据+技能引用) soul.md models.json plugins.json patches.yaml mcp.json presets/

# 打包
dshd-yellow pack --from my-pack --out my-pack-1.0.0.dshpack

# 加载成新会话 (或 --fork-from <会话id> 分叉)
dshd-yellow load my-pack-1.0.0.dshpack

# 其它
dshd-yellow list          # 已安装 (台账)
dshd-yellow info <包>     # 查看清单
dshd-yellow verify <包>   # 校验完整性
```

### dsh.json（作者元数据 + 技能引用）

```jsonc
{
  "name": "my-pack",
  "versionId": "0.1.0",
  "license": "MIT",
  "dshRange": ">=0.1.0-rc.5 <0.2.0",
  "skills": [
    { "id": "zhihu-search", "source": "github:owner/skills@skills/zhihu-search@v1.0.0", "sha1": "…", "license": "MIT", "deps": { "node": ">=18" } }
  ]
}
```

### models.json（模型路由，key 只写环境变量名）

```json
{
  "provider": "tokenrhythm",
  "baseURL": "https://tokenrhythm.studio/v1",
  "api": "openai-completions",
  "apiKeyEnv": "TOKENRHYTHM_API_KEY",
  "model": "deepseek-v4-flash-0731"
}
```

### mcp.json / plugins.json / patches.yaml / presets/ / soul.md

分别是 MCP 服务器定义、插件引用（npm 包+版本）、组合补丁（原样合并）、模式目录、灵魂/人设。

## 环境变量

| 变量 | 用途 |
|---|---|
| `DSH_HOME` | 主 DSH 数据目录（默认 `~/.dsh`；只读，加载目标） |
| `DSH_YELLOW_DSH` | 加载用的 dsh CLI（默认：本机 DSH 源码，否则 npx `@deepseek-ai/dsh`） |
| `DSH_YELLOW_HOME` | Yellow 自己的数据根（默认 `~/.dshd-yellow`：台账/技能/缓存） |

## 与 dshd 家族的关系

`dshd` 是家族仓库：[dshd Red](https://github.com/id5463/dshd)（桌面端，内嵌 Yellow/Green）、dshd Blue（Android 远程）、dshd Green（守护）、以及这个独立的 **dshd Yellow**。Yellow 作为独立项目发布，Red 会内嵌它（红黄绿一个 exe）。

## 许可证

[MIT](LICENSE)。与 DeepSeek 无隶属关系，亦未获其认可。

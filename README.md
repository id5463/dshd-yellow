# dshd Yellow 🧳 — the Modpack Tool

The integration-pack (modpack) tool for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): **pack** and **load** DSH integration packs. A pack is a **reference-only manifest** — skills, plugins, MCP servers, presets, model routing, composition patches and the soul (persona) are all referenced by *address + version + hash*, downloaded on demand, hash-verified, and never installed twice.

**Using dshd Yellow does not require installing DSH.**

A member of the dshd family: 🟥 **Red** (desktop) · 🟦 **Blue** (mobile) · 🟩 **Green** (guardian) · 🟨 **Yellow** (modpacks) · 🟤 **Brown** (offline preloaded, planned).

> Community project, not affiliated with or endorsed by DeepSeek.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

## How it works

**Pack** (`pack`): collect the 8 modifiable surfaces into `dsh.index.json` (pure references + license + version declaration) plus separate content files (`soul.md` / `models.json` / `plugins.json` / `patches.yaml` / `mcp.json` / `presets/`) → zip.

**Load** (`load`): unpack → validate manifest / **DSH version compatibility** / distribution licenses → download skills with **sha1 dedup** (`~/.dshd-yellow/installed.json` ledger; hit = reuse, zero download) → install plugins via `dsh plugin add` → MCP / presets / models / patches → **derive a preset** (base preset + skill whitelist + MCP rows + soul persona) → **load into a new session or a fork** (no hot-swap — swapping toolkits mid-conversation would break history-log consistency).

**Design rules**:
1. **Reference-only manifest, zero content** (content lives in separate files; API keys are referenced by env-var name only, never packed)
2. **Hash dedup**: the ledger is checked before install; the same skill/MCP is never installed twice
3. **Version declaration**: every pack must carry `dshVersion` (the version it was built on) + `dependencies.dsh` (compatible range) — DSH is a preview, compatibility varies; mismatch refuses to load
4. **Distribution licenses**: the pack and every component must declare a license (like the MC community)
5. **Public mechanisms only**: never touches DSH internals; survives DSH upgrades

## Install

```bash
npm install -g dshd-yellow
# or run directly:
npx dshd-yellow --version
```

## Usage

```bash
# create a pack working directory
dshd-yellow init my-pack

# edit: dsh.json (metadata + skill refs) soul.md models.json plugins.json patches.yaml mcp.json presets/

# pack
dshd-yellow pack --from my-pack --out my-pack-1.0.0.dshpack

# load into a new session (or --fork-from <session-id> to fork)
dshd-yellow load my-pack-1.0.0.dshpack

# others
dshd-yellow list          # installed (ledger)
dshd-yellow info <pack>   # show manifest
dshd-yellow verify <pack> # integrity check
```

### dsh.json (author metadata + skill references)

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

### models.json (model routing; keys referenced by env-var name only)

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

MCP server definitions, plugin references (npm name + version), composition patch (merged verbatim), preset directories, and the soul/persona respectively.

## Environment

| Variable | Purpose |
|---|---|
| `DSH_HOME` | main DSH data directory (default `~/.dsh`; read-only, the load target) |
| `DSH_YELLOW_DSH` | dsh CLI for loading (default: local DSH source, else npx `@deepseek-ai/dsh`) |
| `DSH_YELLOW_HOME` | Yellow's own data root (default `~/.dshd-yellow`: ledger/skills/cache) |

## Relationship to the dshd family

`dshd` is the family repo: [dshd Red](https://github.com/id5463/dshd) (desktop, embeds Yellow/Green), dshd Blue (Android remote), dshd Green (guardian), and this standalone **dshd Yellow**. Yellow ships as an independent project; Red embeds it (Red+Yellow+Green in one exe).

## License

[MIT](LICENSE). Not affiliated with or endorsed by DeepSeek.

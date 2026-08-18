'use strict'
/**
 * dshd Yellow — 打包器: 把一个包工作目录变成发行物。
 * 包工作目录 (pack/):
 *   dsh.json          作者元数据: {name, versionId, license, dshRange?, skills?: [{id, source, sha1?, license, deps?}]}
 *   soul.md           (可选) 灵魂/人设
 *   models.json       (可选) 模型路由: {provider, baseURL, api, apiKeyEnv, model, models?}
 *   plugins.json      (可选) [{name, version?, license?, mount?, config?}]
 *   patches.yaml      (可选) profile 组合补丁 (原样合并)
 *   mcp.json          (可选) [{id, serverName?, transport, command?, args?, url?, headers?, license?}]
 *   presets/          (可选) 模式目录 (agent.cordis.yml + preset.yml)
 *   overrides/        (可选) 少量不可下载的小文件
 * 产出: dsh.index.json (纯引用+协议) + zip (tar)。
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const { FORMAT_VERSION, GAME, CONTENT_FILES } = require('./format.js')
const { dshVersion, readJson } = require('./dsh.js')

function collectSkills(packDir) {
  const meta = readJson(path.join(packDir, 'dsh.json'))
  if (!meta) return []
  return Array.isArray(meta.skills) ? meta.skills : []
}

function collectComponents(packDir, skills) {
  const components = []
  for (const s of skills) components.push({ id: s.id, type: 'skill', license: s.license || '' })
  const plugins = readJson(path.join(packDir, 'plugins.json'))
  for (const p of (Array.isArray(plugins) ? plugins : [])) components.push({ id: p.name, type: 'plugin', license: p.license || '' })
  const mcp = readJson(path.join(packDir, 'mcp.json'))
  for (const m of (Array.isArray(mcp) ? mcp : [])) components.push({ id: m.id, type: 'mcp', license: m.license || '' })
  return components
}

function detectPresets(packDir) {
  const dir = path.join(packDir, 'presets')
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'agent.cordis.yml'))).map((e) => e.name)
  } catch (e) { return [] }
}

function fileExists(packDir, rel) { return fs.existsSync(path.join(packDir, rel)) }

/**
 * 打包: packDir → dsh.index.json + zip (或目录)
 * @returns {{ok, error?, out?, zip?, problems?}}
 */
async function packPack({ from, out, name, version, license, dshRange }) {
  const packDir = path.resolve(from || '.')
  if (!fs.existsSync(path.join(packDir, 'dsh.json'))) {
    return { ok: false, error: '不是包工作目录 (缺少 dsh.json)' }
  }
  const meta = readJson(path.join(packDir, 'dsh.json')) || {}
  const packName = name || meta.name
  const packVersion = version || meta.versionId
  const packLicense = license || meta.license
  if (!packName || !packVersion || !packLicense) {
    return { ok: false, error: '需要 name / versionId / license (可放 dsh.json 或 --name/--version/--license)' }
  }

  const skills = collectSkills(packDir)
  const components = collectComponents(packDir, skills)
  const presets = detectPresets(packDir)
  const dshVer = await dshVersion()
  const range = dshRange || meta.dshRange || (dshVer ? '>=' + dshVer.replace(/-[0-9A-Za-z.]+$/, '') + ' <' + nextMinor(dshVer) : '>=0')

  // 组装清单: 只存引用 + 内容文件路径
  const manifest = {
    formatVersion: FORMAT_VERSION,
    game: GAME,
    name: packName,
    versionId: packVersion,
    dshVersion: dshVer || '',
    license: packLicense,
    dependencies: { dsh: range },
  }
  for (const [field, file] of Object.entries(CONTENT_FILES)) {
    if (fileExists(packDir, file)) manifest[field] = { file }
  }
  if (presets.length) manifest.presets = presets
  if (skills.length) {
    manifest.skills = skills.map((s) => {
      const out = { id: s.id, source: s.source, sha1: s.sha1 || '' }
      if (s.license) out.license = s.license
      if (s.deps) out.deps = s.deps
      return out
    })
  }
  if (components.length) manifest.components = components

  // 写入清单 (打包目录根)
  fs.writeFileSync(path.join(packDir, 'dsh.index.json'), JSON.stringify(manifest, null, 2))

  // 校验
  const { validateManifest } = require('./format.js')
  const v = validateManifest(manifest)
  if (!v.ok) return { ok: false, error: '清单校验失败: ' + v.problems.join('; '), problems: v.problems }

  // zip 输出 (tar -a; Windows 10+ 自带 bsdtar)
  const outFile = out || path.join(os.homedir(), 'Downloads', packName + '-' + packVersion + '.dshpack')
  const outAbs = path.resolve(outFile)
  fs.mkdirSync(path.dirname(outAbs), { recursive: true })
  if (fs.existsSync(outAbs)) fs.rmSync(outAbs, { force: true })
  const tar = spawnSync('tar', ['-a', '-c', '-f', outAbs, '-C', packDir, '.'], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (tar.status !== 0) {
    // tar 不可用: 退回输出目录形式
    return { ok: true, out: packDir, zip: null, note: 'tar 不可用, 输出为目录: ' + packDir, manifest }
  }
  return { ok: true, out: outAbs, zip: outAbs, manifest }
}

function nextMinor(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return '999.0.0'
  return m[1] + '.' + (Number(m[2]) + 1) + '.0'
}

/** 初始化包工作目录骨架 */
function initPack(name) {
  const dir = path.resolve(name)
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(dir, 'presets'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'overrides'), { recursive: true })
  const slug = path.basename(dir).toLowerCase().replace(/[^a-z0-9-]/g, '-')
  fs.writeFileSync(path.join(dir, 'dsh.json'), JSON.stringify({
    name: slug,
    versionId: '0.1.0',
    license: 'MIT',
    dshRange: '>=0',
    skills: [],
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'soul.md'), '# ' + slug + '\n\n（这个包的灵魂/人设）\n')
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ provider: '', baseURL: '', api: 'openai-completions', apiKeyEnv: '', model: '' }, null, 2))
  fs.writeFileSync(path.join(dir, 'plugins.json'), '[]\n')
  fs.writeFileSync(path.join(dir, 'patches.yaml'), '# 组合补丁 (原样合并进 profile 的 cordis.patch.yml)\n[]\n')
  fs.writeFileSync(path.join(dir, 'mcp.json'), '[]\n')
  return dir
}

// ===== 从会话导出 (pack --from-session) =====

/** 提取文本块: 从 lines[start] 起, 以首行缩进为准收集内容, 返回 {end, text} */
function blockText(lines, start) {
  const first = lines[start]
  if (!first) return { end: start, text: '' }
  const indent = (first.match(/^(\s*)/) || ['', ''])[1].length
  const out = []
  let end = start
  for (let i = start; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '') { out.push(''); continue }
    const m = (l.match(/^(\s*)/) || ['', ''])[1].length
    if (m < indent) break
    out.push(l.slice(indent))
    end = i
  }
  return { end, text: out.join('\n').trim() }
}

/**
 * 解析一份预设组合文本, 提取隔离配置 (soul / 技能目录 / MCP / 插件行)。
 * @returns {{soul, skillDirs, mcp, plugins, note}}
 */
function parsePresetComposition(text) {
  const lines = String(text || '').split(/\r?\n/)
  let soul = ''
  const skillDirs = []
  const mcp = []
  const plugins = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const idMatch = l.match(/^- id: (\S+)\s*$/)
    if (!idMatch) continue
    const id = idMatch[1]
    // persona → soul
    if (id === 'persona') {
      const t = lines.findIndex((x, idx) => idx > i && idx < i + 30 && /^\s{4}text:\s*[|>]-/.test(x))
      if (t > i) {
        const blk = blockText(lines, t + 1)
        soul = blk.text
        i = blk.end
      }
    }
    // skill-filesystem → customSkillDirs
    if (id === 'skill-filesystem') {
      for (let j = i + 1; j < lines.length; j++) {
        if (/^- /.test(lines[j]) && j > i + 1) break
        const m = lines[j].match(/^\s{6}-\s*'([^']+)'/)
        if (m) skillDirs.push(m[1])
      }
    }
    // mcp-client 行
    if (/^mcp-/.test(id)) {
      const cfg = {}
      let inArgs = false, inEnv = false, inHdrs = false
      for (let j = i + 1; j < lines.length; j++) {
        const lj = lines[j]
        if (/^- /.test(lj)) break
        if (/^\s+config:/.test(lj)) continue
        const k = lj.match(/^\s{4}([A-Za-z]+):\s*(.*)$/)
        if (k) {
          const key = k[1]; const val = k[2].replace(/^['"]|['"]$/g, '')
          inArgs = key === 'args'; inEnv = key === 'env'; inHdrs = key === 'headers'
          if (key === 'args' || key === 'env' || key === 'headers') { cfg[key] = cfg[key] || [] }
          else if (val !== '') cfg[key] = val
        } else if (inArgs) {
          const a = lj.match(/^\s{6}-\s*'?([^']*)'?\s*$/)
          if (a) { cfg.args = cfg.args || []; cfg.args.push(a[1]) }
        } else if (inEnv || inHdrs) {
          const e = lj.match(/^\s{6}([A-Za-z0-9_-]+):\s*'?([^']*)'?\s*$/)
          if (e) { cfg[inEnv ? 'env' : 'headers'] = cfg[inEnv ? 'env' : 'headers'] || {}; cfg[inEnv ? 'env' : 'headers'][e[1]] = e[2] }
        }
      }
      if (cfg.command || cfg.url) {
        // serverName 去掉会话短号后缀 (-xxxxxx)
        const name = String(cfg.serverName || id).replace(/^mcp-/, '').replace(/-[0-9a-z]{6}$/, '')
        mcp.push({ id: name, serverName: name, transport: cfg.transport || 'stdio', command: cfg.command, args: cfg.args, url: cfg.url, headers: cfg.headers, env: cfg.env, cwd: cfg.cwd, timeoutMs: cfg.toolCallTimeoutMs ? Number(cfg.toolCallTimeoutMs) : undefined })
      }
    }
    // 插件行 (iso-plugin-* 或任意外部插件名)
    if (/^iso-plugin-/.test(id) || (id.startsWith('plugin-') && id !== 'plugin')) {
      const nameMatch = lines.slice(i + 1, i + 6).find((x) => /^\s+name:/.test(x))
      if (nameMatch) {
        const nm = nameMatch.replace(/^\s+name:\s*/, '').replace(/^['"]|['"]$/g, '')
        plugins.push(resolvePluginName(nm))
      }
    }
  }
  return { soul, skillDirs, mcp, plugins }
}

/** 从插件入口 (绝对路径或包名) 解析 npm 包名 */
function resolvePluginName(entry) {
  const m = String(entry).match(/node_modules[/\\](@[^/\\]+[/\\][^/\\]+|[^/\\]+)[/\\]/)
  return m ? m[1] : String(entry)
}

/**
 * 从会话导出整合包: 读会话预设 → 解析隔离配置 → 生成包工作目录 → 打包。
 * @returns {{ok, error?, out?, packDir?, problems?, base?}}
 */
async function exportFromSession({ sessionId, base, name, version, license, out, dshRange }) {
  const { rpc, dshPort, unwrap, errorOf } = require('./dsh.js')
  const installed = require('./installed.js')
  const list = unwrap(await rpc(dshPort(), 'session.list', {}))
  const sess = (list && list.items || []).find((s) => s.sessionId === sessionId)
  if (!sess) return { ok: false, error: '找不到会话 ' + sessionId }
  const presetId = sess.agentPreset
  if (!presetId) return { ok: false, error: '会话没有预设' }

  const pr = await rpc(dshPort(), 'agentPreset.read', { agentPreset: presetId })
  const presetText = pr && pr.result && pr.result.ok ? pr.result.value.content : null
  if (!presetText) return { ok: false, error: '读取会话预设失败: ' + errorOf(pr) }

  // 基础模式: red-iso-* 派生 → 需 --base (默认 standard); 普通模式 → 用它本身
  const derived = String(presetId).startsWith('red-iso-') || String(presetId).startsWith('yellow-')
  const baseId = derived ? (base || 'standard') : presetId
  const br = await rpc(dshPort(), 'agentPreset.read', { agentPreset: baseId })
  const baseText = br && br.result && br.result.ok ? br.result.value.content : null
  if (!baseText) return { ok: false, error: '读取基础模式 ' + baseId + ' 失败' }
  const baseName = br.result.value.name || baseId

  const parsed = parsePresetComposition(presetText)
  const problems = []

  // 技能: 从台账查来源, 查不到 → overrides 兜底
  const skills = []
  const overrideSkillDirs = []
  for (const dir of parsed.skillDirs) {
    const id = path.basename(String(dir))
    const known = installed.findSkill(id)
    if (known && known.source) {
      skills.push({ id, source: known.source, sha1: known.sha1, license: known.license || 'MIT' })
    } else {
      overrideSkillDirs.push(dir)
      problems.push('技能 ' + id + ' 无已知来源 (台账未记录), 内容将打进 overrides/ — 建议之后在 dsh.json 改为引用')
    }
  }

  // 生成包工作目录 (临时)
  const slug = String(name || presetId).toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'session-pack'
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yellow-export-'))
  const packDir = path.join(tmp, slug)
  fs.mkdirSync(path.join(packDir, 'presets'), { recursive: true })
  fs.mkdirSync(path.join(packDir, 'overrides'), { recursive: true })
  fs.mkdirSync(path.join(packDir, 'skills'), { recursive: true })

  fs.writeFileSync(path.join(packDir, 'dsh.json'), JSON.stringify({
    name: slug, versionId: version || '0.1.0', license: license || 'MIT', dshRange: dshRange || '>=0', skills,
  }, null, 2))
  fs.writeFileSync(path.join(packDir, 'soul.md'), parsed.soul || '# ' + slug + '\n\n（这个包的灵魂/人设）\n')
  fs.writeFileSync(path.join(packDir, 'plugins.json'), JSON.stringify(parsed.plugins.map((n) => ({ name: n, license: 'MIT' })), null, 2))
  fs.writeFileSync(path.join(packDir, 'mcp.json'), JSON.stringify(parsed.mcp.map((m) => ({ ...m, license: m.license || 'MIT' })), null, 2))
  fs.writeFileSync(path.join(packDir, 'patches.yaml'), '[]\n')

  // 模式进包: 基础预设完整组合
  const presetDir = path.join(packDir, 'presets', slug + '-' + baseId)
  fs.mkdirSync(presetDir, { recursive: true })
  fs.writeFileSync(path.join(presetDir, 'agent.cordis.yml'), baseText)
  fs.writeFileSync(path.join(presetDir, 'preset.yml'), 'name: ' + yamlScalar(baseName) + '\ndescription: 由 dshd Yellow 从会话导出\n')

  // 无来源技能 → overrides
  for (const d of overrideSkillDirs) {
    try {
      fs.cpSync(d, path.join(packDir, 'overrides', 'skills', path.basename(d)), { recursive: true })
    } catch (e) { problems.push('技能复制失败: ' + path.basename(d) + ' (' + e.message + ')') }
  }

  // 打包
  const r = await packPack({ from: packDir, out, name: slug, version: version || '0.1.0', license: license || 'MIT', dshRange: dshRange || '>=0' })
  if (!r.ok) { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (e) {} return { ok: false, error: r.error, problems } }
  return { ok: true, out: r.out, zip: r.zip, packDir, problems, base: baseId, manifest: r.manifest }
}

function yamlScalar(v) {
  const s = String(v == null ? '' : v)
  if (/^[A-Za-z0-9_@./-]+$/.test(s) && !/^(true|false|null|yes|no|on|off|[-+]?\d)/i.test(s)) return s
  return "'" + s.replace(/'/g, "''") + "'"
}

module.exports = { packPack, initPack, exportFromSession, parsePresetComposition }

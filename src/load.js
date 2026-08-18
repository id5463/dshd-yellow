'use strict'
/**
 * dshd Yellow — 加载器: 把整合包变成一个新的会话环境。
 * 流程: 解包 → 校验清单/版本/协议 → 技能(哈希去重下载+sha1校验) → 插件(dsh plugin add, 台账去重)
 *       → MCP(mcp-client 行) → 模式(.agent-presets) → 模型/补丁(备份后应用)
 *       → 派生预设(基础模式 + 包技能白名单 + MCP 行 + soul 人设) → 新会话 / 分叉。
 * 只走 DSH 公开机制; 只加载成新会话或分叉 (不做热切换)。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { readManifest } = require('./format.js')
const { dshHome, dshPort, rpc, unwrap, errorOf, dshVersion, versionInRange, backupFile, readSettings, writeSettings, resolveDshCli, runDsh, readJson } = require('./dsh.js')
const { downloadSkill, dirSha1, cacheHit, cachePut } = require('./download.js')
const installed = require('./installed.js')

// ===== 解包 =====

function unpackPack(packPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  if (fs.statSync(packPath).isDirectory()) {
    fs.cpSync(packPath, destDir, { recursive: true })
    return destDir
  }
  const r = spawnSync('tar', ['-x', '-f', packPath, '-C', destDir], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0) throw new Error('解包失败 (tar): ' + r.stderr)
  return destDir
}

// ===== 技能 =====

async function processSkills(skills, log) {
  const results = []
  for (const skill of skills) {
    const id = skill.id
    const known = installed.findSkill(id, skill.source, skill.sha1)
    const installDir = installed.skillInstallDir(id)
    if (known && fs.existsSync(installDir) && fs.readdirSync(installDir).length > 0) {
      log('  技能 ' + id + ': 已安装 (台账命中, 复用)')
      results.push({ id, status: 'reused', dir: installDir })
      continue
    }
    // 缓存命中 → 复制
    const hit = cacheHit(skill.sha1)
    if (hit) {
      fs.rmSync(installDir, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(installDir), { recursive: true })
      fs.cpSync(hit, installDir, { recursive: true })
      installed.recordSkill({ id, source: skill.source, sha1: skill.sha1, license: skill.license || '', path: installDir })
      log('  技能 ' + id + ': 缓存命中, 已安装')
      results.push({ id, status: 'cached', dir: installDir })
      continue
    }
    // 下载
    log('  技能 ' + id + ': 下载 ' + skill.source)
    fs.rmSync(installDir, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(installDir), { recursive: true })
    const r = await downloadSkill(skill, installDir)
    if (!r.ok) { log('  ❌ 技能 ' + id + ': ' + r.error); results.push({ id, status: 'error', error: r.error }); continue }
    const actualSha = r.sha1 || skill.sha1 || dirSha1(installDir)
    cachePut(actualSha, installDir)
    installed.recordSkill({ id, source: skill.source, sha1: actualSha, license: skill.license || '', path: installDir })
    log('  ✅ 技能 ' + id + ': 已安装 (sha1 校验通过)')
    results.push({ id, status: 'installed', dir: installDir })
  }
  return results
}

// ===== 插件 =====

async function processPlugins(plugins, log) {
  const results = []
  for (const p of (Array.isArray(plugins) ? plugins : [])) {
    const name = p.name
    if (installed.findPlugin(name)) { log('  插件 ' + name + ': 已安装 (台账命中, 跳过)'); results.push({ name, status: 'reused' }); continue }
    const spec = p.version ? name + '@' + p.version : name
    log('  插件 ' + spec + ': dsh plugin add …')
    const r = await runDsh(['plugin', '--profile', 'web', 'add', spec])
    if (r.ok) {
      installed.recordPlugin({ name, version: p.version || '', license: p.license || '', cli: r.cli.note })
      results.push({ name, status: 'installed' })
    } else {
      log('  ❌ 插件 ' + spec + ': ' + (r.error || r.output.slice(-300)))
      results.push({ name, status: 'error', error: r.error || r.output.slice(-300) })
    }
  }
  return results
}

// ===== MCP (生成 mcp-client 行) =====

function mcpRows(mcpServers, suffix) {
  return (Array.isArray(mcpServers) ? mcpServers : []).map((s) => {
    const base = String(s.serverName || s.id || 'mcp').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 22)
    const serverName = (base + '-' + suffix).slice(0, 32)
    const lines = ['- id: mcp-' + serverName, "  name: '@deepseek-ai/dsh-mcp-client'", '  config:']
    lines.push('    transport: ' + (s.transport === 'streamable-http' ? 'streamable-http' : 'stdio'))
    lines.push('    serverName: ' + yamlScalar(serverName))
    if (s.transport === 'streamable-http') {
      lines.push('    url: ' + yamlScalar(String(s.url || '')))
      const hdrs = (s.headers && typeof s.headers === 'object') ? s.headers : {}
      for (const k of Object.keys(hdrs)) lines.push('    headers:\n      ' + yamlKey(k) + ': ' + yamlScalar(String(hdrs[k])))
    } else {
      lines.push('    command: ' + yamlScalar(String(s.command || '')))
      for (const a of (Array.isArray(s.args) ? s.args : []).map(String).filter(Boolean)) lines.push('    args:\n      - ' + yamlScalar(a))
      const env = (s.env && typeof s.env === 'object') ? s.env : {}
      for (const k of Object.keys(env)) lines.push('    env:\n      ' + yamlKey(k) + ': ' + yamlScalar(String(env[k])))
      if (s.cwd) lines.push('    cwd: ' + yamlScalar(String(s.cwd)))
    }
    if (s.timeoutMs) lines.push('    toolCallTimeoutMs: ' + Number(s.timeoutMs))
    return lines.join('\n')
  })
}

function yamlScalar(v) {
  const s = String(v == null ? '' : v)
  if (/^[A-Za-z0-9_@./-]+$/.test(s) && !/^(true|false|null|yes|no|on|off|[-+]?\d)/i.test(s)) return s
  return "'" + s.replace(/'/g, "''") + "'"
}
function yamlKey(k) { const s = String(k); return /^[A-Za-z0-9_-]+$/.test(s) ? s : yamlScalar(s) }

// ===== 模式 =====

function installPresets(packDir, packSlug, log) {
  const src = path.join(packDir, 'presets')
  const installedIds = []
  if (!fs.existsSync(src)) return installedIds
  const presetRoot = path.join(dshHome(), '.agent-presets')
  fs.mkdirSync(presetRoot, { recursive: true })
  for (const name of fs.readdirSync(src, { withFileTypes: true })) {
    if (!name.isDirectory()) continue
    const comp = path.join(src, name.name, 'agent.cordis.yml')
    if (!fs.existsSync(comp)) continue
    const targetId = packSlug + '-' + name.name
    const target = path.join(presetRoot, targetId)
    fs.rmSync(target, { recursive: true, force: true })
    fs.mkdirSync(target, { recursive: true })
    fs.copyFileSync(comp, path.join(target, 'agent.cordis.yml'))
    const meta = path.join(src, name.name, 'preset.yml')
    if (fs.existsSync(meta)) fs.copyFileSync(meta, path.join(target, 'preset.yml'))
    installedIds.push(targetId)
    log('  模式 ' + targetId + ': 已安装到 .agent-presets/')
  }
  return installedIds
}

// ===== 模型 =====

function applyModels(packDir, log) {
  const file = path.join(packDir, 'models.json')
  if (!fs.existsSync(file)) return { applied: false }
  let m
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { log('  ❌ models.json 解析失败'); return { applied: false, error: 'models.json 解析失败' } }
  if (!m.provider || !m.baseURL) { log('  模型: 未配置 provider/baseURL, 跳过'); return { applied: false } }
  const home = dshHome()
  const text = readSettings()
  const apiKeyEnv = m.apiKeyEnv || String(m.provider).toUpperCase().replace(/[^A-Z0-9_]/g, '_') + '_API_KEY'
  const section = { apiKeyEnv, api: m.api || 'openai-completions', baseURL: m.baseURL }
  if (Array.isArray(m.models) && m.models.length) section.models = m.models.map((x) => typeof x === 'string' ? { id: x } : x)
  const provBlock = JSON.stringify(section, null, 2).replace(/"([^"]+)":/g, '$1:').replace(/"/g, "'").replace(/^/gm, '    ').replace(/'([A-Za-z0-9_-]+)':/g, '$1:')
  // 直接构造 YAML 段
  const yamlSection = ['', 'llm-pi-ai:', '  providers:']
  yamlSection.push('    ' + m.provider + ':')
  yamlSection.push('      apiKeyEnv: ' + apiKeyEnv)
  yamlSection.push('      api: ' + (m.api || 'openai-completions'))
  yamlSection.push('      baseURL: ' + yamlScalar(m.baseURL))
  if (Array.isArray(m.models) && m.models.length) {
    yamlSection.push('      models:')
    for (const x of m.models) yamlSection.push('        - id: ' + yamlScalar(typeof x === 'string' ? x : x.id))
  }
  const defaultBlock = 'agent-default-model:\n  provider: ' + m.provider + '\n  model: ' + yamlScalar(m.model || (Array.isArray(m.models) ? m.models[0] : 'deepseek-v4-flash')) + '\n'
  const out = text.trimEnd() + '\n' + yamlSection.join('\n') + '\n' + defaultBlock
  writeSettings(out)
  log('  ✅ 模型路由已应用 (备份在 settings.yaml.yellow-bak)')
  return { applied: true, provider: m.provider }
}

// ===== 补丁 =====

function applyPatches(packDir, log) {
  const file = path.join(packDir, 'patches.yaml')
  if (!fs.existsSync(file)) return { applied: false }
  const patchText = fs.readFileSync(file, 'utf8')
  const patchBody = patchText.replace(/^#.*$/gm, '').trim()
  if (patchBody === '' || patchBody === '[]') {
    log('  组合补丁: 空, 跳过')
    return { applied: false }
  }
  const profileDir = path.join(dshHome(), 'profiles', 'web')
  const target = path.join(profileDir, 'cordis.patch.yml')
  backupFile(target)
  let current = ''
  try { current = fs.readFileSync(target, 'utf8') } catch (e) {}
  // profile 补丁为空 (仅注释或 []) → 整体替换为包补丁; 否则把包补丁的列表条目追加到尾部
  const body = current.replace(/^#.*$/gm, '').trim()
  const merged = (body === '' || body === '[]')
    ? (current.replace(/\n*\s*\[\]\s*$/, '\n') + patchText.replace(/^#.*$/gm, '').trim() + '\n')
    : current.trimEnd() + '\n' + patchText.replace(/^#.*$/gm, '').trim() + '\n'
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(target, merged)
  log('  ✅ 组合补丁已合并进 cordis.patch.yml (备份在 .yellow-bak)')
  return { applied: true }
}

// ===== 派生预设 (基础模式 + 技能白名单 + MCP 行 + soul 人设) =====

const SINGLE_INSTANCE_ROWS = { cordis: ['tool-cordis'] }

function replaceRowBlock(text, rowId, newBlock) {
  const lines = text.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp('^- id: ' + rowId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$').test(lines[i])) { start = i; break }
  }
  if (start === -1) return text
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^- /.test(lines[i])) { end = i; break }
  }
  return lines.slice(0, start).concat(newBlock.split('\n'), lines.slice(end)).join('\n')
}

function disableRowBlock(text, rowId) {
  const lines = text.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp('^- id: ' + rowId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$').test(lines[i])) { start = i; break }
  }
  if (start === -1) return text
  let nameAt = -1
  for (let i = start + 1; i < lines.length; i++) {
    if (/^- /.test(lines[i])) break
    if (/^\s+name:/.test(lines[i])) { nameAt = i; break }
  }
  if (nameAt === -1) return text
  for (let i = start + 1; i < nameAt; i++) if (/^\s+disabled:/.test(lines[i])) return text
  lines.splice(nameAt + 1, 0, '  disabled: true')
  return lines.join('\n')
}

function patchSkillDirs(text, dirs) {
  const newRow = [
    '- id: skill-filesystem',
    "  name: '@deepseek-ai/dsh-skill-filesystem'",
    '  config:',
    '    customSkillDirs:',
  ].concat(dirs.map((d) => "      - '" + String(d).replace(/\\/g, '/').replace(/'/g, "''") + "'"))
  let out = replaceRowBlock(text, 'skill-filesystem', newRow.join('\n'))
  if (out === text) out = text.trimEnd() + '\n' + newRow.join('\n') + '\n'
  return out
}

function patchSoul(text, soulText) {
  const indented = soulText.split(/\r?\n/).map((l) => '        ' + l).join('\n')
  const newRow = [
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    text: |-',
    indented.trimEnd(),
  ].join('\n')
  let out = replaceRowBlock(text, 'persona', newRow)
  if (out === text) out = text.trimEnd() + '\n' + newRow + '\n'
  return out
}

/**
 * 从基础预设文本派生包预设: persona(soul) + skill-filesystem(白名单) + mcp 行。
 */
function derivePackPreset(baseText, { soul, skillDirs, mcpRows, baseId }) {
  let text = String(baseText || '')
  if (soul) text = patchSoul(text, soul)
  if (skillDirs && skillDirs.length) text = patchSkillDirs(text, skillDirs)
  for (const rowId of SINGLE_INSTANCE_ROWS[baseId] || []) text = disableRowBlock(text, rowId)
  if (mcpRows && mcpRows.length) {
    text = text.trimEnd() + '\n'
    for (const row of mcpRows) text += '\n# MCP (由 dshd Yellow 整合包追加)\n' + row + '\n'
  }
  return text
}

// ===== 主流程 =====

async function loadPack(opts, log) {
  const packPath = path.resolve(opts.pack)
  if (!fs.existsSync(packPath)) return { ok: false, error: '找不到包: ' + packPath }
  log('解包: ' + packPath)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yellow-'))
  let packDir
  try {
    packDir = unpackPack(packPath, tmp)
  } catch (e) {
    return { ok: false, error: e.message }
  }

  // 清单 + 校验
  const read = readManifest(packDir)
  if (!read.ok) return { ok: false, error: read.problems.join('; ') }
  const manifest = read.manifest
  const slug = String(manifest.name).toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'pack'
  log('包: ' + manifest.name + ' ' + manifest.versionId + ' | 协议: ' + manifest.license + ' | 打包时 DSH: ' + manifest.dshVersion)

  // 版本校验
  const actual = await dshVersion()
  if (!versionInRange(actual, manifest.dependencies.dsh)) {
    return { ok: false, error: 'DSH 版本不兼容: 当前 ' + actual + ' 不在包的声明范围 ' + manifest.dependencies.dsh + ' 内 (包基于 ' + manifest.dshVersion + ' 制作)' }
  }
  log('✅ DSH 版本 ' + actual + ' 在兼容范围 ' + manifest.dependencies.dsh + ' 内')

  // 协议汇总
  const comps = manifest.components || []
  const missingLic = comps.filter((c) => !c.license)
  log('组件 ' + comps.length + ' 个' + (missingLic.length ? ' ⚠ ' + missingLic.length + ' 个缺 license' : ''))

  // 技能
  const skillResults = manifest.skills && manifest.skills.length ? await processSkills(manifest.skills, log) : []
  const skillDirs = skillResults.filter((s) => s.status !== 'error').map((s) => s.dir)
  if (skillResults.some((s) => s.status === 'error')) return { ok: false, error: '技能下载失败', skillResults }

  // 插件
  let pluginResults = []
  if (manifest.plugins) {
    const pf = path.join(packDir, manifest.plugins.file)
    const raw = readJson(pf)
    const pluginList = Array.isArray(raw) ? raw : (raw ? [raw] : null)
    if (pluginList) {
      try { pluginResults = await processPlugins(pluginList, log) }
      catch (e) { log('  ⚠ plugins 处理失败: ' + e.message) }
    } else { log('  ⚠ plugins 文件缺失或非法: ' + pf) }
  }
  if (pluginResults.some((p) => p.status === 'error')) return { ok: false, error: '插件安装失败', pluginResults }

  // MCP
  let mcpRowsOut = []
  if (manifest.mcp) {
    const mf = path.join(packDir, manifest.mcp.file)
    const raw = readJson(mf)
    const servers = Array.isArray(raw) ? raw : (raw ? [raw] : null)
    if (servers) {
      const suffix = String(Date.now()).slice(-6)
      mcpRowsOut = mcpRows(servers, suffix)
      for (const s of servers) installed.recordMcp({ id: s.id, serverName: s.serverName || s.id, license: s.license || '', source: s.transport === 'streamable-http' ? s.url : (s.command + ' ' + (s.args || []).join(' ')).trim() })
      if (servers.length) log('  ✅ MCP ' + servers.length + ' 个已登记 (将挂载进包预设)')
    } else { log('  ⚠ mcp 文件缺失或非法: ' + mf) }
  }

  // 模式
  const packPresets = installPresets(packDir, slug, log)

  // 模型 / 补丁
  if (opts.applyModels !== false) applyModels(packDir, log)
  if (opts.applyPatches !== false) applyPatches(packDir, log)

  // 派生预设
  const baseId = opts.base || packPresets[0] || 'standard'
  log('基础模式: ' + baseId)
  const br = await rpc(dshPort(), 'agentPreset.read', { agentPreset: baseId })
  const baseText = br && br.result && br.result.ok ? br.result.value.content : null
  if (!baseText) return { ok: false, error: '无法读取基础模式 ' + baseId + ' (agentPreset.read 失败)' }

  const soulText = (manifest.soul && fs.existsSync(path.join(packDir, manifest.soul.file)))
    ? fs.readFileSync(path.join(packDir, manifest.soul.file), 'utf8').trim()
    : ''
  const presetId = 'yellow-' + slug + '-' + String(Date.now()).slice(-8)
  const content = derivePackPreset(baseText, { soul: soulText, skillDirs, mcpRows: mcpRowsOut, baseId })
  const presetRoot = path.join(dshHome(), '.agent-presets', presetId)
  fs.mkdirSync(presetRoot, { recursive: true })
  fs.writeFileSync(path.join(presetRoot, 'agent.cordis.yml'), content)
  fs.writeFileSync(path.join(presetRoot, 'preset.yml'),
    'name: ' + yamlScalar('整合包·' + manifest.name) + '\n' +
    'description: dshd Yellow: ' + (manifest.summary || '') + '\n' +
    'order: 9999\n')
  log('✅ 派生预设 ' + presetId + ' 已生成')

  // 会话: 新建 或 分叉
  let sessionId = null
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '')
  if (opts.forkFrom) {
    const fr = await rpc(dshPort(), 'session.fork', { sessionId: opts.forkFrom })
    const child = unwrap(fr)
    if (!child) return { ok: false, error: '分叉失败: ' + errorOf(fr) }
    const sel = await rpc(dshPort(), 'agentPreset.select', { sessionId: child.sessionId, agentPreset: presetId })
    if (!sel || !sel.result || !sel.result.ok) return { ok: false, error: '切换预设失败: ' + errorOf(sel) }
    sessionId = child.sessionId
    log('✅ 已分叉 ' + opts.forkFrom + ' → ' + sessionId + ' (加载包预设)')
  } else {
    const sid = 'session-yellow-' + stamp
    const cr = await rpc(dshPort(), 'session.create', { sessionId: sid, agentPreset: presetId })
    const created = unwrap(cr)
    if (!created) return { ok: false, error: '创建会话失败: ' + errorOf(cr) }
    sessionId = created.sessionId || sid
    log('✅ 新会话 ' + sessionId + ' 已创建 (预设 ' + presetId + ')')
  }

  // 台账: 记录包
  installed.recordPack({ name: manifest.name, versionId: manifest.versionId, license: manifest.license, presetId, sessionId, dshVersion: manifest.dshVersion })

  // 清理临时目录
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (e) {}

  return { ok: true, pack: manifest.name + ' ' + manifest.versionId, sessionId, presetId, url: 'http://127.0.0.1:' + dshPort() + '/', skillResults, pluginResults }
}

module.exports = { loadPack, derivePackPreset, unpackPack }

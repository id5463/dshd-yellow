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

module.exports = { packPack, initPack }

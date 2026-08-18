'use strict'
/**
 * dshd Yellow — dsh.index.json 规范 (formatVersion 1)。
 *
 * 发行清单只存引用 (地址 + 版本 + sha1), 零实质内容; 内容在独立文件
 * (soul.md / models.yaml / plugins.json / patches.yaml / mcp.yaml / presets/)。
 * 包必须携带: DSH 版本兼容声明 (预览版兼容性差) + 分发协议 (包 + 每个组件)。
 */

const FORMAT_VERSION = 1
const GAME = 'dsh'

/** 必需的顶层字段 */
const REQUIRED = ['formatVersion', 'game', 'name', 'versionId', 'license', 'dshVersion', 'dependencies']

/** 独立内容文件 (包内路径 → 字段); soul 用 md, patches 用 yaml(原样合并), 其余用 json(好解析) */
const CONTENT_FILES = {
  soul: 'soul.md',
  models: 'models.json',
  plugins: 'plugins.json',
  patches: 'patches.yaml',
  mcp: 'mcp.json',
}

function isNonEmptyString(v) { return typeof v === 'string' && v.trim() !== '' }

function problemsOf(manifest) {
  const problems = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['清单不是对象']
  if (manifest.formatVersion !== FORMAT_VERSION) problems.push('formatVersion 必须为 ' + FORMAT_VERSION)
  if (manifest.game !== GAME) problems.push('game 必须为 "dsh"')
  for (const k of ['name', 'versionId', 'license', 'dshVersion']) {
    if (!isNonEmptyString(manifest[k])) problems.push('缺少字符串字段: ' + k)
  }
  if (!manifest.dependencies || typeof manifest.dependencies !== 'object') problems.push('缺少 dependencies (至少含 dsh 版本范围)')
  else if (!isNonEmptyString(manifest.dependencies.dsh)) problems.push('dependencies.dsh (DSH 版本范围) 缺失')
  if (manifest.presets !== undefined) {
    if (!Array.isArray(manifest.presets) || !manifest.presets.every(isNonEmptyString)) problems.push('presets 必须是字符串数组 (包内 presets/ 下的模式目录名)')
  }
  if (manifest.skills !== undefined) {
    if (!Array.isArray(manifest.skills)) problems.push('skills 必须是数组')
    else for (const s of manifest.skills) {
      if (!isNonEmptyString(s && s.id)) problems.push('技能缺少 id')
      if (!isNonEmptyString(s && s.source)) problems.push('技能 ' + (s && s.id) + ' 缺少 source (github:owner/repo@path@ref)')
    }
  }
  if (manifest.files !== undefined) {
    if (!Array.isArray(manifest.files)) problems.push('files 必须是数组')
    else for (const f of manifest.files) {
      if (!isNonEmptyString(f && f.path)) problems.push('文件引用缺少 path')
      if (!f || !f.hashes || !isNonEmptyString(f.hashes.sha1)) problems.push('文件 ' + (f && f.path) + ' 缺少 hashes.sha1')
      if (!f || !Array.isArray(f.downloads) || !f.downloads.length) problems.push('文件 ' + (f && f.path) + ' 缺少 downloads')
    }
  }
  if (manifest.components !== undefined) {
    if (!Array.isArray(manifest.components)) problems.push('components 必须是数组')
    else for (const c of manifest.components) {
      if (!isNonEmptyString(c && c.id)) problems.push('组件缺少 id')
      if (c && c.type !== 'skill' && c.type !== 'mcp' && c.type !== 'plugin') problems.push('组件 ' + (c && c.id) + ' 的 type 必须是 skill|mcp|plugin')
      if (!isNonEmptyString(c && c.license)) problems.push('组件 ' + (c && c.id) + ' 缺少 license (分发协议)')
    }
  }
  return problems
}

/** 校验清单, 返回 { ok, problems, manifest } */
function validateManifest(manifest) {
  const problems = problemsOf(manifest)
  return { ok: problems.length === 0, problems, manifest }
}

/** 从包目录读取并校验 dsh.index.json */
function readManifest(packDir) {
  const fs = require('node:fs')
  const path = require('node:path')
  const file = path.join(packDir, 'dsh.index.json')
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) { return { ok: false, problems: ['包缺少 dsh.index.json'], manifest: null } }
  let manifest
  try { manifest = JSON.parse(raw) } catch (e) { return { ok: false, problems: ['dsh.index.json 不是合法 JSON: ' + e.message], manifest: null } }
  return validateManifest(manifest)
}

module.exports = { FORMAT_VERSION, GAME, CONTENT_FILES, validateManifest, readManifest }

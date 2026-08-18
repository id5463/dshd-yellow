'use strict'
/**
 * dshd Yellow — 安装台账: 记录已安装组件 (技能/MCP/插件) 的引用 + 内容哈希。
 * 加载前按 来源+哈希 查重, 命中即复用, 避免重复安装。
 */
const fs = require('node:fs')
const path = require('node:path')
const { yellowRoot } = require('./dsh.js')

function ledgerFile() { return path.join(yellowRoot(), 'installed.json') }

function readLedger() {
  try { return JSON.parse(fs.readFileSync(ledgerFile(), 'utf8')) } catch (e) { return { version: 1, skills: [], mcp: [], plugins: [], packs: [] } }
}

function writeLedger(ledger) {
  fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true })
  fs.writeFileSync(ledgerFile(), JSON.stringify(ledger, null, 2))
}

/** 已安装的技能条目: {id, source, sha1, path, license, installedAt} */
function findSkill(id, source, sha1) {
  const l = readLedger()
  return l.skills.find((s) => s.id === id && (source ? s.source === source : true) && (sha1 ? s.sha1 === sha1 : true))
}

/** 已安装的 MCP 条目 */
function findMcp(id) {
  return readLedger().mcp.find((m) => m.id === id)
}

/** 已安装的插件条目 */
function findPlugin(name) {
  return readLedger().plugins.find((p) => p.name === name)
}

/** 已安装的包 (整合包加载记录) */
function findPack(name, versionId) {
  return readLedger().packs.find((p) => p.name === name && p.versionId === versionId)
}

function recordSkill(entry) {
  const l = readLedger()
  l.skills = l.skills.filter((s) => !(s.id === entry.id && entry.source === s.source))
  l.skills.push({ installedAt: new Date().toISOString(), ...entry })
  writeLedger(l)
}

function recordMcp(entry) {
  const l = readLedger()
  l.mcp = l.mcp.filter((m) => m.id !== entry.id)
  l.mcp.push({ installedAt: new Date().toISOString(), ...entry })
  writeLedger(l)
}

function recordPlugin(entry) {
  const l = readLedger()
  l.plugins = l.plugins.filter((p) => p.name !== entry.name)
  l.plugins.push({ installedAt: new Date().toISOString(), ...entry })
  writeLedger(l)
}

function recordPack(entry) {
  const l = readLedger()
  l.packs = l.packs.filter((p) => !(p.name === entry.name && p.versionId === entry.versionId))
  l.packs.push({ installedAt: new Date().toISOString(), ...entry })
  writeLedger(l)
}

/** 技能安装位置: ~/.dshd-yellow/skills/<id> */
function skillInstallDir(id) {
  return path.join(yellowRoot(), 'skills', String(id).replace(/[^A-Za-z0-9._-]/g, '-'))
}

module.exports = {
  ledgerFile, readLedger, writeLedger,
  findSkill, findMcp, findPlugin, findPack,
  recordSkill, recordMcp, recordPlugin, recordPack, skillInstallDir,
}

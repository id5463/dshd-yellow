'use strict'
/**
 * dshd Yellow — 下载器: GitHub / 通用 URL + sha1 校验 + 共享缓存。
 * 技能等按内容哈希缓存 (~/.dshd-yellow/cache/<sha1>/), 多包共享, 不重复下载。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

function cacheRoot() {
  return process.env.DSH_YELLOW_HOME ? path.join(process.env.DSH_YELLOW_HOME, 'cache') : path.join(os.homedir(), '.dshd-yellow', 'cache')
}

function sha1Of(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex')
}

function sha1OfFile(file) {
  return sha1Of(fs.readFileSync(file))
}

function isUrl(s) { return /^https?:\/\//i.test(s) }

/** 解析技能引用 github:owner/repo@path@ref → {owner, repo, path, ref, archiveUrl} */
function parseGithubRef(source) {
  const m = String(source).match(/^github:([^/@]+)\/([^@]+?)(?:@(.+))?$/)
  if (!m) return null
  const owner = m[1]
  const repo = m[2].replace(/\.git$/, '')
  const rest = m[3] || ''
  const at = rest.lastIndexOf('@')
  let refPath = rest
  let ref = 'HEAD'
  if (at > 0) { refPath = rest.slice(0, at); ref = rest.slice(at + 1) }
  return { owner, repo, refPath: refPath || '.', ref: ref || 'HEAD' }
}

/** 用 gh 下载 GitHub 仓库某路径 (ref) 到目标目录; 返回 {ok, error} */
function downloadGithubPath(source, targetDir) {
  const g = parseGithubRef(source)
  if (!g) return { ok: false, error: '无法解析 GitHub 引用: ' + source + ' (期望 github:owner/repo@path@ref)' }
  fs.mkdirSync(targetDir, { recursive: true })
  // gh api 获取该路径在 ref 下的树条目
  const tree = ghApi(g.owner + '/' + g.repo + '/git/trees/' + g.ref + '?recursive=1')
  if (tree === null) return { ok: false, error: 'gh 无法读取 ' + g.owner + '/' + g.repo + ' @ ' + g.ref }
  let items
  try { items = JSON.parse(tree) } catch (e) { return { ok: false, error: 'gh 返回非 JSON' } }
  const prefix = String(g.refPath).replace(/^\/+/, '').replace(/\/+$/, '')
  const wanted = (items.tree || []).filter((t) => t.type === 'blob' && (prefix ? t.path === prefix || t.path.startsWith(prefix + '/') : true))
  if (!wanted.length) return { ok: false, error: '在 ' + g.owner + '/' + g.repo + '@' + g.ref + ' 找不到路径 ' + (prefix || '/') }
  let failed = null
  for (const w of wanted) {
    const rel = prefix ? w.path.slice(prefix.length).replace(/^\/+/, '') : w.path
    const dest = path.join(targetDir, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const raw = ghApiRaw(g.owner + '/' + g.repo + '/contents/' + w.path + '?ref=' + g.ref)
    if (raw === null) { failed = w.path; continue }
    fs.writeFileSync(dest, raw)
  }
  if (failed && !wanted.length) return { ok: false, error: '下载失败: ' + failed }
  return { ok: true, files: wanted.length }
}

function ghApi(endpoint) {
  try {
    const r = spawnSync('gh', ['api', endpoint], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] })
    if (r.status !== 0) return null
    return r.stdout
  } catch (e) { return null }
}

function ghApiRaw(endpoint) {
  try {
    const r = spawnSync('gh', ['api', endpoint, '-H', 'Accept: application/vnd.github.raw'], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
    if (r.status !== 0) return null
    return r.stdout
  } catch (e) { return null }
}

/** 下载 URL 到文件 (带回退 host), 返回 {ok, error} */
function downloadUrl(url, dest) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? require('node:https') : require('node:http')
    const req = mod.get(url, { headers: { 'user-agent': 'dshd-yellow/' + (require('../package.json').version || '0.1.0') }, timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        downloadUrl(res.headers.location, dest).then(resolve)
        return
      }
      if (res.statusCode !== 200) { res.resume(); resolve({ ok: false, error: 'HTTP ' + res.statusCode + ' ' + url }) ; return }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try { fs.writeFileSync(dest, Buffer.concat(chunks)) ; resolve({ ok: true }) }
        catch (e) { resolve({ ok: false, error: e.message }) }
      })
    })
    req.on('error', (e) => resolve({ ok: false, error: e.message }))
    req.on('timeout', () => { try { req.destroy() } catch (e) {} resolve({ ok: false, error: '超时' }) })
  })
}

/**
 * 按引用下载"技能"到目标目录并做 sha1 校验。
 * 对单个文件引用 (path 指向文件) 校验该文件; 对目录引用校验整体目录哈希 (自定义算法: 路径排序拼接)。
 * @param {object} skill - {id, source, sha1?}
 * @param {string} targetDir - 下载目标目录 (缓存或安装位置)
 * @returns {Promise<{ok, error?, files?}>}
 */
async function downloadSkill(skill, targetDir) {
  const src = String(skill.source || '')
  const singleFile = isUrl(src)
  const r = src.startsWith('github:')
    ? downloadGithubPath(src, targetDir)
    : singleFile
      ? await (async () => {
        fs.mkdirSync(targetDir, { recursive: true })
        const dest = path.join(targetDir, path.basename(targetDir) + '.md')
        return await downloadUrl(src, dest)
      })()
      : { ok: false, error: '未知来源: ' + src }
  if (!r.ok) return r
  // sha1 校验: 单文件 (URL) 校验文件本身; 目录 (GitHub) 校验目录哈希
  const actual = singleFile
    ? sha1OfFile(path.join(targetDir, path.basename(targetDir) + '.md'))
    : dirSha1(targetDir)
  if (skill.sha1 && actual !== skill.sha1) {
    return { ok: false, error: '哈希校验失败: 声明 ' + skill.sha1 + ' ≠ 实际 ' + actual + ' (' + skill.id + ')' }
  }
  return { ok: true, files: r.files, sha1: actual }
}

/** 目录整体 sha1 (确定性: 相对路径排序 + 内容哈希拼接) */
function dirSha1(dir) {
  const all = []
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f)
      const st = fs.statSync(p)
      if (st.isDirectory()) walk(p)
      else all.push(p)
    }
  }
  try { walk(dir) } catch (e) { return '' }
  all.sort()
  const h = crypto.createHash('sha1')
  for (const p of all) {
    h.update(path.relative(dir, p).replace(/\\/g, '/'))
    h.update(':')
    try { h.update(fs.readFileSync(p)) } catch (e) { h.update('?') }
    h.update('\n')
  }
  return h.digest('hex')
}

/** 命中缓存 (sha1 已知): 返回缓存目录或 null */
function cacheHit(sha1) {
  if (!sha1) return null
  const dir = path.join(cacheRoot(), sha1)
  try { if (fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0) return dir } catch (e) { /* miss */ }
  return null
}

/** 写入缓存 */
function cachePut(sha1, sourceDir) {
  try {
    const dir = path.join(cacheRoot(), sha1)
    fs.mkdirSync(dir, { recursive: true })
    for (const f of fs.readdirSync(sourceDir)) {
      const src = path.join(sourceDir, f)
      fs.cpSync(src, path.join(dir, f), { recursive: true })
    }
    return dir
  } catch (e) { return null }
}

module.exports = {
  cacheRoot, sha1Of, sha1OfFile, dirSha1, parseGithubRef,
  downloadGithubPath, downloadUrl, downloadSkill, cacheHit, cachePut,
}

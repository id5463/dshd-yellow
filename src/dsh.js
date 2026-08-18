'use strict'
/**
 * dshd Yellow — 与 DSH 的交互层。只走 DSH 的公开机制:
 *   JSON-RPC (session.* / agentPreset.* / settings.* / credentials.*) + dsh CLI (插件安装/版本)。
 * 所有写操作先备份。零依赖。
 */
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

function dshHome() { return process.env.DSH_HOME || path.join(os.homedir(), '.dsh') }

function yellowRoot() { return process.env.DSH_YELLOW_HOME || path.join(os.homedir(), '.dshd-yellow') }

/** DSH HTTP JSON-RPC: POST /api/<method> */
function rpc(port, method, payload, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      type: 'client-request', rpcId: 'dshd-yellow-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      method, payload,
    })
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/api/' + method, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c; if (d.length > 4 * 1024 * 1024) res.destroy() })
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { resolve(null) } })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { try { req.destroy() } catch (e) {} resolve(null) })
    req.end(body)
  })
}

function unwrap(r) { return r && r.result && r.result.ok === true ? r.result.value : null }
function errorOf(r) {
  const e = r && r.result && r.result.error
  return e && (e.message || JSON.stringify(e)) || '无响应'
}

/** 主 DSH 端口 */
function dshPort() { return Number(process.env.DSH_PORT) || 3080 }

/** 解析独立 dsh CLI (与 dshd Green 同款): 显式 > 本机 DSH 源码 > npx */
function resolveDshCli() {
  if (process.env.DSH_GREEN_DSH || process.env.DSH_YELLOW_DSH) {
    const p = process.env.DSH_YELLOW_DSH || process.env.DSH_GREEN_DSH
    const parts = String(p).split(' ')
    return { argv: parts, note: 'DSH_YELLOW_DSH 指定', shell: false }
  }
  const dev = [
    path.join(__dirname, '..', '..', '..', 'apps', 'cli', 'lib', 'bin.js'),
    path.join(__dirname, '..', '..', '..', '..', 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js'),
  ]
  for (const p of dev) {
    if (fs.existsSync(p)) return { argv: ['node', p], note: '本地 DSH 源码 (开发)', shell: false }
  }
  return { argv: ['npx', '-y', '@deepseek-ai/dsh'], note: 'npx 独立安装 @deepseek-ai/dsh', shell: process.platform === 'win32' }
}

/** 运行 dsh CLI 并返回输出 */
function runDsh(args) {
  return new Promise((resolve) => {
    const cli = resolveDshCli()
    const child = spawn(cli.argv[0], [...cli.argv.slice(1), ...args], {
      env: { ...process.env, DSH_HOME: dshHome() }, shell: cli.shell, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { out += d.toString() })
    child.on('error', (e) => resolve({ ok: false, error: e.message, output: out, cli }))
    child.on('exit', (code) => resolve({ ok: code === 0, code, output: out, cli }))
  })
}

/** 读主 DSH 版本: 优先 dsh --version (CLI 真实版本), 回退 host.describe (忽略 0.0.1 占位) */
async function dshVersion() {
  const cli = await runDsh(['--version'])
  const m = cli.output.trim().match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/)
  if (m && m[1] !== '0.0.1') return m[1]
  const r = await rpc(dshPort(), 'host.describe', {})
  const v = unwrap(r)
  if (v && (v.version || v.dshVersion)) {
    const s = String(v.version || v.dshVersion)
    if (s !== '0.0.1') return s
  }
  return m ? m[1] : null
}

/** 语义化版本范围校验 (支持 >=x.y.z <x.y.z、=、^、~、*、空格组合) */
function versionInRange(version, range) {
  if (!version || !range) return false
  const parse = (v) => { const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/) || String(v).match(/^(\d+)\.(\d+)$/); return m ? { major: +m[1], minor: +m[2], patch: +(m[3] || 0), pre: m[4] || '' } : null }
  const cmp = (a, b) => {
    if (a.major !== b.major) return a.major - b.major
    if (a.minor !== b.minor) return a.minor - b.minor
    if (a.patch !== b.patch) return a.patch - b.patch
    if (a.pre === b.pre) return 0
    if (a.pre === '') return 1
    if (b.pre === '') return -1
    return a.pre < b.pre ? -1 : 1
  }
  const target = parse(version)
  if (!target) return false
  const clauses = String(range).split(/\s+/).filter(Boolean)
  for (const clause of clauses) {
    const m = clause.match(/^(>=|<=|>|<|=|\^|~)?(.*)$/)
    const op = m[1] || '='
    const bound = parse(m[2])
    if (!bound) continue
    const c = cmp(target, bound)
    if (op === '>=' && c < 0) return false
    if (op === '<=' && c > 0) return false
    if (op === '>' && c <= 0) return false
    if (op === '<' && c >= 0) return false
    if (op === '=' && c !== 0) return false
    if (op === '^') {
      if (bound.major > 0 && (target.major !== bound.major || c < 0)) return false
      if (bound.major === 0 && bound.minor > 0 && (target.major !== 0 || target.minor !== bound.minor || c < 0)) return false
    }
    if (op === '~') {
      if (target.major !== bound.major || target.minor !== bound.minor || c < 0) return false
    }
  }
  return true
}

/** 备份文件 (写前), 返回备份路径 */
function backupFile(file) {
  if (!fs.existsSync(file)) return null
  const bak = file + '.yellow-bak'
  fs.copyFileSync(file, bak)
  return bak
}

/** 读 JSON 文件 (容忍 UTF-8 BOM), 失败返回 null */
function readJson(file) {
  try {
    let raw = fs.readFileSync(file, 'utf8')
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
    return JSON.parse(raw)
  } catch (e) { return null }
}

/** 读 settings.yaml 文本 */
function readSettings() {
  try { return fs.readFileSync(path.join(dshHome(), 'settings.yaml'), 'utf8') } catch (e) { return '' }
}

/** 写 settings.yaml (先备份) */
function writeSettings(text) {
  const file = path.join(dshHome(), 'settings.yaml')
  backupFile(file)
  fs.writeFileSync(file, text)
  return true
}

/** 读 .credentials.yaml 的 env 键集合 */
function credentialEnvNames() {
  try {
    const txt = fs.readFileSync(path.join(dshHome(), '.credentials.yaml'), 'utf8')
    return [...txt.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1])
  } catch (e) { return [] }
}

module.exports = {
  dshHome, yellowRoot, rpc, unwrap, errorOf, dshPort, readJson,
  resolveDshCli, runDsh, dshVersion, versionInRange,
  backupFile, readSettings, writeSettings, credentialEnvNames,
}

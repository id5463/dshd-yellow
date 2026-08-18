'use strict'
/**
 * dshd Yellow — 整合包工具 (modpack tool for DSH): 打包 + 加载。
 * 独立项目: 使用它不需要安装 DSH (加载时通过公开机制调用 DSH)。
 */
const path = require('node:path')
const { packPack, initPack } = require('./pack.js')
const { loadPack } = require('./load.js')
const { readManifest, validateManifest } = require('./format.js')
const installed = require('./installed.js')
const { dshVersion, resolveDshCli } = require('./dsh.js')

const VERSION = '0.1.0'

function parseArgs(argv) {
  const out = { json: false, help: false, cmd: null, extras: [] }
  const kv = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a === '--version' || a === '-v') out.cmd = 'version'
    else if (a.startsWith('--')) {
      const key = a.slice(2)
      kv[key] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true
    } else if (!out.cmd) out.cmd = a
    else out.extras.push(a)
  }
  out.kv = kv
  return out
}

function emitJson(obj) { console.log(JSON.stringify(obj)) }

async function main(argv) {
  const o = parseArgs(argv)
  const log = (line) => { if (!o.json) console.log(line) }
  switch (o.cmd) {
    case 'version': console.log('dshd-yellow ' + VERSION); return 0

    case 'init': {
      const name = o.extras[0] || o.kv.name
      if (!name) { console.error('用法: dshd-yellow init <包名>'); return 1 }
      const dir = initPack(name)
      log('✅ 包工作目录已创建: ' + dir)
      log('编辑 dsh.json / soul.md / models.json / plugins.json / mcp.json, 然后 dshd-yellow pack --from ' + dir)
      return 0
    }

    case 'pack': {
      if (o.kv['from-session']) {
        const { exportFromSession } = require('./pack.js')
        const r = await exportFromSession({
          sessionId: o.kv['from-session'], base: o.kv.base,
          name: o.kv.name, version: o.kv.version, license: o.kv.license,
          out: o.kv.out, dshRange: o.kv['dsh-range'],
        })
        if (!r.ok) { if (o.json) emitJson({ ok: false, error: r.error, problems: r.problems }); else { console.error('导出失败: ' + r.error); if (r.problems && r.problems.length) console.log('  ' + r.problems.join('\n  ')) } return 1 }
        if (o.json) emitJson({ ok: true, out: r.out, zip: r.zip, base: r.base, problems: r.problems })
        else {
          log('✅ 已从会话导出整合包: ' + r.out)
          log('   基础模式: ' + r.base + ' (已打进 presets/)')
          if (r.problems && r.problems.length) log('  ⚠ ' + r.problems.join('\n  ⚠ '))
        }
        return 0
      }
      const r = await packPack({
        from: o.kv.from || o.kv.dir,
        out: o.kv.out,
        name: o.kv.name, version: o.kv.version, license: o.kv.license, dshRange: o.kv['dsh-range'],
      })
      if (!r.ok) {
        if (o.json) emitJson({ ok: false, error: r.error, problems: r.problems })
        else console.error('❌ ' + r.error)
        return 1
      }
      if (o.json) emitJson({ ok: true, out: r.out, zip: r.zip, name: r.manifest.name, versionId: r.manifest.versionId })
      else { log('✅ 已打包: ' + r.out); if (r.note) log(r.note) }
      return 0
    }

    case 'load': {
      const pack = o.extras[0] || o.kv.pack
      if (!pack) { console.error('用法: dshd-yellow load <包.dshpack|目录> [--fork-from <会话id>] [--base <模式>]'); return 1 }
      const r = await loadPack({
        pack,
        forkFrom: o.kv['fork-from'],
        base: o.kv.base,
        applyModels: o.kv['no-models'] ? false : true,
        applyPatches: o.kv['no-patches'] ? false : true,
      }, log)
      if (!r.ok) {
        if (o.json) emitJson({ ok: false, error: r.error })
        else console.error('❌ ' + r.error)
        return 1
      }
      if (o.json) emitJson(r)
      else {
        log('✅ 加载完成: ' + r.pack)
        log('   会话: ' + r.sessionId + ' (' + r.presetId + ')')
        log('   查看: ' + r.url)
      }
      return 0
    }

    case 'list': {
      const l = installed.readLedger()
      const packs = l.packs || []
      const dshVer = await dshVersion().catch(() => null)
      if (o.json) emitJson({ ok: true, dshVersion: dshVer, packs, skills: l.skills || [], mcp: l.mcp || [], plugins: l.plugins || [] })
      else {
        log('dshd Yellow — 已安装')
        if (!packs.length) log('  (还没有加载过整合包)')
        for (const p of packs) log('  🧳 ' + p.name + ' ' + p.versionId + '  [' + p.license + '] → 会话 ' + p.sessionId)
        if ((l.skills || []).length) log('  技能 ' + l.skills.length + ' 个 (台账, 哈希去重)')
        if ((l.mcp || []).length) log('  MCP ' + l.mcp.length + ' 个 (台账)')
        if ((l.plugins || []).length) log('  插件 ' + l.plugins.length + ' 个 (台账)')
      }
      return 0
    }

    case 'info': {
      const pack = o.extras[0]
      if (!pack) { console.error('用法: dshd-yellow info <包>'); return 1 }
      const tmp = require('node:os').tmpdir()
      const dir = require('node:fs').mkdtempSync(path.join(tmp, 'yellow-info-'))
      try {
        const { unpackPack } = require('./load.js')
        unpackPack(path.resolve(pack), dir)
        const r = readManifest(dir)
        if (o.json) emitJson(r.ok ? { ok: true, manifest: r.manifest } : { ok: false, error: r.problems.join('; ') })
        else if (r.ok) { log(JSON.stringify(r.manifest, null, 2)) }
        else console.error('❌ ' + r.problems.join('; '))
        return r.ok ? 0 : 1
      } finally { try { require('node:fs').rmSync(dir, { recursive: true, force: true }) } catch (e) {} }
    }

    case 'verify': {
      const pack = o.extras[0]
      if (!pack) { console.error('用法: dshd-yellow verify <包>'); return 1 }
      const fs = require('node:fs')
      const os = require('node:os')
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yellow-verify-'))
      try {
        const { unpackPack } = require('./load.js')
        unpackPack(path.resolve(pack), dir)
        const r = readManifest(dir)
        if (!r.ok) { if (o.json) emitJson({ ok: false, problems: r.problems }); else console.error('❌ ' + r.problems.join('; ')); return 1 }
        const v = validateManifest(r.manifest)
        // 校验内容文件存在
        const { CONTENT_FILES } = require('./format.js')
        const missing = []
        for (const [field, file] of Object.entries(CONTENT_FILES)) {
          if (r.manifest[field] && !fs.existsSync(path.join(dir, file))) missing.push(file)
        }
        const ok = v.ok && missing.length === 0
        if (o.json) emitJson({ ok, problems: v.problems, missingFiles: missing, manifest: r.manifest })
        else { log(ok ? '✅ 包完整: ' + r.manifest.name + ' ' + r.manifest.versionId : '❌ 包有问题'); if (missing.length) log('  缺少: ' + missing.join(', ')) }
        return ok ? 0 : 1
      } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {} }
    }

    case 'help':
    case null:
    default:
      console.log(
        'dshd Yellow ' + VERSION + ' — 整合包工具 / modpack tool for DSH\n' +
        '把 DSH 的可改面 (技能/插件/MCP/模式/模型/补丁/灵魂) 打包成纯引用清单,\n' +
        '需要时按哈希去重下载, 加载成新会话或分叉。独立项目, 不依赖 DSH 安装。\n' +
        '\n用法 / usage:\n' +
        '  dshd-yellow init <包名>            创建包工作目录骨架\n' +
        '  dshd-yellow pack --from <目录> [--out <文件>]   打包成 .dshpack\n' +
        '  dshd-yellow load <包> [--fork-from <会话id>] [--base <模式>]   加载成新会话/分叉\n' +
        '  dshd-yellow list                   查看已安装 (台账)\n' +
        '  dshd-yellow info <包>              查看包清单\n' +
        '  dshd-yellow verify <包>            校验包完整性\n' +
        '\n选项: --json · --version\n' +
        '环境: DSH_HOME (主 DSH 数据目录) · DSH_YELLOW_DSH (dsh CLI) · DSH_YELLOW_HOME (Yellow 数据根)\n' +
        '铁律: 只存引用零内容 · 哈希去重不重复安装 · 版本兼容声明 · 协议标注 · 只加载新会话/分叉\n'
      )
      return 0
  }
}

module.exports = { main, VERSION }

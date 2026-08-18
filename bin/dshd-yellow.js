#!/usr/bin/env node
'use strict'
require('../src/index.js').main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code ?? 0 },
  (err) => { console.error('dshd-yellow 异常: ' + (err && err.message || err)); process.exitCode = 1 },
)

#!/usr/bin/env node

const run = require('./index')

const parseArgs = require('minimist')

const argv = parseArgs(process.argv.slice(2), {
  '--': true,
})

const {
  '--': nodeParams,
  ...babelWatchExtraParams
} = argv

let {
  dist: distPath,
  src: srcPath,
  'ignore-dot-files': ignoreDotFiles,
  'ignore-files': ignoreFiles = '.goutputstream-*',
  'compile-extensions': compileExtensions,
  'watch-extensions': watchExtensions,
  'watch-extra': watchExtra,
  'source-maps': sourceMaps,
  'verbose': verbose,
  _: entryPoints,
} = babelWatchExtraParams

if(ignoreFiles)
  ignoreFiles = ignoreFiles.split(',')

if(compileExtensions)
  compileExtensions = compileExtensions.split(',')

if(watchExtensions)
  watchExtensions = watchExtensions.split(',')

if(watchExtra)
  watchExtra = watchExtra.split(',')


const config = {
  distPath,
  srcPath,
  entryPoints,
  ignoreDotFiles,
  ignoreFiles,
  compileExtensions,
  watchExtensions,
  watchExtra,
  sourceMaps,
  verbose,
}

// console.log(argv, config)

run(config)

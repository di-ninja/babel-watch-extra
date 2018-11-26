const fs = require('fs-extra')
const path = require('path')
const rimraf = require('rimraf')
const babel = require('@babel/core')
const chokidar = require('chokidar')
const globToRegExp = require('glob-to-regexp')


const {
  spawn,
  spawnSync,
} = require('child_process')

const babelBin = './node_modules/.bin/babel'
const nodemonBin = './node_modules/.bin/nodemon'

const compileDependenciesSuffix = '.compileDependencies.js'
function loadDependenciesMap (folder, compileDependenciesMap = {}) {
  fs.readdirSync(folder).forEach(function (file) {
    const name = path.resolve(folder, file)
    const isDir = fs.statSync(name).isDirectory()
    if(isDir){
      loadDependenciesMap(name, compileDependenciesMap)
    }
    else if(name.slice(-1*compileDependenciesSuffix.length)===compileDependenciesSuffix){
      const sourceName = name.slice(0, -1*compileDependenciesSuffix)
      compileDependenciesMap[sourceName] = JSON.parse(fs.readfileSync(name, 'utf-8'))
    }
  })
  return compileDependenciesMap
}

async function run({
  entryPoints = [
    'index.js',
  ],
  srcPath = 'src',
  distPath = 'dist',
  ignoreDotFiles = false,
  ignoreFiles = [],
  sourceMaps = true,
  verbose = true,
  compileExtensions = ['js','jsx'],
  watchExtensions = ['js','ejs'],
  watchExtra = ['.env'],
}){
  
  const compileDependenciesMap = loadDependenciesMap(srcPath)
  const compileDependenciesMapReverse = Object.entries(compileDependenciesMap).reduce(([o, key, value])=>{
    if(!o[value]){
      o[value] = []
    }
    o[value].push(key)
    return o
  },{})
  
  function compileFile(filename){
    const relativeFilename = filename.slice(srcPath.length+1)
    const srcFilepath = path.join(srcPath, relativeFilename)
    const distFilepath = path.join(distPath, relativeFilename)
    babel.transformFileAsync(srcFilepath).then(({ code, map, ast })=>{
      fs.writeFile(distFilepath, code, err=>{
        if(err){
          console.error(err)
        }
        else if(verbose){
          console.log(srcFilepath, ' -> ', distFilepath)
        }
      })
      if(sourceMaps){
        fs.writeFile(distFilepath+'.map', map, err=>{
          if(err){
            console.error(err)
          }
        })
      }
    })
  }

  async function copyFile(filename){
    const relativeFilename = filename.slice(srcPath.length+1)
    const srcFilepath = path.join(srcPath, relativeFilename)
    const distFilepath = path.join(distPath, relativeFilename)
    try{
      await fs.copy(srcFilepath, distFilepath)
      if(verbose){
        console.log(srcFilepath, ' -> ', distFilepath)
      }
    }
    catch(err){
      console.error(err)
    }
  }

  async function addDir(filename){
    const relativeFilename = filename.slice(srcPath.length+1)
    const distFilepath = path.join(distPath, relativeFilename)
    try{
      await fs.ensureDir(distFilepath)
      if(verbose){
        console.log(distFilepath, ' +')
      }
    }
    catch(err){
      console.error(err)
    }
  }
  
  async function unlinkDir(filename){
    const relativeFilename = filename.slice(srcPath.length+1)
    const distFilepath = path.join(distPath, relativeFilename)
    if(await fs.pathExists(distFilepath)){
      rimraf(distFilepath, err=>{
        if(err){
          console.err(err)
        }
        else if(verbose){
          console.log(distFilepath, ' x')
        }
      })
    }
  }
  
  async function unlinkFile(filename){
    const relativeFilename = filename.slice(srcPath.length+1)
    const distFilepath = path.join(distPath, relativeFilename)
    if(await fs.pathExists(distFilepath)){
      rimraf(distFilepath, err=>{
        if(err){
          console.err(err)
        }
        else if(verbose){
          console.log(distFilepath, ' x')
        }
      })
    }
    if(sourceMaps){
      if(await fs.pathExists(distFilepath+'.map')){
        rimraf(distFilepath+'.map', err=>{
          if(err){
            console.err(err)
          }
        })
      }
    }
  }

  
  const ignoreFilesRegex = ignoreFiles.map(str=>globToRegExp(str))
  function ignoreFile(filename){
    const relativeFilename = filename.slice(srcPath.length+1)
    if(ignoreDotFiles && filename.slice(0,1)==='.')
      return true
    
    return ignoreFilesRegex.some(re=> re.test(relativeFilename))
  }

  function compileThisFile(filename){
    return compileExtensions.some(ext=> '.'+ext === filename.slice(-1*(compileExtensions.length+1)))
  }
  
  function compileDependentFiles(relativeFilename){
    const compileDependentFileList = compileDependenciesMapReverse[relativeFilename]
    if(compileDependentFileList){
      compileDependentFileList.forEach(file=>{
        const srcFilepath = path.join(srcPath, file)
        const distFilepath = path.join(distPath, file)
        babel.transformFileAsync(srcFilepath).then(({ code, map, ast })=>{
          fs.writeFile(distFilepath, code, e=>e&&console.error(e))
          if(sourceMaps){
            fs.writeFile(distFilepath+'.map', map, e=>e&&console.error(e))
          }
        })
      })
    }
  }

  function handleFile(event, filename){
    const relativeFilename = filename.slice(srcPath.length+1)
    
    if(ignoreFile(relativeFilename))
      return
    
    compileDependentFiles(relativeFilename)
    
    switch(event){
      case 'add':
      case 'change':
        if(compileThisFile(filename)){
          compileFile(filename)
        }
        else{
          copyFile(filename)
        }
        break
      case 'unlink':
        unlinkFile(filename)
        break
      case 'addDir':
        addDir(filename)
        break
      case 'unlinkDir':
        unlinkDir(filename)
        break
    }
  }

  function babelBuild(){
    
    const params = [
      srcPath,
      '--out-dir',distPath,
      '--delete-dir-on-start',
      '--copy-files',
    ]
    
    if(!ignoreDotFiles)
      params.push('--include-dotfiles')
    
    if(sourceMaps)
      params.push('--source-maps')
      
    if(verbose)
      params.push('--verbose')
      
    spawnSync(babelBin, params, {
      stdio: ['inherit','inherit','inherit'],
      env: {
        ...process.env,
      }
    })
  }
  
  function babelWatch(){
    
    const ignored = undefined
    
    const watcher = chokidar.watch(srcPath, {
      ignored,
      persistent: true,
      ignoreInitial: true,
      depth: Infinity,
    })
    
    watcher.on('all', handleFile)
  }

  function nodemonWatch({
    entryPoints = []
  }={}){
    for(const entryPoint of entryPoints){
      const params = [
        '--trace-warnings',
        '--pending-deprecation',
        '--stack-trace-limit=1000',
        '--stack-size=1024',
        path.join(distPath, entryPoint),
        '--watch', distPath,
      ]
      if(watchExtra){
        watchExtra.forEach(f=>params.push('--watch', f))
      }
      params.push('-e', watchExtensions.join(','))
      spawn(nodemonBin, params, {
        stdio:['inherit', 'inherit', 'inherit'],
        env: {
          NODE_ENV: 'development',
          ...process.env,
        },
      })
      
    }
  }
  
  babelWatch()
  babelBuild()
  
  const nodemonWatchConfig = {
    entryPoints,
  }
  nodemonWatch(nodemonWatchConfig)
  
}

module.exports = run

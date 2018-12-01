const fs = require('fs-extra')
const path = require('path')
const rimraf = require('rimraf')
const {
  transformFileAsync,
  transformAsync,
} = require('@babel/core')
const traverse = require('@babel/traverse').default
const chokidar = require('chokidar')
const globToRegExp = require('glob-to-regexp')
const JSON5 = require('json5')

const {
  spawn,
  spawnSync,
} = require('child_process')

const babelBin = './node_modules/.bin/babel'
const nodemonBin = './node_modules/.bin/nodemon'
const serializeError = require('serialize-error')
const deserializeError = require('deserialize-error')
const jsStringEscape = require('js-string-escape')

const compileDependenciesPrefix = '@compileDependencies'

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
  compileExtensions = ['.js','.jsx','.es', '.es6', '.mjs'],
  watchExtensions = ['js','ejs'],
  watchExtra = ['.env'],
}){
  
  function rimrafAsync(filepath){
    return new Promise((resolve, reject)=>{
      rimraf(filepath, err=>{
        if(err){
          reject(err)
        }
        else if(verbose){
          resolve()
        }
      })
    })
  }

  async function removePath(filepath){
    if(await fs.pathExists(filepath)){
      try{
        await rimrafAsync(filepath)
        if(verbose){
          console.log(filepath, ' x')
        }
      }
      catch(err){
        console.err(err)
      }
    }
  }
  
  const cwd = process.cwd()
  const compileDependenciesMapReverse = {}
  
  async function compileFile(filename){
    const relativeFilename = filename.slice(srcPath.length+1)
    const srcFilepath = path.join(srcPath, relativeFilename)
    const distFilepath = path.join(distPath, relativeFilename)
    const absolutePath = path.resolve(srcPath, relativeFilename)
    try{
      const { code, map, ast } = await transformFileAsync(srcFilepath, {ast: true})
      traverse(ast, {
        CallExpression: (p, state) => {
          const {
            leadingComments,
            trailingComments,
          } = p.node
          if(!(leadingComments || trailingComments))
            return
            
          const handleComments = async (comment)=>{
            let {value} = comment
            if(!value) 
              return
            value = value.trim()
            
            if(value.slice(0,1)==='!')
              value = value.slice(1)
              
            if(value.slice(0, compileDependenciesPrefix.length)!==compileDependenciesPrefix)
              return
            
            const dependenciesJSON = value.slice(compileDependenciesPrefix.length+1, -1)
            let dependencies
            try{
              dependencies = JSON5.parse(dependenciesJSON)
            }
            catch(e){
              console.error(dependenciesJSON)
              throw e
            }
            
            if(!dependencies)
              return
              
            if(Array.isArray(dependencies)){
              dependencies = dependencies.reduce((o, dep)=>{
                o[dep] = {}
                return o
              }, {})
            }
            
            const dir = path.dirname(srcFilepath)
            for(const [dep, opts] of Object.entries(dependencies)){
              let d = path.resolve(dir, dep)+(dep.slice(-1)==='/'?'/':'')
              d = d.slice(cwd.length)
              if(d.slice(0,1)==='/')
                d = d.slice(1)
              d = d.slice(srcPath.length)
              if(d.slice(0,1)==='/')
                d = d.slice(1)
              let filepath = path.resolve(dir, relativeFilename)
              filepath = filepath.slice(cwd.length+dir.length+2)
              if(!compileDependenciesMapReverse[d]){
                compileDependenciesMapReverse[d] = new Map()
              }
              compileDependenciesMapReverse[d].set(filepath, opts)
            }
            
          }
          
          if(leadingComments){
            for(const comment of leadingComments){
              handleComments(comment)
            }
          }
          if(trailingComments){
            for(const comment of trailingComments){
              handleComments(comment)
            }
          }
          
          
        },
      })
      await Promise.all([
        fs.writeFile(distFilepath, code),
        sourceMaps ? fs.writeFile(distFilepath+'.map', map) : null,
      ])
      const srcStat = await fs.stat(srcFilepath)
      await fs.chmod(distFilepath, srcStat.mode)
      if(verbose){
        console.log(srcFilepath, ' -> ', distFilepath)
      }
    }
    catch(err){
      // console.error(err)
      const serializedError = jsStringEscape( JSON.stringify( serializeError(err) ) )
      const errorSource = `console.error(require('deserialize-error')(JSON.parse('${serializedError}')))`
      const result = await transformAsync(errorSource, {filename})
      console.log({result})
      const {code, map} = result
      await Promise.all([
        fs.writeFile(distFilepath, code),
        fs.writeFile(distFilepath+'.map', map),
      ])
    }
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
    await removePath(distFilepath)
  }
  
  async function unlinkFile(filename){
    const relativeFilename = filename.slice(srcPath.length+1)
    const distFilepath = path.join(distPath, relativeFilename)
    
    await removePath(distFilepath)
    
    if(sourceMaps){
      await removePath(distFilepath+'.map')
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
    return compileExtensions.some(ext=> ext === filename.slice(-1*ext.length))
  }
  
  async function compileDependentFiles(relativeFilename, event){
    const filename = path.resolve(srcPath, relativeFilename)    
    for(const [depencency, dependentFiles] of Object.entries(compileDependenciesMapReverse)){
      if(depencency===filename ||
        (depencency.slice(-1)==='/' && relativeFilename.slice(0, depencency.length)===depencency)
      ){
        for(const [f, opts] of dependentFiles.entries()){
          const file = path.join(srcPath, f)
          if(opts[event]===false){
            continue
          }
          if(await fs.pathExists(file)){
            await compileFile(file)
          }
          else{
            dependentFiles.delete(file)
          }
        }
        
      }
    }
  }

  async function handleFile(event, filename, firstRun){
    const relativeFilename = filename.slice(srcPath.length+1)
    
    if(ignoreFile(relativeFilename))
      return
    
    switch(event){
      case 'add':
      case 'change':
        if(compileThisFile(filename)){
          await compileFile(filename)
        }
        else{
          await copyFile(filename)
        }
        break
      case 'unlink':
        await unlinkFile(filename)
        break
      case 'addDir':
        await addDir(filename)
        break
      case 'unlinkDir':
        await unlinkDir(filename)
        break
    }
    
    if(!firstRun){
      await compileDependentFiles(relativeFilename, event)
    }
    
  }
    
  async function rreaddir (dir, allFiles = []) {
    const files = (await fs.readdir(dir)).map(f => path.join(dir, f))
    allFiles.push(...files)
    await Promise.all(files.map(async f => (
      (await fs.stat(f)).isDirectory() && rreaddir(f, allFiles)
    )))
    return allFiles
  }

  async function babelBuild(){
    await fs.emptyDir(distPath)
    const files = await rreaddir(srcPath)
    for(const file of files){
      const isDir = (await fs.stat(file)).isDirectory()
      if(isDir)
        await handleFile('addDir', file, true)
      else
        await handleFile('add', file, true)
    }
  }
  
  function babelWatch(){
    
    const ignored = undefined
    
    const watcher = chokidar.watch(srcPath, {
      ignored,
      persistent: true,
      ignoreInitial: true,
      depth: Infinity,
    })
    
    watcher.on('all', (event, filename)=>handleFile(event, filename, false))
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
  
  await babelBuild()
  babelWatch()
  
  const nodemonWatchConfig = {
    entryPoints,
  }
  nodemonWatch(nodemonWatchConfig)
  
}

module.exports = run

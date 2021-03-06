import { existsSync, lstatSync, readFileSync, unlinkSync } from 'fs'
import { cloneDeep } from 'lodash'
import { noop } from 'lodash'
import { extname, join, relative } from 'path'
import * as shell from 'shelljs'
import * as ts from 'typescript'
import { log } from './helper'
import { binPath } from './helper'

// polyfill
;(Symbol as any).asyncIterator =
  Symbol.asyncIterator || Symbol.for('Symbol.asyncIterator')

export class Compiler {
  // useful so we can get semantic errors
  // incremental tsc compiling does only support syntactic checking
  static compile() {
    shell.config.fatal = true
    shell.exec(join(process.cwd(), 'node_modules', '.bin', 'tsc'))
  }

  private conf: ts.ParsedCommandLine
  private host: ts.WatchCompilerHostOfFilesAndCompilerOptions<ts.BuilderProgram>
  private tsc: ts.WatchOfFilesAndCompilerOptions<ts.BuilderProgram>
  private watchedFiles: string[]
  private tscFileWatcher: ts.FileWatcher[] = []

  private wait: {
    compile?: Promise<null>
    resolve?: (running: boolean) => void
  }
  private counter = 0

  constructor() {
    // ts config
    const tsConfig = JSON.parse(
      readFileSync(join(process.cwd(), 'tsconfig.json'), 'utf-8')
    )
    // load and configure tsc config object
    this.conf = ts.parseJsonConfigFileContent(
      tsConfig,
      this.getTsSys(),
      process.cwd()
    )
    this.conf.options.diagnostics = true
    this.conf.options.extendedDiagnostics = true

    // create host config
    this.host = ts.createWatchCompilerHost(
      this.conf.fileNames,
      this.conf.options,
      this.getTsSys(),
      undefined
    )

    this.host.trace = () => {
      return
    }
    this.host.onWatchStatusChange = this.onWatchStatusChange.bind(this)
    this.host.afterProgramCreate = this.onCompilerMessage.bind(this)
    this.watchedFiles = this.conf.fileNames
    // set first compile promise
    this.createCompilePromise()
  }

  // start watching compilation
  watch = async function*(this: Compiler) {
    this.counter = 1
    this.tsc = ts.createWatchProgram(this.host)
    while (await this.wait.compile) {
      this.createCompilePromise()
      yield true
    }
  }

  stop() {
    this.tscFileWatcher.forEach(w => w.close())
    if (this.tsc) {
      this.tsc.updateRootFileNames([])
    }
    this.host.trace = () => {
      return
    }
    this.host.onWatchStatusChange = () => {
      return
    }
    this.host.afterProgramCreate = () => {
      return
    }
    this.wait.resolve(false)
  }

  private getTsSys(): ts.System {
    const sys = cloneDeep(ts.sys)
    sys.watchFile = (
      path: string,
      callback: ts.FileWatcherCallback,
      pollingInterval: number
    ): ts.FileWatcher => {
      const wrappedCB = (
        fileName: string,
        eventKind: ts.FileWatcherEventKind
      ) => {
        // events
        /*
          Created = 0,
          Changed = 1,
          Deleted = 2,
        */
        if (!this.isInWatchedDir(fileName)) {
          return callback(fileName, eventKind)
        }
        if (eventKind === 1) {
          this.changedWatchedFile(fileName)
        }
        if (eventKind === 2) {
          this.deletedWatchedFile(fileName)
        }
        callback(fileName, eventKind)
      }
      const watcher = ts.sys.watchFile(path, wrappedCB, pollingInterval)
      this.tscFileWatcher.push(watcher)

      return watcher
    }
    sys.watchDirectory = (
      path: string,
      callback: ts.DirectoryWatcherCallback,
      recursive: boolean
    ): ts.FileWatcher => {
      const wrappedCB = fileName => {
        if (
          this.isInWatchedDir(fileName) &&
          existsSync(fileName) &&
          lstatSync(fileName).isFile()
        ) {
          this.addWatchedFile(fileName)
        }
        return callback(fileName)
      }
      const watcher = ts.sys.watchDirectory(path, wrappedCB, recursive)
      this.tscFileWatcher.push(watcher)
      return watcher
    }
    return sys
  }

  private isInWatchedDir(path: string) {
    return Object.keys(this.conf.wildcardDirectories).reduce(
      (acc, wDir) =>
        acc ? !!acc : path.toLowerCase().startsWith(wDir.toLowerCase()),
      false
    )
  }

  private createCompilePromise() {
    this.wait = {}
    const handle = (res, rej) => {
      this.wait.resolve = res
    }
    this.wait.compile = new Promise(handle)
  }

  private changedWatchedFile(filePath) {
    this.counter++
    log('Watched file changed:', filePath)
  }

  private addWatchedFile(filePath: string) {
    if (!this.tsc || this.watchedFiles.indexOf(filePath) > -1) {
      return
    }
    log('Watching new file:', filePath)
    this.counter++
    this.watchedFiles = this.watchedFiles.concat(filePath)
    this.tsc.updateRootFileNames(this.watchedFiles)
  }

  private deletedWatchedFile(filePath: string) {
    this.watchedFiles = this.watchedFiles.filter(file => file !== filePath)
    this.tsc.updateRootFileNames(this.watchedFiles)
    this.counter++

    let compiledFile = join(
      '.seagull',
      'dist',
      relative(process.cwd(), filePath)
    )
    const ext = extname(compiledFile)
    compiledFile = compiledFile.replace(RegExp(`${ext}$`), '')
    const obseleteJs = compiledFile + '.js'
    const obseleteJsMap = compiledFile + '.js.map'
    if (existsSync(obseleteJs)) {
      unlinkSync(obseleteJs)
    }
    if (existsSync(obseleteJsMap)) {
      unlinkSync(obseleteJsMap)
    }
    log('Removing file', filePath)
  }

  private onWatchStatusChange(diagnostic: ts.Diagnostic, newline: string) {
    if (diagnostic.code !== 6042) {
      return
    }
    if (this.counter === 1) {
      log('Compile finished. Waiting for file changes')
    }
    if (this.counter > 0) {
      this.counter--
      this.wait.resolve(true)
    }
  }

  private onCompilerMessage(programInfo: ts.BuilderProgram) {
    programInfo.emit()
    const diagnostics = programInfo.getSyntacticDiagnostics()
    diagnostics.forEach(diagnostic => {
      this.logDiagnostic(diagnostic)
    })
  }

  private logDiagnostic(dg: ts.Diagnostic) {
    const message = ts.flattenDiagnosticMessageText(dg.messageText, '\n')

    if (!dg.file) {
      log(`  Error: ${message}`)
      return
    }

    const pos = dg.file.getLineAndCharacterOfPosition(dg.start!)
    const positionDisplay = `${pos.line + 1},${pos.character + 1}`
    log(` Error ${dg.file.fileName} (${positionDisplay}): ${message}`)
  }
}

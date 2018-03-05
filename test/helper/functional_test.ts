import { App, generatePage } from '@seagull/code-generators'
import { context } from 'mocha-typescript'
import * as mockFS from 'mock-fs'
import { join } from 'path'
import * as shell from 'shelljs'

const cwd = shell.pwd().toString()
const appName = '__tmp__'
const appDir = join(cwd, appName)

const create = name => {
  const app = new App(name)
  app.toFolder(appDir)
}

const addPage = (name, options) => {
  const gen = generatePage(name, options)
  const pwd = shell.pwd().toString()
  const dest = join(pwd, 'frontend', 'pages', `${name}.tsx`)
  gen.toFile(dest)
}

export default class UnitTest {
  // static local variables
  static cwd = cwd
  static appName = appName
  static appDir = appDir

  static create = create
  static addPage = addPage

  static before() {
    shell.cd(cwd)
    shell.rm('-rf', appDir)
    create(appName)
    shell.cd(appDir)
    process.chdir(appDir)
    shell.ln('-s', '../node_modules', `./node_modules`)
  }
  static after() {
    shell.cd(cwd)
    process.chdir(cwd)
    shell.rm('-rf', appDir)
  }

  @context mocha

  cwd = cwd
  appName = appName
  appDir = appDir
  create = create
  addPage = addPage
}

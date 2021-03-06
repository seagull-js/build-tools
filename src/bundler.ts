import * as browserify from 'browserify'
import * as browserifyIncremental from 'browserify-incremental'
import { writeFileSync } from 'fs'
import { join } from 'path'
import * as streamToString from 'stream-to-string'
import * as UglifyJS from 'uglify-es'
import { log } from './helper'

const entry = join(
  '.seagull',
  'node_modules',
  '@seagull',
  'core',
  'dist',
  'lib',
  'spa',
  'entry.js'
)

const useBabel = (minify: boolean) => minify || process.env.BABEL

const addBabelTransform = (bfy: any, minify: boolean) => {
  return useBabel(minify)
    ? bfy.transform('babelify', {
        global: true,
        presets: [
          [
            'env',
            {
              targets: {
                browsers: ['last 2 versions', 'safari >= 7', 'ie >= 11'],
              },
            },
          ],
        ],
      })
    : bfy
}

export class Bundler {
  static async bundle(minify = false) {
    const bfy = addBabelTransform(
      browserify({
        ignoreMissing: true,
        require: useBabel(minify) ? ['babel-polyfill'] : [],
      }),
      minify
    )
    const stream = bfy.add(join(process.cwd(), entry)).bundle()
    const bundle = minify
      ? UglifyJS.minify(await streamToString(stream)).code
      : await streamToString(stream)

    const dist = join(process.cwd(), '.seagull', 'assets', 'bundle.js')
    writeFileSync(dist, bundle, { encoding: 'utf-8' })
  }

  private minify = false
  private sourceMaps = false
  private browserify
  private browserifyIncremental
  private incrementalCache = {}
  private incrementalPackageCache = {}

  constructor(optimize = false) {
    this.minify = optimize
    this.sourceMaps = !optimize
    const browserifyArgs = {
      cache: this.incrementalCache,
      debug: this.sourceMaps,
      fullPaths: true,
      ignoreMissing: true,
      packageCache: this.incrementalPackageCache,
      require: useBabel(this.minify) ? ['babel-polyfill'] : [],
    }

    this.browserify = addBabelTransform(browserify(browserifyArgs), this.minify)
    this.browserifyIncremental = browserifyIncremental(this.browserify)
    this.browserify.add(join(process.cwd(), entry))
    this.browserify.on('time', time => {
      log(' Bundling took(ms):', time)
    })
  }

  async bundle(): Promise<string> {
    const stream = this.browserify.bundle()
    const bundle = this.minify
      ? UglifyJS.minify(await streamToString(stream)).code
      : await streamToString(stream)

    const dist = join(process.cwd(), '.seagull', 'assets', 'bundle.js')
    writeFileSync(dist, bundle, { encoding: 'utf-8' })
    return bundle
  }
}

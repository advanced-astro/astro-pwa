import crypto from 'crypto'
import fs from 'fs'
import { VitePWA, type VitePWAOptions, type VitePluginPWAAPI } from 'vite-plugin-pwa'
import type { AstroConfig, AstroIntegration, RouteData } from 'astro'
import type { Plugin } from 'vite'
import type { ManifestEntry, ManifestTransform } from 'workbox-build'

export default function (options: Partial<VitePWAOptions> = {}): AstroIntegration {
  let pwaPlugin: Plugin | undefined
  let data: RouteData[] | undefined
  const enableManifestTransform: EnableManifestTransform = () => {
    return data!
  }
  return {
    name: '@vite-pwa/astro-integration',
    hooks: {
      'astro:config:setup': ({ config, updateConfig }) => {
        updateConfig({ vite: getViteConfiguration(config, options, enableManifestTransform) })
      },
      'astro:config:done': ({ config }) => {
        pwaPlugin = config.vite!.plugins!.flat(Infinity).find(p => p.name === 'vite-plugin-pwa')!
      },
      'astro:build:done': async ({ routes }) => {
        data = routes
        await regeneratePWA(pwaPlugin)
      },
    },
  }
}

type EnableManifestTransform = () => RouteData[]

function buildManifestEntry(
  url: string,
  path: URL,
): Promise<ManifestEntry> {
  return new Promise((resolve, reject) => {
    const cHash = crypto.createHash('MD5')
    const stream = fs.createReadStream(path)
    stream.on('error', (err) => {
      reject(err)
    })
    stream.on('data', (chunk) => {
      cHash.update(chunk)
    })
    stream.on('end', () => {
      return resolve({
        url,
        revision: `${cHash.digest('hex')}`,
      })
    })
  })
}

async function buildManifestEntryTransform(
  ssgUrl: string,
  path: URL,
): Promise<ManifestEntry & { size: number }> {
  const [size, { url, revision }] = await Promise.all([
    new Promise<number>((resolve, reject) => {
      fs.lstat(path, (err, stats) => {
        if (err)
          reject(err)
        else
          resolve(stats.size)
      })
    }),
    buildManifestEntry(ssgUrl, path),
  ])
  return { url, revision, size }
}

function isStatic(route: RouteData) {
  if (!route.segments)
    return true

  for (let i = 0; i < route.segments.length; i++) {
    for (let j = 0; j < route.segments[i].length; j++) {
      if (route.segments[i][j].dynamic)
        return false
    }
  }

  return true
}

function createManifestTransform(enableManifestTransform: EnableManifestTransform): ManifestTransform {
  return async (entries) => {
    const pages = enableManifestTransform()
    if (pages) {
      const manifest = entries.filter(e => !e.url.endsWith('.html'))
      const addRoutes = await Promise.all(pages.filter(
        r => r.type === 'page' && r.pathname && r.distURL && isStatic(r),
      ).map((r) => {
        return buildManifestEntryTransform(r.pathname!, r.distURL!)
      }))
      manifest.push(...addRoutes)
      return { manifest }
    }

    return { manifest: entries }
  }
}

function getViteConfiguration(
  config: AstroConfig,
  options: Partial<VitePWAOptions>,
  enableManifestTransform: EnableManifestTransform,
) {
  // @ts-expect-error TypeScript doesn't handle flattening Vite's plugin type properly
  const plugin = config.vite?.plugins?.flat(Infinity).find(p => p.name === 'vite-plugin-pwa')
  if (plugin)
    throw new Error('Remove the vite-plugin-pwa plugin from Vite Plugins entry in Astro config file, configure it via @vite-pwa/astro integration')

  const {
    strategies = 'generateSW',
    registerType = 'prompt',
    injectRegister,
    workbox = {},
    injectManifest = {},
    ...rest
  } = options

  if (strategies === 'generateSW') {
    const useWorkbox = { ...workbox }
    const newOptions: Partial<VitePWAOptions> = {
      ...rest,
      strategies,
      registerType,
      injectRegister,
    }
    if (!useWorkbox.navigateFallback)
      useWorkbox.navigateFallback = config.vite?.base ?? '/'

    newOptions.workbox = useWorkbox

    newOptions.workbox.manifestTransforms = newOptions.workbox.manifestTransforms ?? []
    newOptions.workbox.manifestTransforms.push(createManifestTransform(enableManifestTransform))

    return {
      plugins: [VitePWA(newOptions)],
    }
  }

  options.injectManifest = options.injectManifest ?? {}
  options.injectManifest.manifestTransforms = injectManifest.manifestTransforms ?? []
  options.injectManifest.manifestTransforms.push(createManifestTransform(enableManifestTransform))

  return {
    plugins: [VitePWA(options)],
  }
}

async function regeneratePWA(
  pwaPlugin: Plugin | undefined,
) {
  const api: VitePluginPWAAPI | undefined = pwaPlugin?.api
  if (api && !api.disabled) {
    // regenerate the sw: there is no need to generate the webmanifest again
    await api.generateSW()
  }
}

import build from '@hono/vite-build/cloudflare-workers'
import adapter from '@hono/vite-dev-server/cloudflare'
import tailwindcss from '@tailwindcss/vite'
import honox from 'honox/vite'
import type { HookHandler, Plugin, PluginOption, UserConfig } from 'vite'
import { defineConfig } from 'vite'

const clientOptions = {
  input: ['/app/client.ts', '/app/style.css'],
  assetsDir: 'static',
  jsxImportSource: 'hono/jsx/dom'
}

const disabledHonoxPlugins = new Set([
  'honox-vite-client',
  'transform-island-components',
  'inject-importing-islands'
])

export default defineConfig({
  plugins: [
    ...withoutPlugins(honox({
      devServer: { adapter },
      client: clientOptions,
      islands: false
    }), disabledHonoxPlugins),
    tokenboardClient(clientOptions),
    tailwindcss(),
    filteredWorkerBuild({
      entry: './app/server.ts'
    })
  ]
})

function filteredWorkerBuild(options: Parameters<typeof build>[0]): Plugin {
  return withVirtualEntryHookFilters(build(options))
}

function tokenboardClient(options: typeof clientOptions): Plugin {
  return {
    name: 'tokenboard-vite-client',
    apply: (_config, { command, mode }) => command === 'build' && mode === 'client',
    config: (): UserConfig => ({
      build: {
        rollupOptions: { input: options.input },
        assetsDir: options.assetsDir,
        manifest: true
      },
      oxc: {
        jsx: {
          importSource: options.jsxImportSource
        }
      }
    })
  }
}

function withoutPlugins(plugins: PluginOption[], blockedNames: Set<string>): PluginOption[] {
  const filtered: PluginOption[] = []
  for (const plugin of plugins) {
    if (!plugin) continue
    if (isPromisePlugin(plugin)) {
      const promise = plugin as Promise<Plugin | { name: string } | false | null | undefined | PluginOption[]>
      filtered.push(promise.then((resolved) => withoutPlugins([resolved], blockedNames)))
      continue
    }
    if (Array.isArray(plugin)) {
      filtered.push(withoutPlugins(plugin, blockedNames))
      continue
    }
    if (typeof plugin === 'object' && 'name' in plugin && blockedNames.has(plugin.name)) {
      continue
    }
    filtered.push(plugin)
  }
  return filtered
}

function isPromisePlugin(plugin: PluginOption): boolean {
  return typeof plugin === 'object' && plugin !== null && 'then' in plugin
}

function withVirtualEntryHookFilters(plugin: Plugin): Plugin {
  const resolveId = getHookHandler<HookHandler<NonNullable<Plugin['resolveId']>>>(plugin.resolveId)
  const load = getHookHandler<HookHandler<NonNullable<Plugin['load']>>>(plugin.load)

  return {
    ...plugin,
    resolveId: resolveId
      ? {
          filter: {
            id: /^virtual:build-entry-module$/
          },
          handler: resolveId
        }
      : plugin.resolveId,
    load: load
      ? {
          filter: {
            id: /^\0virtual:build-entry-module$/
          },
          handler: load
        }
      : plugin.load
  }
}

type HookObject<THandler> = {
  handler: THandler
}

function getHookHandler<THandler>(
  hook: HookObject<THandler> | THandler | undefined
): THandler | undefined {
  if (!hook) return undefined
  if (typeof hook === 'function') return hook
  if (typeof hook === 'object' && 'handler' in hook) return hook.handler
  return undefined
}

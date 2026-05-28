import { describe, expect, test, vi } from 'vitest'
import type { ConfigPluginContext, Plugin, PluginOption, UserConfig } from 'vite'

const buildCalls = vi.hoisted(() => [] as Array<Record<string, unknown> | undefined>)

vi.mock('@hono/vite-build/cloudflare-workers', () => ({
  default: (options?: Record<string, unknown>) => {
    buildCalls.push(options)
    return {
      name: '@hono/vite-build/cloudflare-workers',
      resolveId(id: string) {
        return id === 'virtual:build-entry-module' ? '\0virtual:build-entry-module' : undefined
      },
      load(id: string) {
        return id === '\0virtual:build-entry-module' ? 'export default {}' : undefined
      }
    }
  }
}))

vi.mock('@hono/vite-dev-server/cloudflare', () => ({
  default: {}
}))

vi.mock('@tailwindcss/vite', () => ({
  default: () => ({ name: 'tailwindcss' })
}))

vi.mock('honox/vite', () => ({
  default: (options?: { islands?: boolean }) => [
    { name: 'honox-vite-client' },
    ...(options?.islands === false ? [] : [{ name: 'transform-island-components' }]),
    Promise.resolve({ name: 'inject-importing-islands' }),
    { name: 'honox-router' }
  ]
}))

const config = await loadViteConfig()

describe('vite config', () => {
  test('uses oxc for the client build instead of the deprecated esbuild config', async () => {
    const plugins = await flattenPlugins(config.plugins ?? [])
    const names = plugins.map((plugin) => plugin.name)

    expect(names).not.toContain('honox-vite-client')

    const clientPlugin = plugins.find((plugin) => plugin.name === 'tokenboard-vite-client')
    expect(clientPlugin).toBeDefined()

    const pluginConfig = await runConfigHook(clientPlugin)
    expect(pluginConfig).toMatchObject({
      oxc: {
        jsx: {
          importSource: 'hono/jsx/dom'
        }
      }
    })
    expect(pluginConfig).not.toHaveProperty('esbuild')
  })

  test('builds the worker from the explicit server entry only', () => {
    expect(buildCalls).toEqual([
      {
        entry: './app/server.ts'
      }
    ])
  })

  test('filters worker virtual entry hooks before they cross into JavaScript', () => {
    const plugins = flattenPluginsSync(config.plugins ?? [])
    const workerPlugin = plugins.find((plugin) => plugin.name === '@hono/vite-build/cloudflare-workers')

    expect(workerPlugin?.resolveId).toMatchObject({
      filter: {
        id: /^virtual:build-entry-module$/
      }
    })
    expect(workerPlugin?.load).toMatchObject({
      filter: {
        id: /^\0virtual:build-entry-module$/
      }
    })
  })

  test('does not run HonoX island plugins when the app has no islands', async () => {
    const plugins = await flattenPlugins(config.plugins ?? [])
    const names = plugins.map((plugin) => plugin.name)

    expect(names).not.toContain('transform-island-components')
    expect(names).not.toContain('inject-importing-islands')
  })
})

async function loadViteConfig(): Promise<UserConfig> {
  const module = await import('./vite.config')
  return module.default as UserConfig
}

async function flattenPlugins(plugins: PluginOption[]): Promise<Plugin[]> {
  const flattened: Plugin[] = []
  for (const plugin of plugins) {
    if (plugin && typeof plugin === 'object' && 'then' in plugin) {
      flattened.push(...await flattenPlugins([await plugin]))
      continue
    }
    if (Array.isArray(plugin)) {
      flattened.push(...await flattenPlugins(plugin))
      continue
    }
    if (plugin && typeof plugin === 'object' && 'name' in plugin) {
      flattened.push(plugin)
    }
  }
  return flattened
}

function flattenPluginsSync(plugins: PluginOption[]): Plugin[] {
  const flattened: Plugin[] = []
  for (const plugin of plugins) {
    if (!plugin) continue
    if (Array.isArray(plugin)) {
      flattened.push(...flattenPluginsSync(plugin))
      continue
    }
    if (typeof plugin === 'object' && 'name' in plugin) {
      flattened.push(plugin)
    }
  }
  return flattened
}

async function runConfigHook(plugin: Plugin | undefined) {
  if (!plugin || typeof plugin.config !== 'function') return {}
  return await plugin.config.call(createConfigContext(), {}, { command: 'build', mode: 'client' }) ?? {}
}

function createConfigContext(): ConfigPluginContext {
  return {
    meta: {},
    error(error: unknown): never {
      throw error instanceof Error ? error : new Error(String(error))
    },
    debug() {},
    info() {},
    warn() {}
  } as unknown as ConfigPluginContext
}

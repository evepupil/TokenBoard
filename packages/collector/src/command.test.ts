import { describe, expect, test } from 'vitest'
import { runJsonCommand } from './command'

describe('runJsonCommand', () => {
  test('passes arguments directly without shell parsing', async () => {
    const result = await runJsonCommand(process.execPath, [
      '-e',
      'console.log(JSON.stringify({argv: process.argv.slice(1)}))',
      'value with spaces'
    ])

    expect(result).toEqual({ argv: ['value with spaces'] })
  })
})

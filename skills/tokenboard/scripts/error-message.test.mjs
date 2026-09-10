import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { errorMessage } from './error-message.mjs'

test('normalizes ordinary and empty thrown values', () => {
  assert.equal(errorMessage(new Error('failed')), 'failed')
  assert.equal(errorMessage(new Error('')), 'Error')
  assert.equal(errorMessage('failed'), 'failed')
  assert.equal(errorMessage(''), 'Unknown error')
})

test('does not throw while formatting hostile thrown values', () => {
  const throwingString = {
    toString() {
      throw new Error('toString failed')
    }
  }
  const throwingError = new Error('failed')
  Object.defineProperties(throwingError, {
    message: {
      get: () => {
        throw new Error('message getter failed')
      }
    },
    name: {
      get: () => {
        throw new Error('name getter failed')
      }
    }
  })

  assert.equal(errorMessage(Object.create(null)), 'Unknown error')
  assert.equal(errorMessage(throwingString), 'Unknown error')
  assert.equal(errorMessage(throwingError), 'Unknown error')
})

test('skill CLI entrypoints use shared error diagnostics', () => {
  for (const fileName of [
    'hooks.mjs',
    'install-collector.mjs',
    'install-schedule.mjs',
    'notify.mjs',
    'rotate-token.mjs',
    'setup.mjs',
    'sync.mjs',
    'uninstall-schedule.mjs',
    'uninstall.mjs',
    'upgrade.mjs'
  ]) {
    const source = readFileSync(new URL(fileName, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /console\.error\(error\.message\)/, fileName)
    assert.doesNotMatch(source, /result\.error\.message/, fileName)
    assert.match(source, /errorMessage\((?:error|result\.error)\)/, fileName)
  }
})

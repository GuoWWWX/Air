import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const read = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
const english = read('resources/languages/en.json')
const chinese = read('resources/languages/zh-CN.json')
assert.equal(english.code, 'en')
assert.equal(chinese.code, 'zh-CN')
assert.deepEqual(Object.keys(english.messages).sort(), Object.keys(chinese.messages).sort())
const slots = text => [...new Set(text.match(/\{\d+\}/g) ?? [])].sort()
for (const [key, value] of Object.entries(english.messages)) {
  for (const translation of [value, chinese.messages[key]]) {
    assert.equal(typeof translation, 'string', key)
    assert.ok(translation.trim(), key)
    assert.deepEqual(slots(translation), slots(key), key)
  }
}

for (const file of readdirSync('resources/languages').filter(name => name.endsWith('.json'))) {
  const pack = read(join('resources/languages', file))
  assert.equal(file, pack.code + '.json')
  assert.ok(/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(pack.code) && pack.code !== 'system', file)
  assert.ok(typeof pack.name === 'string' && pack.name.trim(), file)
  for (const [key, value] of Object.entries(pack.messages)) {
    assert.ok(Object.hasOwn(english.messages, key), key)
    assert.equal(typeof value, 'string', key)
    assert.deepEqual(slots(value), slots(key), key)
  }
}

function checkDirectory(directory) {
  for (const file of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, file.name)
    if (file.isDirectory()) checkDirectory(path)
    if (!file.isFile() || !/\.tsx?$/.test(path)) continue
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'tr') {
        let owner = node.parent
        while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
        assert.ok(owner, `${path}: resolve UI text when rendering or reading the label, so language switches update it`)
        const key = node.arguments[0]
        if (key && ts.isStringLiteralLike(key)) {
          assert.ok(Object.hasOwn(english.messages, key.text), `${path}: missing ${key.text}`)
          for (const placeholder of slots(key.text)) {
            assert.ok(Number(placeholder.slice(1, -1)) < node.arguments.length - 1,
              `${path}: missing argument for ${key.text}`)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
}
checkDirectory('src')
checkDirectory('android/web/src')
console.log(`Verified ${Object.keys(english.messages).length} messages and translation calls on both platforms.`)

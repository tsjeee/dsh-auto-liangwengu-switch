import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (file) => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8')

const pkg = JSON.parse(read('package.json'))
assert.equal(pkg.name, 'dsh-auto-liangwengu-switch')
assert.equal(pkg.type, 'module')
assert.equal(pkg.exports['.'], './index.js')
assert.equal(pkg.exports['./client'], './client.js')
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
assert.equal(pkg.dsh.client.platform, 'web')
assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
for (const entry of [
  'index.js', 'interception.js', 'time.js', 'holidays.js', 'holiday-sync.js',
  'holiday-data.json', 'calendar-payload.js', 'client.js', 'cordis.patch.yml', 'README.md', 'icon.svg',
]) {
  assert.ok(pkg.files.includes(entry), `files must list ${entry}`)
}
assert.ok(pkg.files.includes('locale/*.json'))

const holidayData = JSON.parse(read('holiday-data.json'))
assert.ok(holidayData.years, 'holiday-data.json must carry a years object')
assert.deepEqual(Object.keys(holidayData.years).sort(), ['2026', '2027'])
for (const [year, ranges] of Object.entries(holidayData.years)) {
  assert.ok(Array.isArray(ranges) && ranges.length > 0, `${year} needs ranges`)
  for (const range of ranges) {
    assert.ok(Array.isArray(range) && range.length === 2, `${year} range must be [start, end]`)
    assert.match(range[0], /^\d{4}-\d{2}-\d{2}$/u)
    assert.match(range[1], /^\d{4}-\d{2}-\d{2}$/u)
    assert.equal(range[0].slice(0, 4), year)
    assert.ok(range[0] <= range[1])
  }
}

const en = JSON.parse(read('locale/en.json'))
assert.equal(en.meta.title, 'Auto Liangwengu execution switch')
assert.ok(en.meta.description.includes('09:00'))
assert.ok(en.meta.description.includes('18:00'))

const zh = JSON.parse(read('locale/zh.json'))
assert.equal(zh.meta.title, '\u81ea\u52a8\u6881\u6587\u8c37\u6267\u884c\u5f00\u5173')
assert.ok(zh.meta.description.includes('\u5f53\u524d\u5df2\u5904\u4e8e\u5cf0\u8c37\u65f6\u6bb5\u4e86'))
assert.ok(zh.meta.description.includes('09:00'))
assert.ok(zh.meta.description.includes('18:00'))

const icon = read('icon.svg')
assert.ok(icon.startsWith('<svg'))
assert.ok(icon.includes('viewBox="0 0 36 36"'))
assert.ok(!icon.includes('<script'))
assert.ok(!icon.includes('foreignObject'))

const patch = read('cordis.patch.yml')
assert.ok(patch.includes("name: 'dsh-auto-liangwengu-switch'"))
assert.ok(patch.includes('id: auto-liangwengu-switch'))

console.log('bundle manifest + holiday data + locale + icon + patch checks passed')

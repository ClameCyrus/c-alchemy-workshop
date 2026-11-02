const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(manifest.display_name, 'Cの炼金工坊');
assert.equal(manifest.author, 'ClameCyrus');
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.homePage, 'https://github.com/ClameCyrus/c-alchemy-workshop');
for (const field of ['js', 'css']) {
  assert.equal(typeof manifest[field], 'string');
  const target = path.resolve(root, manifest[field]);
  assert.ok(target.startsWith(root + path.sep), 'Manifest path must stay inside this extension');
  assert.ok(fs.statSync(target).size > 0, `${field} output is empty`);
}
new vm.Script(fs.readFileSync(path.join(root, manifest.js), 'utf8'), { filename: manifest.js });
const css = fs.readFileSync(path.join(root, manifest.css), 'utf8');
assert.ok(css.includes('@import url("https://fontsapi.zeoseven.com/2166/main/result.css")'));
assert.ok(css.includes('851 GBai Marker'));
for (const file of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'pnpm-lock.yaml']) assert.ok(fs.statSync(path.join(root, file)).size > 0, `${file} is missing`);
assert.equal(fs.existsSync(path.join(root, 'pack.cjs')), false, 'ZIP packaging is not part of this project');
assert.equal(fs.existsSync(path.join(root, 'release')), false, 'Release downloads are not part of this project');
console.log(`Verified link-installable extension: ${manifest.display_name} ${manifest.version}`);

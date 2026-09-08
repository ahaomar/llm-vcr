const fs = require('fs');
const path = require('path');
const { keyToFilename } = require('./canonical');

function loadCassettes(dir) {
  const map = new Map();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) {
      continue;
    }
    try {
      const cassette = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (cassette && cassette.key) {
        map.set(cassette.key, cassette);
      }
    } catch (err) {
      console.error(`[vcr] skipping invalid cassette ${file}: ${err.message}`);
    }
  }
  return map;
}

function saveCassette(dir, cassette) {
  const file = path.join(
    dir,
    keyToFilename(cassette.request.method, cassette.request.path, cassette.key)
  );
  fs.writeFileSync(file, JSON.stringify(cassette, null, 2) + '\n');
  return file;
}

function removeCassette(dir, cassette) {
  const file = path.join(
    dir,
    keyToFilename(cassette.request.method, cassette.request.path, cassette.key)
  );
  if (fs.existsSync(file)) {
    fs.rmSync(file);
  }
  return file;
}

module.exports = { loadCassettes, saveCassette, removeCassette };

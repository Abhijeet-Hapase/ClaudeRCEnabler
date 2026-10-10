'use strict';
const fs = require('fs');
const path = require('path');
const { toPNG, toICO } = require('../src/icon');

const out = path.join(__dirname, '..', 'build');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), toPNG(256));
fs.writeFileSync(path.join(out, 'icon.ico'), toICO([16, 32, 48, 64, 128, 256]));
console.log('Wrote build/icon.png and build/icon.ico');

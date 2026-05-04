#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

try {
  const cwd = process.cwd();
  const files = fs.readdirSync(cwd).filter((f) => f.endsWith('.vsix'));
  if (files.length === 0) {
    console.log('No .vsix files found.');
    process.exit(0);
  }
  const distDir = path.join(cwd, 'dist');
  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir);
  for (const f of files) {
    const src = path.join(cwd, f);
    const dest = path.join(distDir, f);
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    fs.renameSync(src, dest);
    console.log(`Moved ${f} -> dist/${f}`);
  }
  process.exit(0);
} catch (err) {
  console.error('[move-vsix error]', err);
  process.exit(1);
}

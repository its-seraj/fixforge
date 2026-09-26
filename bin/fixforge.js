#!/usr/bin/env node

'use strict';

// Ensure Node >= 18
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error('\x1b[31mFixForge requires Node.js >= 18. Please upgrade.\x1b[0m');
  process.exit(1);
}

require('../src/cli/index.js');

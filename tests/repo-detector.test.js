'use strict';

/**
 * Unit tests for RepoDetector stack parsing (no network needed).
 * Run: node tests/repo-detector.test.js
 */

const { extractPathsFromStack, deriveProjectNames } = require('../src/utils/RepoDetector');

const assert = require('assert');

const tests = [
  {
    name: 'Node.js Linux stack',
    stack: `TypeError: Cannot read properties of undefined (reading 'userId')
    at getUserProfile (/home/deploy/my-backend/src/api/user.js:42:15)
    at async handler (/home/deploy/my-backend/src/routes/profile.js:18:3)
    at Layer.handle [as handle_request] (/home/deploy/my-backend/node_modules/express/lib/router/layer.js:95:5)`,
    expectedPaths: ['api/user.js', 'routes/profile.js'],
    expectedProject: 'my-backend',
  },
  {
    name: 'Node.js Windows stack',
    stack: `Error: DB connection timeout
    at connect (C:\\projects\\ecom-api\\src\\db\\postgres.js:88:11)
    at Server.<anonymous> (C:\\projects\\ecom-api\\src\\server.js:12:3)`,
    expectedPaths: ['src/db/postgres.js', 'src/server.js'],
    expectedProject: 'ecom-api',
  },
  {
    name: 'GitHub Actions runner path',
    stack: `ReferenceError: authMiddleware is not defined
    at Object.<anonymous> (/home/runner/work/serajkhan48522/payment-service/src/middleware/auth.js:5:1)`,
    expectedPaths: ['middleware/auth.js'],
    expectedProject: 'payment-service',
  },
  {
    name: 'Python stack',
    stack: `Traceback (most recent call last):
  File "/opt/app/user-service/app/models/user.py", line 34, in get_user
    raise ValueError("User not found")`,
    expectedPaths: ['models/user.py'],
    expectedProject: 'user-service',
  },
  {
    name: 'Filters out node_modules',
    stack: `Error at fn (/home/deploy/my-app/node_modules/express/lib/router.js:100:5)
    at realFn (/home/deploy/my-app/src/handler.js:22:3)`,
    expectedPaths: ['src/handler.js'],
    expectedProject: 'my-app',
  },
];

let passed = 0;
let failed = 0;

for (const t of tests) {
  const rawPaths = extractPathsFromStack(t.stack);

  // Convert to relative
  const SRC_MARKERS = ['src', 'app', 'lib', 'server', 'api', 'pkg',
    'routes', 'controllers', 'middleware', 'handlers', 'services',
    'models', 'utils', 'helpers', 'config', 'jobs', 'workers'];
  const relativePaths = rawPaths.map((p) => {
    const parts = p.split('/');
    let idx = -1;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (SRC_MARKERS.includes(parts[i])) { idx = i; break; }
    }
    return idx >= 0 ? parts.slice(idx).join('/') : parts.slice(-2).join('/');
  });

  const projectNames = deriveProjectNames(rawPaths);

  const pathsOk = t.expectedPaths.every((ep) => relativePaths.includes(ep));
  const projectOk = projectNames.includes(t.expectedProject);

  if (pathsOk && projectOk) {
    console.log(`  ✓  ${t.name}`);
    passed++;
  } else {
    console.error(`  ✗  ${t.name}`);
    if (!pathsOk) console.error(`     paths: expected ${JSON.stringify(t.expectedPaths)}, got ${JSON.stringify(relativePaths)}`);
    if (!projectOk) console.error(`     project: expected "${t.expectedProject}", got ${JSON.stringify(projectNames)}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

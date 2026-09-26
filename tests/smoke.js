'use strict';

/**
 * Smoke test — verifies all modules load without errors
 * Run: node tests/smoke.js
 */

const assert = require('assert');

const tests = [
  ['ConfigManager', () => require('../src/config/ConfigManager')],
  ['logger', () => require('../src/utils/logger')],
  ['gemini', () => require('../src/ai/gemini')],
  ['prompts', () => require('../src/ai/prompts')],
  ['JiraClient', () => require('../src/integrations/jira')],
  ['GitHubClient', () => require('../src/integrations/github')],
  ['MetricsStore', () => require('../src/dashboard/MetricsStore')],
  ['BugDetectionAgent', () => require('../src/agents/BugDetectionAgent')],
  ['BugResolverAgent', () => require('../src/agents/BugResolverAgent')],
  ['AgentOrchestrator', () => require('../src/agents/AgentOrchestrator')],
  ['webhook-server', () => require('../src/integrations/webhook-server')],
  ['PortScanner', () => require('../src/monitor/PortScanner')],
  ['LogWatcher', () => require('../src/monitor/LogWatcher')],
  ['ProcessRunner', () => require('../src/monitor/ProcessRunner')],
  ['BackgroundScanner', () => require('../src/monitor/BackgroundScanner')],
  ['Dashboard', () => require('../src/dashboard/Dashboard')],
  ['CLI index', () => {
    const { program } = require('commander');
    assert.ok(program);
  }],
];

let passed = 0;
let failed = 0;

for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}: ${err.message}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

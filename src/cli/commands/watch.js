'use strict';

const chalk = require('chalk');
const path = require('path');
const fs = require('fs');
const LogWatcher = require('../../monitor/LogWatcher');

async function runWatch(targetPath) {
  console.log(chalk.cyanBright('\n👀 FixForge Real-Time Log & Error Watcher\n'));

  const resolved = targetPath ? path.resolve(targetPath) : process.cwd();
  let filesToWatch = [];

  if (fs.existsSync(resolved)) {
    const stat = fs.statSync(resolved);
    if (stat.isFile()) {
      filesToWatch = [resolved];
    } else {
      filesToWatch = LogWatcher.findLogFiles(resolved);
    }
  }

  if (filesToWatch.length === 0) {
    console.log(chalk.yellow(`  No log files found in ${resolved}.`));
    console.log(chalk.gray('  Watching directory for newly created .log files…\n'));
  } else {
    console.log(chalk.bold('  Watching log files:'));
    for (const f of filesToWatch) {
      console.log(`    ${chalk.cyan('●')} ${f}`);
    }
    console.log('');
  }

  const watcher = new LogWatcher({ paths: filesToWatch });

  watcher.on('error-detected', (payload) => {
    console.log('\n' + chalk.bgRed.white.bold(' 🚨 ERROR DETECTED ') + ' ' + chalk.red.bold(payload.message.slice(0, 80)));
    console.log(chalk.gray(`  Source: ${payload.context?.source}`));
    console.log(chalk.yellow('  → Sending to FixForge webhook…'));
  });

  watcher.on('dispatched', ({ payload, response }) => {
    console.log(chalk.green('  ✓ Webhook accepted error! Jira bug created & resolution triggered.\n'));
  });

  watcher.on('dispatch-error', ({ err }) => {
    console.log(chalk.red(`  ✗ Failed to send to webhook: ${JSON.stringify(err)}\n`));
  });

  watcher.watch();

  console.log(chalk.gray('  Press Ctrl+C to stop watching\n'));
}

module.exports = { runWatch };

'use strict';

const { spawn } = require('child_process');
const chalk = require('chalk');
const LogWatcher = require('./LogWatcher');

/**
 * Runs a command (e.g. `node server.js` or `npm start`) while monitoring
 * stderr/stdout in real-time. If an uncaught error or stack trace occurs,
 * dispatches it immediately to the FixForge webhook.
 */
class ProcessRunner {
  static runCommand(commandStr, options = {}) {
    console.log(chalk.cyanBright(`\n🛡️  FixForge Error Interceptor active for:`));
    console.log(chalk.bold(`    ${commandStr}\n`));
    console.log(chalk.gray('  Any unhandled crash or error will be caught and raised to Jira via FixForge.\n'));

    const watcher = new LogWatcher({ port: options.port });

    watcher.on('error-detected', (payload) => {
      console.log('\n' + chalk.bgRed.white.bold(' 🚨 RUNTIME ERROR INTERCEPTED ') + ' ' + chalk.red.bold(payload.message.slice(0, 80)));
      console.log(chalk.yellow('  → Dispatching error to FixForge webhook…'));
    });

    watcher.on('dispatched', ({ payload, response }) => {
      console.log(chalk.green('  ✓ FixForge Webhook accepted error! Jira bug & resolution underway.\n'));
    });

    watcher.on('dispatch-error', ({ err }) => {
      console.log(chalk.red(`  ✗ Failed to send to webhook: ${JSON.stringify(err)}\n`));
    });

    // Spawn user's command
    const child = spawn(commandStr, {
      shell: true,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    // Pipe stdout through to console while scanning
    child.stdout.on('data', (data) => {
      process.stdout.write(data);
      watcher.processLogChunk(data.toString('utf8'), 'stdout');
    });

    // Pipe stderr through to console while scanning
    child.stderr.on('data', (data) => {
      process.stderr.write(data);
      watcher.processLogChunk(data.toString('utf8'), 'stderr');
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.log(chalk.yellow(`\nProcess exited with code ${code}.`));
      }
      process.exit(code || 0);
    });

    // Forward Ctrl+C
    process.on('SIGINT', () => {
      child.kill('SIGINT');
    });
  }
}

module.exports = ProcessRunner;

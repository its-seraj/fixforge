'use strict';

const chalk = require('chalk');
const ora = require('ora');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const { loadConfig, getConfigDir } = require('../../config/ConfigManager');

function getPidFile() {
  return path.join(getConfigDir(), 'webhook.pid');
}

function getLogFile() {
  return path.join(getConfigDir(), 'webhook.log');
}

async function stopDaemon() {
  const pidFile = getPidFile();
  if (!fs.existsSync(pidFile)) {
    console.log(chalk.yellow('No running webhook daemon PID found.'));
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  try {
    process.kill(pid);
    try { fs.unlinkSync(pidFile); } catch {}
    console.log(chalk.green(`✓ Webhook daemon (PID: ${pid}) stopped successfully.`));
  } catch (err) {
    console.log(chalk.yellow(`Process PID ${pid} is not running (${err.message}). Cleaning up PID file.`));
    try { fs.unlinkSync(pidFile); } catch {}
  }
}

async function startDaemon(port) {
  const spinner = ora('Starting webhook background daemon…').start();
  try {
    const pidFile = getPidFile();
    const logFile = getLogFile();

    // Check if an existing daemon is already responding
    try {
      await axios.get(`http://127.0.0.1:${port}/health`, { timeout: 1000 });
      spinner.info(`Webhook daemon is already running and listening on port ${port}.`);
      return;
    } catch {
      // not responding, continue
    }

    // Clean up stale pid file if present
    if (fs.existsSync(pidFile)) {
      try {
        const oldPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        if (oldPid && !isNaN(oldPid)) {
          process.kill(oldPid, 0); // test if running
          // If still running, kill old one before re-spawning
          process.kill(oldPid);
        }
      } catch {
        // Not running, safe to remove
      }
      try { fs.unlinkSync(pidFile); } catch {}
    }

    const projectRoot = path.resolve(__dirname, '../../../');
    const scriptPath = path.resolve(projectRoot, 'bin/fixforge.js');
    const logFd = fs.openSync(logFile, 'a');

    const child = spawn(
      process.execPath,
      [scriptPath, 'webhook', '--port', String(port), '--foreground'],
      {
        cwd: projectRoot,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
      }
    );

    fs.writeFileSync(pidFile, String(child.pid), 'utf8');
    child.unref();

    // Wait a brief moment to confirm the server came up
    let started = false;
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 600));
      try {
        await axios.get(`http://127.0.0.1:${port}/health`, { timeout: 1000 });
        started = true;
        break;
      } catch {
        // retry
      }
    }

    if (started) {
      spinner.succeed(`Webhook server started in background on port ${port} (PID: ${child.pid})`);
    } else {
      spinner.succeed(`Webhook server running in background on port ${port} (PID: ${child.pid})`);
    }
    console.log(chalk.gray(`  Logs:  ${logFile}`));
    console.log(chalk.gray(`  Stop:  fixforge webhook stop (or --stop)\n`));
  } catch (err) {
    spinner.fail(`Could not start background daemon: ${err.message}`);
    console.log(chalk.gray('  Run in foreground: fixforge webhook -f\n'));
  }
}

async function runWebhook({ port = 4242, foreground = false, stop = false } = {}) {
  if (stop) {
    await stopDaemon();
    return;
  }

  const cfg = loadConfig();
  if (!cfg) {
    console.error(chalk.red('FixForge not configured. Run `fixforge setup` first.'));
    process.exit(1);
  }

  const resolvedPort = port || cfg.webhookPort || 4242;

  // Background by default unless user passed --foreground / -f
  if (!foreground) {
    await startDaemon(resolvedPort);
    return;
  }

  const { createWebhookServer } = require('../../integrations/webhook-server');
  const app = createWebhookServer();

  app.listen(resolvedPort, () => {
    console.log(chalk.green(`\n✓ FixForge webhook server listening on port ${resolvedPort} (foreground)\n`));
    console.log(chalk.gray('Endpoints:'));
    console.log(`  POST http://localhost:${resolvedPort}/webhook/error    — receive runtime errors`);
    console.log(`  POST http://localhost:${resolvedPort}/webhook/github   — GitHub push events`);
    console.log(`  POST http://localhost:${resolvedPort}/webhook/resolve  — manual resolve trigger`);
    console.log(`  GET  http://localhost:${resolvedPort}/api/metrics      — metrics JSON`);
    console.log(`  GET  http://localhost:${resolvedPort}/health           — health check`);
    console.log(chalk.gray(`\nSigning secret: ${cfg.webhookSecret?.slice(0, 8)}…`));
    console.log(chalk.gray('Press Ctrl+C to stop (run `fixforge webhook` to start in background)\n'));
  });
}

module.exports = { runWebhook, startDaemon, stopDaemon };

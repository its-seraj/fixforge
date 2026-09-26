'use strict';

process.env.FIXFORGE_QUIET = '1';

const logger = require('../../utils/logger');
if (typeof logger.silenceConsole === 'function') {
  logger.silenceConsole();
}

const Dashboard = require('../../dashboard/Dashboard');
const { loadConfig } = require('../../config/ConfigManager');
const chalk = require('chalk');

async function runDashboard() {
  const cfg = loadConfig();
  if (!cfg) {
    console.error(chalk.red('FixForge not configured. Run `fixforge setup` first.'));
    process.exit(1);
  }

  const dashboard = new Dashboard();
  await dashboard.start();
}

module.exports = { runDashboard };

'use strict';

const chalk = require('chalk');
const ora = require('ora');
const AgentOrchestrator = require('../../agents/AgentOrchestrator');
const { loadConfig } = require('../../config/ConfigManager');

async function runResolve(jiraKey, { dryRun = false } = {}) {
  const cfg = loadConfig();
  if (!cfg) {
    console.error(chalk.red('FixForge not configured. Run `fixforge setup` first.'));
    process.exit(1);
  }

  console.log(chalk.cyanBright(`\n🔧  FixForge — Resolving ${chalk.bold(jiraKey)}\n`));

  if (dryRun) {
    console.log(chalk.yellow('⚠  Dry-run mode: analysis only, no changes will be pushed.\n'));
    process.env.FIXFORGE_DRY_RUN = '1';
  }

  const spinner = ora('Triggering resolution pipeline…').start();

  try {
    const orchestrator = new AgentOrchestrator();
    await orchestrator.handleManualResolve(jiraKey);
    spinner.succeed('Resolution pipeline completed successfully');
  } catch (err) {
    spinner.fail(`Resolution failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { runResolve };

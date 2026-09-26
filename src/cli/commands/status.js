'use strict';

const chalk = require('chalk');
const axios = require('axios');
const { loadConfig, configExists, getConfigDir } = require('../../config/ConfigManager');
const MetricsStore = require('../../dashboard/MetricsStore');
const dayjs = require('dayjs');

async function runStatus() {
  console.log(chalk.cyanBright('\n⚡ FixForge Status\n'));

  // ── Config ────────────────────────────────────────────────────────────────
  if (!configExists()) {
    console.log(chalk.red('  ✗ Not configured. Run `fixforge setup` to get started.\n'));
    return;
  }

  const cfg = loadConfig();
  console.log(chalk.bold('  Configuration'));
  console.log(`    Jira:      ${cfg.jiraUrl ? chalk.green('✓ ' + cfg.jiraUrl) : chalk.red('✗ Missing')}`);
  console.log(`    GitHub:    ${cfg.githubToken ? chalk.green('✓ ' + cfg.githubRepo) : chalk.red('✗ Missing')}`);
  const aiInfo = cfg.aiProvider === 'truefoundry' || cfg.truefoundryApiKey
    ? chalk.green(`✓ TrueFoundry Gateway (${cfg.truefoundryModel || 'vm-polaris/openai'})`)
    : (cfg.geminiApiKey ? chalk.green(`✓ Gemini (${cfg.geminiModel})`) : chalk.red('✗ Missing'));
  console.log(`    AI Provider: ${aiInfo}`);
  console.log(`    Approval:  ${chalk.cyan(cfg.approvalMode || 'always')}`);
  console.log(`    Config dir: ${getConfigDir()}\n`);

  // ── Webhook ───────────────────────────────────────────────────────────────
  console.log(chalk.bold('  Webhook Server'));
  const port = cfg.webhookPort || 4242;
  try {
    const res = await axios.get(`http://localhost:${port}/health`, { timeout: 2000 });
    console.log(`    Status: ${chalk.green('● ONLINE')} — port ${port}`);
    console.log(`    Version: ${res.data.version}`);
  } catch {
    console.log(`    Status: ${chalk.red('● OFFLINE')} — port ${port}`);
    console.log(`    Run: ${chalk.bold('fixforge webhook')} to start\n`);
  }

  // ── Metrics ───────────────────────────────────────────────────────────────
  try {
    const store = new MetricsStore();
    const summary = store.getSummary();
    console.log(chalk.bold('\n  Metrics'));
    console.log(`    Total tickets:       ${chalk.cyan(summary.total)}`);
    console.log(`    Resolved (PR/Done):  ${chalk.green(summary.resolved)}`);
    console.log(`    In progress:         ${chalk.yellow(summary.pending)}`);
    console.log(`    Unable To Resolve:   ${chalk.red(summary.failed)}`);
    console.log(`    Avg MTTR:            ${chalk.magenta(summary.mttrMinutes + ' min')}`);
    console.log(`    Webhook hits:        ${chalk.cyan(summary.webhookHits)}`);

    if (summary.bySeverity?.length) {
      console.log('\n  Severity Breakdown:');
      for (const s of summary.bySeverity) {
        const bar = '█'.repeat(Math.min(s.c, 20));
        console.log(`    ${(s.severity || 'Unknown').padEnd(10)} ${bar} ${s.c}`);
      }
    }

    const tickets = store.getTickets(8);
    if (tickets.length) {
      const formatStatus = (s) => {
        if (!s) return 'Unknown';
        if (s === 'done') return chalk.green('Done');
        if (s === 'pr_created' || s === 'awaiting_approval') return chalk.cyan('In Review');
        if (s === 'unable_to_resolve' || s === 'failed') return chalk.red('Unable To Resolve');
        if (['resolving', 'in_progress', 'code_fetched', 'root_cause_found', 'patch_generated'].includes(s)) return chalk.yellow('In Progress');
        return s;
      };

      console.log(chalk.bold('\n  Recent Tickets:'));
      for (const t of tickets) {
        const key = (t.jira_key || t.id.slice(0, 10)).padEnd(10);
        const title = (t.title || 'Untitled').slice(0, 42).padEnd(44);
        console.log(`    ${chalk.cyan(key)}  ${title}  ${formatStatus(t.status)}`);
      }
    }

    // ── Live Monitored Services ───────────────────────────────────────────────
    const services = store.getServices();
    console.log(chalk.bold(`\n  Autonomous Live Scanned Projects (${chalk.green(services.length + ' Active')})`));
    if (services.length) {
      for (const s of services) {
        const tag = s.status === 'ONLINE' ? chalk.green('● ONLINE') : chalk.red(`● ${s.status}`);
        console.log(`    • Port ${chalk.bold(s.port)} [${chalk.yellow(s.processName)} | PID ${s.pid}] ${tag}`);
        console.log(`      ${chalk.white(s.title)} ${chalk.gray('(last checked: ' + s.lastChecked + ')')}`);
      }
    } else {
      console.log(chalk.gray('    No active dev servers currently detected.'));
    }
  } catch (err) {
    console.log(`    ${chalk.yellow('No metrics yet.')}`);
  }

  console.log('');
}

module.exports = { runStatus };

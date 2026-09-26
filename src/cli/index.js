'use strict';

const { program } = require('commander');
const chalk = require('chalk');
const figlet = require('figlet');
const jiraSync = require('./commands/jiraSync');
const pkg = require('../../package.json');

// ── Banner ──────────────────────────────────────────────────────────────────
function printBanner() {
  console.log(
    chalk.cyanBright(
      figlet.textSync('FixForge', { font: 'Slant', horizontalLayout: 'default' })
    )
  );
  console.log(chalk.gray(`  v${pkg.version} — AI-powered ticket resolver\n`));
}

// ── Program ──────────────────────────────────────────────────────────────────
program
  .name('fixforge')
  .description('AI-powered bug detection & resolution CLI agent')
  .version(pkg.version);

// fixforge setup
program
  .command('setup')
  .description('Interactive wizard — configure Jira, GitHub, AI, and webhooks')
  .option('--reset', 'Reset existing configuration')
  .action(async (opts) => {
    printBanner();
    const { runSetup } = require('./commands/setup');
    await runSetup(opts);
  });

// fixforge webhook
program
  .command('webhook [action]')
  .description('Start or stop the webhook server (starts in background by default)')
  .option('-p, --port <port>', 'Port to listen on', '4242')
  .option('-f, --foreground', 'Run in foreground with live console logs')
  .option('--daemon', 'Run in background (default behavior)')
  .option('--stop', 'Stop running background server')
  .action(async (action, opts) => {
    if (action === 'stop') opts.stop = true;
    if (action === 'start') opts.foreground = false;
    const { runWebhook } = require('./commands/webhook');
    await runWebhook(opts);
  });

// fixforge resolve
program
  .command('resolve <jiraKey>')
  .description('Manually trigger the resolver agent for a Jira issue')
  .option('--dry-run', 'Analyse only, do not push any changes')
  .action(async (jiraKey, opts) => {
    const { runResolve } = require('./commands/resolve');
    await runResolve(jiraKey, opts);
  });

// fixforge dashboard
program
  .command('dashboard')
  .description('Open the real-time TUI dashboard')
  .action(async () => {
    const { runDashboard } = require('./commands/dashboard');
    await runDashboard();
  });

// fixforge scan
program
  .command('scan')
  .description('Scan listening ports to identify running web services')
  .option('-a, --all', 'Include system/OS ports')
  .action(async (opts) => {
    const { runScan } = require('./commands/scan');
    await runScan(opts);
  });

// fixforge watch
program
  .command('watch [path]')
  .description('Watch log files in real-time and auto-raise bugs to webhook on error')
  .action(async (targetPath) => {
    const { runWatch } = require('./commands/watch');
    await runWatch(targetPath);
  });

// fixforge run
program
  .command('run <command>')
  .description('Run an app command (e.g. `node server.js`) and auto-intercept crashes to webhook')
  .action(async (commandStr) => {
    const ProcessRunner = require('../monitor/ProcessRunner');
    ProcessRunner.runCommand(commandStr);
  });

// fixforge status
program
  .command('status')
  .description('Show current agent status, metrics and config health')
  .action(async () => {
    const { runStatus } = require('./commands/status');
    await runStatus();
  });

program.addCommand(jiraSync.command);

program.parseAsync(process.argv).catch((err) => {
  console.error(chalk.red('Fatal:'), err.message);
  process.exit(1);
});

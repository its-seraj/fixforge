'use strict';

const chalk = require('chalk');
const PortScanner = require('../../monitor/PortScanner');

async function runScan({ all = false } = {}) {
  console.log(chalk.cyanBright('\n🔍 FixForge Local Service & Port Scanner\n'));

  const services = PortScanner.scanOpenPorts({ includeSystem: all });

  if (services.length === 0) {
    console.log(chalk.yellow('  No listening services found.\n'));
    return;
  }

  // Format into a clean CLI table
  console.log(
    chalk.bold(
      '  ' +
      'PORT'.padEnd(8) +
      'PID'.padEnd(10) +
      'PROCESS'.padEnd(20) +
      'ADDRESS'.padEnd(20) +
      'TYPE'
    )
  );
  console.log('  ' + '─'.repeat(68));

  for (const s of services) {
    const isApp = ['node.exe', 'python.exe', 'java.exe', 'go.exe', 'ruby.exe', 'dotnet.exe'].includes(s.processName.toLowerCase());
    const isFixforge = s.port === 4242;

    let tag = chalk.gray('system');
    if (isFixforge) tag = chalk.cyan.bold('FixForge Webhook');
    else if (isApp) tag = chalk.green.bold('App Server');

    const portStr = chalk.bold(String(s.port).padEnd(8));
    const pidStr = chalk.gray(String(s.pid).padEnd(10));
    const nameStr = (isApp ? chalk.green(s.processName) : chalk.white(s.processName)).padEnd(20);
    const addrStr = chalk.gray(s.localAddress.padEnd(20));

    console.log(`  ${portStr}${pidStr}${nameStr}${addrStr}${tag}`);
  }

  console.log('');
  console.log(chalk.gray('  💡 Tip: To run any service with automatic error interception:'));
  console.log(chalk.bold('     fixforge run "node server.js"'));
  console.log(chalk.gray('  💡 Tip: To tail and watch log files in real-time for errors:'));
  console.log(chalk.bold('     fixforge watch ./logs\n'));
}

module.exports = { runScan };

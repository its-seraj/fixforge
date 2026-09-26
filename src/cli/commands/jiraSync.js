'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const axios = require('axios');
const { loadConfig } = require('../../config/ConfigManager');
const MetricsStore = require('../../dashboard/MetricsStore');

// Helper: fetch tickets from JIRA (open tickets only)
async function fetchJiraTickets(cfg) {
  const auth = Buffer.from(`${cfg.jiraEmail}:${cfg.jiraToken}`).toString('base64');
  // Adjust JQL as needed – we only want tickets that are not in a final state
  const jql = encodeURIComponent('statusCategory != Done');
  const url = `${cfg.jiraUrl.replace(/\/+$/, '')}/rest/api/3/search?jql=${jql}&maxResults=200`;
  const { data } = await axios.get(url, { headers: { Authorization: `Basic ${auth}` } });
  return data.issues.map(issue => ({
    id: issue.id,
    jiraKey: issue.key,
    title: issue.fields.summary,
    status: (issue.fields.status.name || '').toLowerCase().replace(/\s+/g, '_'),
    severity: (issue.fields.priority?.name || 'unknown').toLowerCase(),
    // Additional fields could be added here if required
  }));
}

async function syncJira() {
  const cfg = loadConfig();
  if (!cfg || !cfg.jiraUrl || !cfg.jiraEmail || !cfg.jiraToken) {
    console.error(chalk.red('⚙  JIRA configuration missing – run `fixforge setup` first.'));
    process.exit(1);
  }

  const store = new MetricsStore();
  // Clear existing tickets to avoid stale data
  store.db.set('tickets', []).write();

  const tickets = await fetchJiraTickets(cfg);
  for (const t of tickets) {
    store.upsertTicket(t);
  }

  console.log(chalk.green(`✅  Synced ${tickets.length} JIRA tickets to local store.`));
}

module.exports = {
  command: new Command('jira')
    .description('Refresh local ticket store from JIRA')
    .action(syncJira),
};

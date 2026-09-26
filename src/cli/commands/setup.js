'use strict';

const inquirer = require('inquirer');
const chalk = require('chalk');
const ora = require('ora');
const axios = require('axios');
const { saveConfig, loadConfig } = require('../../config/ConfigManager');
const { askTrueFoundry } = require('../../ai/gemini');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Mask a sensitive string: show first 4 + last 4 chars */
function mask(value) {
  if (!value) return chalk.gray('(not set)');
  if (value.length <= 8) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

/** Short display of a plain value */
function preview(value) {
  if (!value) return chalk.gray('(not set)');
  return chalk.green(value.length > 60 ? value.slice(0, 57) + '…' : value);
}

/**
 * Smart prompt with auto-save.
 *
 * - If `existing` has a value  → show "Keep / Change" list
 * - If not set                 → prompt immediately
 * After collecting the value, merges it into `store` and calls saveConfig(store)
 * so Ctrl+C at any point doesn't lose what's already been entered.
 */
async function smartPrompt(fieldDef, existing, sensitive, store) {
  const label = sensitive ? mask(existing) : preview(existing);

  let value;

  if (existing) {
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: `${fieldDef.message.replace(/:$/, '')}  ${chalk.gray(`[current: ${label}]`)}`,
        choices: [
          { name: 'Keep existing', value: 'keep' },
          { name: 'Change',        value: 'change' },
        ],
      },
    ]);

    if (action === 'keep') {
      value = existing;
    } else {
      const res = await inquirer.prompt([fieldDef]);
      value = res[fieldDef.name];
    }
  } else {
    // Not configured yet — go straight to the real prompt
    const res = await inquirer.prompt([fieldDef]);
    value = res[fieldDef.name];
  }

  // ── Persist immediately so Ctrl+C never loses this field ──────────────────
  store[fieldDef.name] = value;
  saveConfig({ ...store }); // shallow copy to avoid mutation issues

  return value;
}

// ── Gemini Model Selection Helper ─────────────────────────────────────────────
const GEMINI_MODELS = [
  { name: 'gemini-2.5-flash (Fast, recommended)', value: 'gemini-2.5-flash' },
  { name: 'gemini-3.5-flash (Next-gen flash)',      value: 'gemini-3.5-flash' },
  { name: 'gemini-2.5-pro   (Advanced reasoning)',  value: 'gemini-2.5-pro' },
  { name: 'Custom model name...',                   value: '__custom__' },
];

async function promptGeminiModel(existing, store) {
  let selected;

  if (existing) {
    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: `Gemini model  ${chalk.gray(`[current: ${existing}]`)}`,
      choices: [
        { name: 'Keep existing', value: 'keep' },
        { name: 'Change',        value: 'change' },
      ],
    }]);

    if (action === 'keep') {
      selected = existing;
    }
  }

  if (!selected) {
    const { model } = await inquirer.prompt([{
      type: 'list',
      name: 'model',
      message: 'Gemini model:',
      choices: GEMINI_MODELS,
      default: existing && GEMINI_MODELS.some(m => m.value === existing) ? existing : 'gemini-2.5-flash',
    }]);

    if (model === '__custom__') {
      const { customModel } = await inquirer.prompt([{
        type: 'input',
        name: 'customModel',
        message: 'Enter custom Gemini model name:',
        validate: (v) => v.trim() ? true : 'Please enter a valid model name',
      }]);
      selected = customModel.trim();
    } else {
      selected = model;
    }
  }

  store.geminiModel = selected;
  saveConfig({ ...store });
  return selected;
}

// ── Validators ────────────────────────────────────────────────────────────────
async function validateJira({ jiraUrl, jiraEmail, jiraToken }) {
  const res = await axios.get(`${jiraUrl}/rest/api/3/myself`, {
    auth: { username: jiraEmail, password: jiraToken },
    timeout: 8000,
  });
  return res.data.displayName;
}

async function validateGitHub({ githubToken, githubRepo }) {
  const { Octokit } = require('@octokit/rest');
  const octokit = new Octokit({ auth: githubToken });
  if (githubRepo) {
    const [owner, repo] = githubRepo.split('/');
    const { data } = await octokit.repos.get({ owner, repo });
    return `${data.full_name} (${data.private ? 'private' : 'public'})`;
  }
  const { data } = await octokit.users.getAuthenticated();
  return `authenticated as ${data.login}`;
}

async function validateGemini({ geminiApiKey, geminiModel }) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const model = genAI.getGenerativeModel({ model: geminiModel || 'gemini-2.5-flash' });
  await model.generateContent('ping');
  return true;
}
async function validateTruefoundry({ truefoundryApiKey, truefoundryBaseUrl, truefoundryModel }) {
  const cfg = { truefoundryApiKey, truefoundryBaseUrl, truefoundryModel };
  // Simple ping using TrueFoundry gateway
  await require('../../ai/gemini').askTrueFoundry('ping', '', cfg);
  return true;
}

// ── Section header ────────────────────────────────────────────────────────────
function sectionHeader(title) {
  const line = '─'.repeat(Math.max(0, 44 - title.length));
  console.log('\n' + chalk.bold.cyan(`  ── ${title} `) + chalk.cyan(line));
}

// ── Main setup ────────────────────────────────────────────────────────────────
async function runSetup({ reset } = {}) {
  // `store` is the live config object — updated after every single field
  const store = (reset ? null : loadConfig()) || {};
  const isRerun = Object.keys(store).length > 0;

  if (isRerun) {
    console.log(chalk.yellow('\n⚙  Resuming / updating FixForge configuration…'));
    console.log(chalk.gray('   Already-set fields show Keep / Change. New fields prompt for a value.\n'));
  } else {
    console.log(chalk.cyan('\n🔧  FixForge Setup Wizard\n'));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // JIRA
  // ══════════════════════════════════════════════════════════════════════════
  sectionHeader('Jira');

  await smartPrompt(
    { type: 'input', name: 'jiraUrl',
      message: 'Jira base URL:',
      validate: (v) => v.startsWith('https://') ? true : 'Must start with https://' },
    store.jiraUrl, false, store
  );

  await smartPrompt(
    { type: 'input', name: 'jiraEmail',
      message: 'Jira account email:',
      validate: (v) => v.includes('@') ? true : 'Enter a valid email' },
    store.jiraEmail, false, store
  );

  await smartPrompt(
    { type: 'password', name: 'jiraToken',
      message: 'Jira API token:', mask: '*' },
    store.jiraToken, true, store
  );

  await smartPrompt(
    { type: 'input', name: 'jiraProject',
      message: 'Jira project key (e.g. BUG):',
      validate: (v) => v.trim().length > 0 ? true : 'Required' },
    store.jiraProject, false, store
  );

  // ══════════════════════════════════════════════════════════════════════════
  // GITHUB
  // ══════════════════════════════════════════════════════════════════════════
  sectionHeader('GitHub');

  await smartPrompt(
    { type: 'password', name: 'githubToken',
      message: 'GitHub personal access token (repo + workflow scopes):', mask: '*' },
    store.githubToken, true, store
  );

  await smartPrompt(
    { type: 'input', name: 'githubRepo',
      message: 'Default GitHub repo (owner/repo) — leave blank to auto-detect from stack:',
      validate: (v) => v === '' || v.includes('/') ? true : 'Format must be owner/repo (or leave blank)' },
    store.githubRepo, false, store
  );

  await smartPrompt(
    { type: 'input', name: 'githubBaseBranch',
      message: 'Default base branch (PRs will target this branch):', default: 'main' },
    store.githubBaseBranch || 'main', false, store
  );
// ── AI Provider Selection ──────────────────────────────────────────────────────
sectionHeader('AI Provider');

await smartPrompt(
  {
    type: 'list',
    name: 'aiProvider',
    message: 'Select AI provider',
    choices: [
      { name: 'Google Gemini', value: 'gemini' },
      { name: 'TrueFoundry (OpenAI compatible)', value: 'truefoundry' },
    ],
  },
  store.aiProvider || 'gemini',
  false,
  store
);

if (store.aiProvider === 'truefoundry') {
  await smartPrompt(
    {
      type: 'input',
      name: 'truefoundryBaseUrl',
      message: 'TrueFoundry base URL (e.g., https://gateway.truefoundry.ai):',
      validate: v => v.startsWith('https://') ? true : 'Must start with https://',
    },
    store.truefoundryBaseUrl,
    false,
    store
  );

  await smartPrompt(
    {
      type: 'password',
      name: 'truefoundryApiKey',
      message: 'TrueFoundry API key:',
      mask: '*',
    },
    store.truefoundryApiKey,
    true,
    store
  );

  await smartPrompt(
    {
      type: 'input',
      name: 'truefoundryModel',
      message: 'TrueFoundry model name:',
      default: 'gpt-model',
    },
    store.truefoundryModel,
    false,
    store
  );
}

// ── End AI Provider Selection ────────────────────────────────────────────────

  // ══════════════════════════════════════════════════════════════════════════
  // GEMINI AI
  // ══════════════════════════════════════════════════════════════════════════
  sectionHeader('Gemini AI');

  await smartPrompt(
    { type: 'password', name: 'geminiApiKey',
      message: 'Gemini API key (https://aistudio.google.com/app/apikey):', mask: '*' },
    store.geminiApiKey, true, store
  );

  await promptGeminiModel(store.geminiModel || 'gemini-2.5-flash', store);

  // ── Instant Gemini connection check ────────────────────────────────────────
  // Retry loop: if the test fails, ask to re-enter API key or change model
  let geminiOk = false;

  while (!geminiOk) {
    const spinner = ora(`Testing Gemini (${store.geminiModel})…`).start();
    try {
      await validateGemini(store);
      spinner.succeed(chalk.green(`Gemini ✓  — Connected successfully (${store.geminiModel})`));
      geminiOk = true;
    } catch (err) {
      spinner.fail(chalk.red(`Gemini ✗  — ${err.message}`));

      const { action } = await inquirer.prompt([{
        type: 'list',
        name: 'action',
        message: 'Gemini connection failed. How would you like to proceed?',
        choices: [
          { name: 'Re-enter API key',                       value: 'key' },
          { name: 'Change model',                           value: 'model' },
          { name: 'Both (re-enter API key and change model)', value: 'both' },
          { name: 'Skip for now (continue setup)',          value: 'skip' },
        ],
      }]);

      if (action === 'skip') {
        console.log(chalk.yellow('  Skipping Gemini validation — you can update it later with `fixforge setup`.'));
        break;
      }

      if (action === 'key' || action === 'both') {
        await smartPrompt(
          {
            type: 'password',
            name: 'geminiApiKey',
            message: 'Gemini API key (https://aistudio.google.com/app/apikey):',
            mask: '*',
          },
          null,
          true,
          store
        );
      }

      if (action === 'model' || action === 'both') {
        await promptGeminiModel(null, store);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WEBHOOK
  // ══════════════════════════════════════════════════════════════════════════
  sectionHeader('Webhook');

  await smartPrompt(
    { type: 'number', name: 'webhookPort',
      message: 'Webhook server port:', default: 4242 },
    store.webhookPort || 4242, false, store
  );

  await smartPrompt(
    { type: 'input', name: 'webhookSecret',
      message: 'Webhook signing secret (leave blank to auto-generate):', default: '' },
    store.webhookSecret, true, store
  );

  if (!store.webhookSecret) {
    const { randomBytes } = require('crypto');
    store.webhookSecret = randomBytes(24).toString('hex');
    saveConfig({ ...store });
    console.log(chalk.gray('  → Signing secret auto-generated'));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BEHAVIOUR
  // ══════════════════════════════════════════════════════════════════════════
  sectionHeader('Behaviour');

  await smartPrompt(
    { type: 'list', name: 'approvalMode',
      message: 'Human approval gate:',
      choices: [
        { name: 'Always require approval before pushing', value: 'always' },
        { name: 'Auto-approve for low-severity bugs',      value: 'auto-low' },
        { name: 'Fully autonomous (no approval)',          value: 'autonomous' },
      ] },
    store.approvalMode || 'always', false, store
  );

  // ══════════════════════════════════════════════════════════════════════════
  // VALIDATION — only validate fields that changed from disk
  // ══════════════════════════════════════════════════════════════════════════
  console.log('');

  // Re-read original disk values (before this run) to detect changes
  const original = (reset ? null : null) || {}; // already merged into store above
  // Detect by comparing store to what it was at the start (we snapshot via isRerun)
  // Simply validate all Jira/GitHub/Gemini fields now since store is complete:
  const hasJira   = store.jiraUrl && store.jiraEmail && store.jiraToken;
  const hasGithub = store.githubToken;
  const hasGemini = store.geminiApiKey;

  if (hasJira) {
    const spinner = ora('Validating Jira credentials…').start();
    try {
      const name = await validateJira(store);
      spinner.succeed(`Jira ✓  — Logged in as ${chalk.bold(name)}`);
    } catch (err) {
      spinner.fail(`Jira ✗  — ${err.response?.data?.message || err.message}`);
      console.log(chalk.yellow('  Jira credentials saved but validation failed — fix and re-run `fixforge setup`.\n'));
    }
  }

  if (hasGithub) {
    const spinner = ora('Validating GitHub token…').start();
    try {
      const info = await validateGitHub(store);
      spinner.succeed(`GitHub ✓  — ${info}`);
    } catch (err) {
      spinner.fail(`GitHub ✗  — ${err.message}`);
      console.log(chalk.yellow('  GitHub token saved but validation failed — fix and re-run `fixforge setup`.\n'));
    }
  }

  if (hasGemini && !geminiOk) {
    const spinner = ora('Validating Gemini API key…').start();
    try {
      await validateGemini(store);
      spinner.succeed(`Gemini ✓  — API key valid`);
    } catch (err) {
      spinner.warn(`Gemini ✗  — ${err.message} (saved anyway)`);
    }
  }

  // Final save (already saved after each field, this ensures the complete state)
  saveConfig({ ...store });
  console.log(chalk.green(`\n✓  Configuration saved → ~/.fixforge/config.json\n`));

  // ── Optionally start daemon ────────────────────────────────────────────────
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm', name: 'confirm',
      message: 'Start webhook server as a background daemon now?',
      default: !isRerun,
    },
  ]);
  if (confirm) {
    const { startDaemon } = require('./webhook');
    await startDaemon(store.webhookPort);
  }

  console.log(chalk.cyanBright('\n🚀  FixForge is ready!\n'));
  console.log(`  ${chalk.bold('fixforge dashboard')}      — open the TUI dashboard`);
  console.log(`  ${chalk.bold('fixforge webhook')}        — (re)start webhook server`);
  console.log(`  ${chalk.bold('fixforge resolve BUG-1')}  — manually resolve a Jira issue`);
  console.log(`  ${chalk.bold('fixforge status')}         — view system health\n`);
}

module.exports = { runSetup };

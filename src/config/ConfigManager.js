'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CONFIG_DIR = path.join(os.homedir(), '.fixforge');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const KEY_FILE = path.join(CONFIG_DIR, '.key');

// ── Encryption helpers ────────────────────────────────────────────────────────
function getOrCreateKey() {
  if (fs.existsSync(KEY_FILE)) {
    return fs.readFileSync(KEY_FILE);
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  return key;
}

function encrypt(text) {
  const key = getOrCreateKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
  const key = getOrCreateKey();
  const [ivHex, encHex] = text.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

const SENSITIVE_KEYS = ['jiraToken', 'githubToken', 'geminiApiKey', 'truefoundryApiKey', 'openaiApiKey'];

function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const stored = { ...config };
  for (const k of SENSITIVE_KEYS) {
    if (stored[k]) stored[k] = encrypt(stored[k]);
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(stored, null, 2), { mode: 0o600 });
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  const stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  for (const k of SENSITIVE_KEYS) {
    if (stored[k]) {
      try {
        stored[k] = decrypt(stored[k]);
      } catch {
        // key may have changed; return raw
      }
    }
  }
  return stored;
}

function configExists() {
  return fs.existsSync(CONFIG_FILE);
}

function getConfigDir() {
  return CONFIG_DIR;
}

module.exports = { saveConfig, loadConfig, configExists, getConfigDir };

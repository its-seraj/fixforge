'use strict';

const axios = require('axios');
const logger = require('../utils/logger');
const { loadConfig } = require('../config/ConfigManager');

class JiraClient {
  constructor() {
    const cfg = loadConfig();
    if (!cfg) throw new Error('FixForge not configured. Run `fixforge setup` first.');
    this.base = cfg.jiraUrl.replace(/\/$/, '');
    this.auth = { username: cfg.jiraEmail, password: cfg.jiraToken };
    this.project = cfg.jiraProject;
  }

  _headers() {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async createBug({ summary, description, priority = 'High', labels = [], errorPayload = {} }) {
    const body = {
      fields: {
        project: { key: this.project },
        issuetype: { name: 'Bug' },
        summary,
        description: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: description }],
            },
            {
              type: 'codeBlock',
              attrs: { language: 'json' },
              content: [{ type: 'text', text: JSON.stringify(errorPayload, null, 2) }],
            },
          ],
        },
        priority: { name: priority },
        labels: ['fixforge', ...labels],
      },
    };

    const res = await axios.post(`${this.base}/rest/api/3/issue`, body, {
      auth: this.auth,
      headers: this._headers(),
    });

    logger.info('Jira bug created', { key: res.data.key });
    return res.data;
  }

  async getIssue(issueKey) {
    const res = await axios.get(`${this.base}/rest/api/3/issue/${issueKey}`, {
      auth: this.auth,
      headers: this._headers(),
    });
    return res.data;
  }

  async addComment(issueKey, commentText) {
    const body = {
      body: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: commentText }],
          },
        ],
      },
    };
    const res = await axios.post(
      `${this.base}/rest/api/3/issue/${issueKey}/comment`,
      body,
      { auth: this.auth, headers: this._headers() }
    );
    return res.data;
  }

  async transitionIssue(issueKey, statusName) {
    // Fetch available transitions
    const { data } = await axios.get(
      `${this.base}/rest/api/3/issue/${issueKey}/transitions`,
      { auth: this.auth, headers: this._headers() }
    );
    const transition = data.transitions.find(
      (t) => t.name.toLowerCase() === statusName.toLowerCase()
    );
    if (!transition) {
      logger.warn(`Transition "${statusName}" not found for ${issueKey}`);
      return;
    }
    await axios.post(
      `${this.base}/rest/api/3/issue/${issueKey}/transitions`,
      { transition: { id: transition.id } },
      { auth: this.auth, headers: this._headers() }
    );
    logger.info(`Jira issue ${issueKey} transitioned to "${statusName}"`);
  }

  async updateCustomField(issueKey, fieldId, value) {
    await axios.put(
      `${this.base}/rest/api/3/issue/${issueKey}`,
      { fields: { [fieldId]: value } },
      { auth: this.auth, headers: this._headers() }
    );
  }

  async addRemoteLink(issueKey, { url, title, summary }) {
    try {
      const body = {
        object: {
          url,
          title: title || 'GitHub Pull Request',
          summary: summary || 'FixForge automated fix PR',
          icon: {
            url16x16: 'https://github.githubassets.com/favicons/favicon.png',
            title: 'GitHub',
          },
        },
      };
      const res = await axios.post(
        `${this.base}/rest/api/3/issue/${issueKey}/remotelink`,
        body,
        { auth: this.auth, headers: this._headers() }
      );
      logger.info(`Remote PR link added to Jira ${issueKey}`, { url });
      return res.data;
    } catch (err) {
      logger.warn(`Could not add remote link to Jira ${issueKey}: ${err.message}`);
    }
  }

  async addLabel(issueKey, label) {
    try {
      await axios.put(
        `${this.base}/rest/api/3/issue/${issueKey}`,
        { update: { labels: [{ add: label }] } },
        { auth: this.auth, headers: this._headers() }
      );
      logger.info(`Label "${label}" added to Jira ${issueKey}`);
    } catch (err) {
      logger.warn(`Could not add label to Jira ${issueKey}: ${err.message}`);
    }
  }

  async removeLabel(issueKey, label) {
    try {
      await axios.put(
        `${this.base}/rest/api/3/issue/${issueKey}`,
        { update: { labels: [{ remove: label }] } },
        { auth: this.auth, headers: this._headers() }
      );
      logger.info(`Label "${label}" removed from Jira ${issueKey}`);
    } catch (err) {
      logger.warn(`Could not remove label from Jira ${issueKey}: ${err.message}`);
    }
  }

  async markUnableToResolve(issueKey, reason = 'AI autonomous resolution was unable to generate or verify a fix.') {
    await this.removeLabel(issueKey, 'in-progress').catch(() => {});
    await this.addLabel(issueKey, 'unable-to-resolve').catch(() => {});
    await this.transitionIssue(issueKey, 'Unable To Resolve').catch(() => {});
    await this.addComment(
      issueKey,
      [
        '⚠️ *FixForge Resolution Status:* Unable To Resolve',
        '',
        `*Reason:* ${reason}`,
        '',
        '👉 *Next Steps:* Autonomous resolution could not be safely completed by AI. Ticket has been transitioned to *Unable To Resolve* and escalated for engineering review.',
      ].join('\n')
    ).catch(() => {});
    logger.info(`Jira ${issueKey} marked as Unable To Resolve`, { reason });
  }

  async getRecentBugs(maxResults = 20) {
    const jql = `project = ${this.project} AND issuetype = Bug ORDER BY created DESC`;
    return this.getIssuesByJql(jql, maxResults);
  }

  async getIssuesByJql(jql, maxResults = 50) {
    try {
      const res = await axios.post(
        `${this.base}/rest/api/3/search/jql`,
        {
          jql,
          maxResults,
          fields: ['summary', 'status', 'priority', 'created', 'updated', 'labels'],
        },
        { auth: this.auth, headers: this._headers() }
      );
      return res.data.issues || [];
    } catch (err) {
      logger.warn(`Jira JQL search failed: ${err.message}`);
      return [];
    }
  }
}

module.exports = JiraClient;

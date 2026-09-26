'use strict';

const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { loadConfig } = require('../config/ConfigManager');
const logger = require('../utils/logger');

const GEMINI_FALLBACK_MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-flash-latest',
];

/**
 * Executes chat completion via TrueFoundry AI Gateway (OpenAI-compatible)
 */
async function askTrueFoundry(prompt, systemInstruction = '', cfg) {
  const apiKey = cfg.truefoundryApiKey;
  const baseUrl = (cfg.truefoundryBaseUrl || 'https://gateway.truefoundry.ai/v1').replace(/\/$/, '');
  const model = cfg.truefoundryModel || 'vm-polaris/openai';

  const messages = [];
  if (systemInstruction) {
    messages.push({ role: 'system', content: systemInstruction });
  }
  messages.push({ role: 'user', content: prompt });

  const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;

  logger.debug('TrueFoundry request', { model, url, promptChars: prompt.length });

  const res = await axios.post(
    url,
    {
      model,
      messages,
      temperature: 0.1,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60_000,
    }
  );

  const content = res.data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Empty response from TrueFoundry gateway');
  }

  logger.debug('TrueFoundry response', { model, length: content.length });
  return content;
}

/**
 * Executes generation via Google Gemini with multi-model fallback
 */
async function askGemini(prompt, systemInstruction = '', cfg) {
  if (!cfg?.geminiApiKey) throw new Error('Gemini API key not configured.');
  const genAI = new GoogleGenerativeAI(cfg.geminiApiKey);

  const preferredModel = cfg.geminiModel || 'gemini-2.5-flash-lite';
  const modelsToTry = [preferredModel, ...GEMINI_FALLBACK_MODELS.filter((m) => m !== preferredModel)];
  const fullPrompt = systemInstruction ? `${systemInstruction}\n\n${prompt}` : prompt;

  let lastError = null;
  for (const modelName of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      logger.debug('Gemini request', { model: modelName, chars: fullPrompt.length });
      const result = await model.generateContent(fullPrompt);
      const text = result.response.text();
      logger.debug('Gemini response', { model: modelName, chars: text.length });
      return text;
    } catch (err) {
      lastError = err;
      logger.warn(`[Gemini] Model ${modelName} error: ${err.message?.slice(0, 120)} — trying fallback…`);
      continue;
    }
  }

  throw lastError;
}

/**
 * Unified ask() function:
 * Routes to TrueFoundry if configured, with automatic fallback to Gemini (and vice versa).
 */
async function ask(prompt, systemInstruction = '') {
  const cfg = loadConfig();

  const useTrueFoundryFirst = cfg?.aiProvider === 'truefoundry' || (!cfg?.geminiApiKey && cfg?.truefoundryApiKey);

  if (useTrueFoundryFirst && cfg?.truefoundryApiKey) {
    try {
      return await askTrueFoundry(prompt, systemInstruction, cfg);
    } catch (tfErr) {
      logger.warn(`[TrueFoundry] Gateway request failed (${tfErr.message}) — attempting fallback to Gemini…`);
      if (cfg?.geminiApiKey) {
        return await askGemini(prompt, systemInstruction, cfg);
      }
      throw tfErr;
    }
  }

  // Default to Gemini (or fallback to TrueFoundry)
  if (cfg?.geminiApiKey) {
    try {
      return await askGemini(prompt, systemInstruction, cfg);
    } catch (geminiErr) {
      if (cfg?.truefoundryApiKey) {
        logger.warn(`[Gemini] Quota/error (${geminiErr.message}) — falling back to TrueFoundry AI Gateway…`);
        return await askTrueFoundry(prompt, systemInstruction, cfg);
      }
      throw geminiErr;
    }
  }

  if (cfg?.truefoundryApiKey) {
    return await askTrueFoundry(prompt, systemInstruction, cfg);
  }

  throw new Error('No AI provider configured. Provide TrueFoundry or Gemini credentials.');
}

/**
 * Parse a JSON block from AI response (it sometimes wraps in markdown fences).
 */
function parseJSON(text) {
  if (typeof text !== 'string') return text || {};
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = jsonMatch ? jsonMatch[1] : text;
  try {
    return JSON.parse(raw.trim());
  } catch {
    return { raw: text };
  }
}

module.exports = { ask, askTrueFoundry, askGemini, parseJSON };

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// All Gemini prompt templates used by the agents
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM = `You are FixForge, an expert AI software engineer specialising in bug detection,
root cause analysis, and code repair. Be concise, technically precise, and output
valid JSON when instructed.`;

function classifyErrorPrompt(errorPayload) {
  return `${SYSTEM}

Analyse the following runtime error payload and return a JSON object:
\`\`\`json
${JSON.stringify(errorPayload, null, 2)}
\`\`\`

Return ONLY valid JSON with:
{
  "title": "short bug summary (max 80 chars)",
  "severity": "Critical|High|Medium|Low",
  "category": "NullPointerException|DatabaseError|NetworkTimeout|MemoryLeak|AuthFailure|Unknown",
  "affectedFiles": ["list of likely file paths based on the stack trace"],
  "rootCauseHypothesis": "2-3 sentence hypothesis",
  "customerFacingSummary": "polite 1-sentence summary for end users",
  "labels": ["relevant", "jira", "labels"]
}`;
}

function rootCausePrompt({ errorPayload, codeSnippets }) {
  const snippets = codeSnippets
    .map((s) => `### ${s.file}\n\`\`\`\n${s.content.slice(0, 50000)}\n\`\`\``)
    .join('\n\n');

  return `${SYSTEM}

You have been given a runtime error and relevant source code files.
Perform a deep root cause analysis.

## Error Payload
\`\`\`json
${JSON.stringify(errorPayload, null, 2)}
\`\`\`

## Relevant Source Files
${snippets}

Return ONLY valid JSON:
{
  "rootCause": "detailed explanation",
  "affectedLines": [{"file": "path", "line": 42, "reason": "why"}],
  "fixStrategy": "step-by-step plan",
  "estimatedComplexity": "trivial|simple|moderate|complex",
  "riskLevel": "low|medium|high",
  "testScenarios": ["test case 1", "test case 2"]
}`;
}

function generatePatchPrompt({ rootCauseAnalysis, codeSnippets }) {
  const snippets = codeSnippets
    .map((s) => `### ${s.file}\n\`\`\`\n${s.content.slice(0, 50000)}\n\`\`\``)
    .join('\n\n');

  return `${SYSTEM}

Based on the root cause analysis and source files below, generate minimal, surgical patches.

CRITICAL PATCH REQUIREMENTS:
1. "file" must be the clean relative path shown in the header above (e.g. "routes/errors.js").
2. "searchBlock" MUST BE AN EXACT COPY-PASTE SUBSTRING taken directly from the source code above, matching character-for-character, including indentation. Do NOT alter, omit, or abbreviate lines. Pick a 2 to 10 line snippet that contains the bug.
3. "replaceBlock" is the exact replacement code that fixes the bug while preserving surrounding structure.
4. "commitMessage" concise conventional commit message.
5. "prTitle" clean human-readable title.
6. "prBody" comprehensive markdown summary including Root Cause, Solution, and Affected Components.

## Root Cause Analysis
${JSON.stringify(rootCauseAnalysis, null, 2)}

## Source Files
${snippets}

Return ONLY valid JSON:
{
  "patches": [
    {
      "file": "relative/path/to/file.js",
      "language": "javascript",
      "searchBlock": "exact verbatim lines from source code",
      "replaceBlock": "replacement code",
      "explanation": "why this change fixes the bug"
    }
  ],
  "commitMessage": "fix(scope): short description of the fix",
  "prTitle": "fix: human readable PR title",
  "prBody": "markdown PR description explaining the fix, root cause, and testing notes"
}`;
}

function customerReplyPrompt({ errorPayload, rootCauseAnalysis, jiraKey }) {
  return `${SYSTEM}

Draft a polite, professional customer-facing reply for the following bug.

Bug: ${rootCauseAnalysis.rootCause}
Jira: ${jiraKey}
Severity: ${errorPayload.severity || 'High'}

The reply should:
- Acknowledge the issue without technical jargon
- Briefly explain what went wrong (1-2 sentences)
- State that a fix has been developed and is under review
- Give an estimated timeline if severity is Critical or High
- Close warmly

Return ONLY the plain text reply, no JSON.`;
}

module.exports = {
  classifyErrorPrompt,
  rootCausePrompt,
  generatePatchPrompt,
  customerReplyPrompt,
};

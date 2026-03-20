export type ProjectRoomSignalKind = 'progress' | 'rebuttal';

export interface ProjectRoomSignal {
  kind: ProjectRoomSignalKind;
  summary: string;
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function summarize(input: string, max = 180): string {
  const normalized = normalizeWhitespace(input);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

export function detectProjectRoomSignal(text: string): ProjectRoomSignal | null {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return null;
  const lower = normalized.toLowerCase();

  const rebuttalPattern = /\b(rebut|counterpoint|disagree|conflict|blocked|blocker|risk|concern|issue|objection)\b/;
  if (rebuttalPattern.test(lower)) {
    return {
      kind: 'rebuttal',
      summary: summarize(normalized),
    };
  }

  const progressPattern = /\b(progress|update|updated|done|completed|finished|implemented|fixed|shipped|working on|in progress|next step|milestone)\b/;
  if (progressPattern.test(lower)) {
    return {
      kind: 'progress',
      summary: summarize(normalized),
    };
  }

  return null;
}

export interface ProjectBootstrapIntent {
  shouldHandle: boolean;
  destination: 'channel' | 'thread' | 'here';
  projectType: 'programming' | 'design' | 'research' | 'general';
  displayName: string;
  slug: string;
  description: string;
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function titleCaseFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function inferName(text: string): string {
  const normalized = normalizeWhitespace(text);

  const urlMatch = normalized.match(/https?:\/\/[^\s]+\/([^/\s?#]+)(?:[?#][^\s]*)?/i);
  if (urlMatch?.[1]) {
    return urlMatch[1].replace(/\.git$/i, '');
  }

  const quoted = normalized.match(/['"“”]([^'"“”]{2,80})['"“”]/);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }

  const forPhrase = normalized.match(/\b(?:for|called|named)\s+([A-Za-z0-9][A-Za-z0-9 ._\-/]{1,80})/i);
  if (forPhrase?.[1]) {
    return forPhrase[1]
      .replace(/\b(where|that|so|with|and)\b.*$/i, '')
      .trim()
      .replace(/[.,:;!?]+$/, '');
  }

  const projectPhrase = normalized.match(/\bproject(?:\s+space|\s+room|\s+workspace)?\s+(?:for|called|named)?\s*([A-Za-z0-9][A-Za-z0-9 ._\-/]{1,80})/i);
  if (projectPhrase?.[1]) {
    return projectPhrase[1]
      .replace(/\b(where|that|so|with|and)\b.*$/i, '')
      .trim()
      .replace(/[.,:;!?]+$/, '');
  }

  return 'New Collaboration Project';
}

function inferDescription(text: string, displayName: string): string {
  const normalized = normalizeWhitespace(text);
  const cleaned = normalized.replace(/^<@!?\d+>\s*/g, '').trim();
  if (cleaned.length <= 220) return cleaned;
  return `Collaborative workspace for ${displayName}.`;
}

function inferProjectType(text: string): ProjectBootstrapIntent['projectType'] {
  const normalized = normalizeWhitespace(text.toLowerCase());
  if (/\b(research|paper|literature|experiment|study|analysis|dataset)\b/.test(normalized)) {
    return 'research';
  }
  if (/\b(design|figma|ux|ui|brand|visual|prototype|mockup)\b/.test(normalized)) {
    return 'design';
  }
  if (/\b(code|coding|program|programming|repo|github|build|app|feature|bug|engineer|software)\b/.test(normalized)) {
    return 'programming';
  }
  return 'general';
}

export function inferProjectBootstrapIntent(text: string): ProjectBootstrapIntent {
  const normalized = normalizeWhitespace(text.toLowerCase());
  const isQuestion = /^(why|what|how|when|where|who)\b/.test(normalized)
    || /\bwhy\b.*\b(open|create|made?)\b/.test(normalized);
  const hasProjectWord = /\b(project|workspace|project space|collaboration room|collaboration space)\b/.test(normalized);
  const hasDestinationWord = /\b(channel|thread|room|space|workspace)\b/.test(normalized);
  const hasCreateWord = /\b(create|open|start|make|set up|setup|spin up|bootstrap)\b/.test(normalized);
  const shouldHandle = !isQuestion && hasCreateWord && (hasProjectWord || hasDestinationWord);

  const inferredName = inferName(text);
  const slug = slugify(inferredName) || 'new-collaboration-project';
  const displayName = inferredName === 'New Collaboration Project'
    ? titleCaseFromSlug(slug)
    : inferredName.trim();
  const description = inferDescription(text, displayName);

  const bindHere = /\b(this channel|here|in this room|use this channel|bind here)\b/.test(normalized);
  const wantsChannel = /\b(channel)\b/.test(normalized) && !/\bthread\b/.test(normalized);
  const wantsThread = /\b(new thread|create a thread|open a thread)\b/.test(normalized);
  const destination: ProjectBootstrapIntent['destination'] = bindHere
    ? 'here'
    : wantsChannel
      ? 'channel'
      : wantsThread
        ? 'thread'
        : 'here';

  return {
    shouldHandle,
    destination,
    projectType: inferProjectType(text),
    displayName,
    slug,
    description,
  };
}

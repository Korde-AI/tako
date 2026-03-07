/**
 * Input Sanitizer — detects and strips prompt injection patterns.
 *
 * Modes:
 * - 'strip': remove dangerous tokens, continue processing
 * - 'warn': log but don't modify
 * - 'block': reject the message entirely
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface SanitizerConfig {
  /** Enable input sanitization (default: true). */
  enabled: boolean;
  /** Action mode: 'strip', 'warn', or 'block'. */
  mode: 'strip' | 'warn' | 'block';
}

export interface SanitizeResult {
  /** The (possibly sanitized) text. */
  text: string;
  /** Whether any issues were detected. */
  flagged: boolean;
  /** Whether the message was blocked. */
  blocked: boolean;
  /** List of detected patterns. */
  detections: SanitizeDetection[];
}

export interface SanitizeDetection {
  pattern: string;
  category: 'injection' | 'extraction' | 'role_confusion' | 'encoding';
  severity: 'low' | 'medium' | 'high';
}

// ─── Patterns ───────────────────────────────────────────────────────

interface SanitizePattern {
  regex: RegExp;
  category: SanitizeDetection['category'];
  severity: SanitizeDetection['severity'];
  description: string;
}

const SANITIZE_PATTERNS: SanitizePattern[] = [
  // Prompt injection attempts
  {
    regex: /ignore\s+(all\s+)?previous\s+(instructions|rules|prompts)/gi,
    category: 'injection',
    severity: 'high',
    description: 'Ignore previous instructions',
  },
  {
    regex: /disregard\s+(all\s+)?(previous\s+)?(rules|instructions|prompts|context)/gi,
    category: 'injection',
    severity: 'high',
    description: 'Disregard rules',
  },
  {
    regex: /forget\s+(all\s+)?(your\s+)?(previous\s+)?(instructions|rules|training)/gi,
    category: 'injection',
    severity: 'high',
    description: 'Forget instructions',
  },
  {
    regex: /you\s+are\s+now\s+(a|an|the)\s+/gi,
    category: 'injection',
    severity: 'medium',
    description: 'Role override attempt',
  },
  {
    regex: /new\s+instructions?:?\s/gi,
    category: 'injection',
    severity: 'medium',
    description: 'New instructions injection',
  },
  {
    regex: /override\s+(system|safety|security)\s/gi,
    category: 'injection',
    severity: 'high',
    description: 'Override system prompt',
  },

  // System prompt extraction
  {
    regex: /repeat\s+(your\s+)?(system\s+)?(prompt|instructions)/gi,
    category: 'extraction',
    severity: 'medium',
    description: 'System prompt extraction',
  },
  {
    regex: /what\s+are\s+your\s+(system\s+)?(instructions|rules|constraints)/gi,
    category: 'extraction',
    severity: 'low',
    description: 'Instruction probing',
  },
  {
    regex: /show\s+(me\s+)?(your\s+)?(system\s+)?(prompt|instructions|configuration)/gi,
    category: 'extraction',
    severity: 'medium',
    description: 'Show system prompt',
  },
  {
    regex: /output\s+(your\s+)?(entire\s+)?(system\s+)?(prompt|message|instructions)/gi,
    category: 'extraction',
    severity: 'medium',
    description: 'Output system prompt',
  },

  // Role confusion tokens
  {
    regex: /<\|system\|>/gi,
    category: 'role_confusion',
    severity: 'high',
    description: 'System token injection',
  },
  {
    regex: /<\|(?:user|assistant|endoftext|im_start|im_end)\|>/gi,
    category: 'role_confusion',
    severity: 'high',
    description: 'Chat role token injection',
  },
  {
    regex: /\[INST\]/gi,
    category: 'role_confusion',
    severity: 'high',
    description: 'Llama instruction token',
  },
  {
    regex: /<<SYS>>/gi,
    category: 'role_confusion',
    severity: 'high',
    description: 'Llama system token',
  },
  {
    regex: /\[\/INST\]/gi,
    category: 'role_confusion',
    severity: 'high',
    description: 'Llama end instruction token',
  },
  {
    regex: /<\/?(?:system|human|assistant)>/gi,
    category: 'role_confusion',
    severity: 'high',
    description: 'XML role tag injection',
  },

  // Encoded payloads
  {
    regex: /base64[:\s]+[A-Za-z0-9+/]{50,}={0,2}/gi,
    category: 'encoding',
    severity: 'medium',
    description: 'Base64 encoded payload',
  },
];

// ─── Sanitizer ──────────────────────────────────────────────────────

export class InputSanitizer {
  private config: SanitizerConfig;

  constructor(config: SanitizerConfig) {
    this.config = config;
  }

  /**
   * Sanitize user input.
   */
  sanitize(text: string): SanitizeResult {
    if (!this.config.enabled) {
      return { text, flagged: false, blocked: false, detections: [] };
    }

    const detections: SanitizeDetection[] = [];

    for (const pattern of SANITIZE_PATTERNS) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(text)) {
        detections.push({
          pattern: pattern.description,
          category: pattern.category,
          severity: pattern.severity,
        });
      }
    }

    if (detections.length === 0) {
      return { text, flagged: false, blocked: false, detections: [] };
    }

    // Block mode
    if (this.config.mode === 'block') {
      const hasHigh = detections.some((d) => d.severity === 'high');
      if (hasHigh) {
        return {
          text: '',
          flagged: true,
          blocked: true,
          detections,
        };
      }
    }

    // Strip mode
    if (this.config.mode === 'strip') {
      let cleaned = text;
      for (const pattern of SANITIZE_PATTERNS) {
        pattern.regex.lastIndex = 0;
        cleaned = cleaned.replace(pattern.regex, '');
      }
      // Clean up extra whitespace from stripping
      cleaned = cleaned.replace(/\s{3,}/g, ' ').trim();
      return {
        text: cleaned,
        flagged: true,
        blocked: false,
        detections,
      };
    }

    // Warn mode — pass through unchanged
    return {
      text,
      flagged: true,
      blocked: false,
      detections,
    };
  }
}

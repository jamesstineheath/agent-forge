/**
 * parse-criteria.ts
 *
 * Pure utility to parse acceptance criteria from handoff v3 format PR descriptions.
 * No external dependencies — operates entirely on string input.
 */

export interface ParsedCriterion {
  criterion: string;
  category: 'http' | 'playwright' | 'not-verifiable';
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

const HTTP_PATTERNS = [
  /\/api\//i,
  /\bhttp\s*status\b/i,
  /\b[245]\d{2}\b/,           // status codes like 200, 404, 500
  /\b(4|5)xx\b/i,
  /\bjson\b/i,
  /\bpayload\b/i,
  /\bresponse\b/i,
  /\bendpoint\b/i,
  /\b(GET|POST|PUT|DELETE|PATCH)\b/,
  /\brest\b/i,
  /\broute\b/i,
  /\breturns?\b/i,
];

const PLAYWRIGHT_PATTERNS = [
  /\bbutton\b/i,
  /\bpage\b/i,
  /\bmodal\b/i,
  /\bform\b/i,
  /\bclick\b/i,
  /\bnavigate\b/i,
  /\bdisplay\b/i,
  /\bvisible\b/i,
  /\brender\b/i,
  /\buser\b/i,
  /\bbrowser\b/i,
  /\bredirect\b/i,
  /\bui\b/i,
  /\bcomponent\b/i,
  /\btext\b/i,
  /\blink\b/i,
  /\bmenu\b/i,
  /\btab\b/i,
  /\bscroll\b/i,
  /\binteract\b/i,
];

const NOT_VERIFIABLE_PATTERNS = [
  /\bcron\b/i,
  /\bschedul/i,
  /\benv(ironment)?\s*(var(iable)?)?/i,
  /\bsecret\b/i,
  /\bbackground\s*process\b/i,
  /\bbackground\s*job\b/i,
  /\bdaemon\b/i,
  /\bwebhook\b/i,
];

function classifyCriterion(criterion: string): 'http' | 'playwright' | 'not-verifiable' {
  // Strip bullet/numbering prefix for word-count check
  const text = criterion.replace(/^[-*\d.)\s]+/, '').trim();

  // Too vague: fewer than 5 words
  if (text.split(/\s+/).filter(Boolean).length < 5) {
    return 'not-verifiable';
  }

  // Check not-verifiable first (strongest signal)
  for (const pattern of NOT_VERIFIABLE_PATTERNS) {
    if (pattern.test(criterion)) return 'not-verifiable';
  }

  // Check http
  for (const pattern of HTTP_PATTERNS) {
    if (pattern.test(criterion)) return 'http';
  }

  // Check playwright
  for (const pattern of PLAYWRIGHT_PATTERNS) {
    if (pattern.test(criterion)) return 'playwright';
  }

  // Default: not-verifiable (too ambiguous to automate)
  return 'not-verifiable';
}

// ---------------------------------------------------------------------------
// Section extraction
// ---------------------------------------------------------------------------

/**
 * Find the acceptance criteria section in a PR description and return
 * the lines belonging to that section (up to the next ## heading).
 */
function extractAcceptanceCriteriaLines(prDescription: string): string[] {
  const lines = prDescription.split('\n');

  let inSection = false;
  const sectionLines: string[] = [];

  for (const line of lines) {
    // Detect start of acceptance criteria section
    if (!inSection) {
      if (/^#{1,6}\s*acceptance\s+criteria\s*$/i.test(line.trim())) {
        inSection = true;
        continue;
      }
      continue;
    }

    // Detect end of section: any new ## (or higher) heading
    if (/^#{2,}\s+/.test(line)) {
      break;
    }

    sectionLines.push(line);
  }

  return sectionLines;
}

/**
 * Extract bullet/numbered list items from a set of lines.
 */
function extractBulletItems(lines: string[]): string[] {
  const items: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Match: - item, * item, 1. item, 1) item
    const match = trimmed.match(/^(?:[-*]|\d+[.):])\s+(.+)$/);
    if (match) {
      items.push(match[1].trim());
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse acceptance criteria from a handoff v3 format PR description.
 *
 * @param prDescription - Full PR description text
 * @returns Array of parsed criteria with classification, or [] if no section found
 */
export function parseAcceptanceCriteria(prDescription: string): ParsedCriterion[] {
  if (!prDescription || typeof prDescription !== 'string') return [];

  const sectionLines = extractAcceptanceCriteriaLines(prDescription);
  if (sectionLines.length === 0) return [];

  const bulletItems = extractBulletItems(sectionLines);
  if (bulletItems.length === 0) return [];

  return bulletItems.map((criterion) => ({
    criterion,
    category: classifyCriterion(criterion),
  }));
}

/**
 * Extract the handoff title from the first # heading in a PR description.
 *
 * @param prDescription - Full PR description text
 * @returns Title string, or null if not found
 */
export function extractHandoffTitle(prDescription: string): string | null {
  if (!prDescription) return null;

  for (const line of prDescription.split('\n')) {
    const match = line.trim().match(/^#\s+(.+)$/);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * Extract file paths mentioned in a PR description.
 * Looks for:
 *  - Backtick-quoted paths containing a '/'
 *  - Bullet point lines that look like file paths (contain extension + slash)
 *  - Bare tokens that look like relative paths
 *
 * @param prDescription - Full PR description text
 * @returns Deduplicated array of file path strings
 */
export function extractFilePaths(prDescription: string): string[] {
  if (!prDescription) return [];

  const paths = new Set<string>();

  // Pattern 1: backtick-quoted paths e.g. `path/to/file.ts`
  const backtickPattern = /`([^`]*\/[^`]*\.[a-zA-Z]{1,6})`/g;
  let match: RegExpExecArray | null;
  while ((match = backtickPattern.exec(prDescription)) !== null) {
    paths.add(match[1].trim());
  }

  // Pattern 2: bullet list items that look like file paths
  // e.g. "- path/to/file.ts" or "- `path/to/file.ts`"
  const FILE_EXTENSIONS = /\.(ts|tsx|js|jsx|yml|yaml|json|md|css|html|sh)$/i;
  for (const line of prDescription.split('\n')) {
    const trimmed = line.trim();
    // Bullet line
    const bulletMatch = trimmed.match(/^[-*]\s+`?([^\s`]+)`?\s*$/);
    if (bulletMatch) {
      const candidate = bulletMatch[1].replace(/`/g, '').trim();
      if (FILE_EXTENSIONS.test(candidate) && candidate.includes('/')) {
        paths.add(candidate);
      }
    }
  }

  // Pattern 3: bare path-like tokens anywhere in text (e.g. lib/atc.ts, .github/actions/foo/bar.yml)
  const barePathPattern = /(?:^|\s)(\.?[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+\.[a-zA-Z]{1,6})(?:\s|$|[,;)])/gm;
  while ((match = barePathPattern.exec(prDescription)) !== null) {
    const candidate = match[1].trim();
    if (FILE_EXTENSIONS.test(candidate)) {
      paths.add(candidate);
    }
  }

  return Array.from(paths);
}

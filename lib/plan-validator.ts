import { PlanValidation, PlanValidationIssue } from './types';
import { fetchPageContent } from './notion';
import { listRepos } from './repos';

const REQUIRED_SECTIONS = [
  'Overview',
  'Components',
  'Sequencing Constraints',
  'Acceptance Criteria',
] as const;

const VAGUE_PHRASES = [
  'works correctly',
  'is good',
  'functions properly',
];

/**
 * Checks whether the plan content contains a given section heading (H1, H2, or H3).
 * Match is case-insensitive. For 'Components', also accepts headings starting with 'Components'.
 */
function hasSection(content: string, section: string): boolean {
  const headingPattern = /^#{1,3}\s+(.+)$/gm;
  const matches = [...content.matchAll(headingPattern)].map(m => m[1].trim());

  return matches.some(heading => {
    const h = heading.toLowerCase();
    const s = section.toLowerCase();
    if (s === 'components') {
      return h.startsWith('components');
    }
    return h === s;
  });
}

/**
 * Extracts lines from the Acceptance Criteria section until the next heading.
 */
function extractAcceptanceCriteria(content: string): string[] {
  const lines = content.split('\n');
  let inSection = false;
  const criteria: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (headingMatch) {
      const heading = headingMatch[1].trim().toLowerCase();
      if (heading === 'acceptance criteria') {
        inSection = true;
        continue;
      } else if (inSection) {
        break;
      }
    }
    if (inSection) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const criterion = trimmed.replace(/^[-*\d+.]\s*/, '').trim();
        if (criterion.length > 0) {
          criteria.push(criterion);
        }
      }
    }
  }

  return criteria;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function isVague(criterion: string): boolean {
  const lower = criterion.toLowerCase();
  return VAGUE_PHRASES.some(phrase => lower.includes(phrase));
}

/**
 * Extract repo-like references from content (e.g., "owner/repo" patterns).
 */
function extractRepoReferences(content: string): string[] {
  const repoPattern = /\b([a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)\b/g;
  const matches = [...content.matchAll(repoPattern)];
  return [...new Set(matches.map(m => m[1]))];
}

export async function validatePlan(projectId: string): Promise<PlanValidation> {
  const issues: PlanValidationIssue[] = [];
  const checkedAt = new Date().toISOString();

  // Fetch plan page content
  let content: string;
  try {
    content = await fetchPageContent(projectId);
  } catch (err) {
    return {
      valid: false,
      issues: [{
        severity: 'error',
        message: `Failed to fetch plan page content: ${err instanceof Error ? err.message : String(err)}`,
      }],
      projectId,
      checkedAt,
    };
  }

  if (!content || content.trim().length === 0) {
    return {
      valid: false,
      issues: [{
        severity: 'error',
        message: 'Plan page content is empty or could not be fetched.',
      }],
      projectId,
      checkedAt,
    };
  }

  // 1. Check required sections
  for (const section of REQUIRED_SECTIONS) {
    if (!hasSection(content, section)) {
      issues.push({
        severity: 'error',
        message: `Required section "${section}" is missing from the plan.`,
        section,
      });
    }
  }

  // 2. Validate acceptance criteria
  const criteria = extractAcceptanceCriteria(content);

  if (criteria.length < 3) {
    issues.push({
      severity: 'warning',
      message: `Acceptance Criteria section contains ${criteria.length} criterion/criteria; at least 3 are recommended.`,
      section: 'Acceptance Criteria',
    });
  }

  for (const criterion of criteria) {
    if (wordCount(criterion) < 10) {
      issues.push({
        severity: 'warning',
        message: `Acceptance criterion is too short (fewer than 10 words): "${criterion}"`,
        section: 'Acceptance Criteria',
      });
    } else if (isVague(criterion)) {
      issues.push({
        severity: 'warning',
        message: `Acceptance criterion contains vague language: "${criterion}"`,
        section: 'Acceptance Criteria',
      });
    }
  }

  // 3. Check repo references against registry
  try {
    const registeredRepos = await listRepos();
    const repoFullNames = registeredRepos.map(r => r.fullName.toLowerCase());
    const referencedRepos = extractRepoReferences(content);

    for (const ref of referencedRepos) {
      if (!repoFullNames.includes(ref.toLowerCase())) {
        issues.push({
          severity: 'warning',
          message: `Referenced repo "${ref}" is not found in the repos registry.`,
        });
      }
    }
  } catch {
    issues.push({
      severity: 'warning',
      message: 'Could not load repos registry to validate repo references.',
    });
  }

  const valid = !issues.some(i => i.severity === 'error');

  return {
    valid,
    issues,
    projectId,
    checkedAt,
  };
}

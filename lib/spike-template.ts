import { SpikeRecommendation, SpikeMetadata } from './types';

export type SpikeFindingsParsed = {
  parentPrdId: string;
  question: string;
  tried: string;
  findings: string;
  recommendation: SpikeRecommendation;
  implications: string;
};

export function generateSpikeTemplate(metadata: SpikeMetadata): string {
  return `## Parent PRD
${metadata.parentPrdId ?? ''}

## Technical Question
${metadata.technicalQuestion ?? ''}

## What Was Tried
<!-- Describe the approaches, experiments, or research conducted -->

## Detailed Findings
<!-- Summarize what was discovered, including relevant data, code snippets, or links -->

## Recommendation (GO / GO_WITH_CHANGES / NO_GO)
<!-- State one of: GO, GO_WITH_CHANGES, NO_GO -->

## Implications for Parent PRD
<!-- Describe how these findings affect the parent PRD scope, design, or timeline -->
`;
}

function extractSections(markdown: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const parts = markdown.split(/^(?=##\s)/m);
  for (const part of parts) {
    const lines = part.split('\n');
    const headingLine = lines[0].trim();
    if (/^##\s/.test(headingLine)) {
      const heading = headingLine.replace(/^##\s+/, '').trim();
      const content = lines.slice(1).join('\n').trim();
      sections[heading] = content;
    }
  }
  return sections;
}

export function parseSpikeFindings(markdown: string): SpikeFindingsParsed {
  const sections = extractSections(markdown);

  function getSection(keyPattern: RegExp): string {
    for (const [heading, content] of Object.entries(sections)) {
      if (keyPattern.test(heading)) {
        return content;
      }
    }
    return '';
  }

  const parentPrdId = getSection(/parent\s+prd/i);
  const question = getSection(/technical\s+question/i);
  const tried = getSection(/what\s+was\s+tried/i);
  const findings = getSection(/detailed\s+findings/i);
  const implications = getSection(/implications/i);

  const rawRecommendation = getSection(/recommendation/i);
  const recNormalized = rawRecommendation.toUpperCase().replace(/[\s\-]+/g, '_');

  let recommendation: SpikeRecommendation;

  if (recNormalized.includes('GO_WITH_CHANGES')) {
    recommendation = 'GO_WITH_CHANGES';
  } else if (recNormalized.includes('NO_GO') || recNormalized.includes('NOGO')) {
    recommendation = 'NO_GO';
  } else if (recNormalized.includes('GO')) {
    recommendation = 'GO';
  } else {
    throw new Error(
      `parseSpikeFindings: could not extract SpikeRecommendation from section content: "${rawRecommendation}"`
    );
  }

  return {
    parentPrdId,
    question,
    tried,
    findings,
    recommendation,
    implications,
  };
}

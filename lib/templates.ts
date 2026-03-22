import * as fs from 'fs/promises';
import * as path from 'path';
import { PipelineLevel } from './types';

export interface TemplateFile {
  path: string;   // e.g. '.github/workflows/execute-handoff.yml'
  content: string;
}

const TEMPLATES_DIR = path.join(process.cwd(), 'templates');

async function readTemplate(relativePath: string): Promise<string> {
  const fullPath = path.join(TEMPLATES_DIR, relativePath);
  return fs.readFile(fullPath, 'utf-8');
}

export async function getTemplateFiles(pipelineLevel: PipelineLevel): Promise<TemplateFile[]> {
  const executeHandoff: TemplateFile = {
    path: '.github/workflows/execute-handoff.yml',
    content: await readTemplate('workflows/execute-handoff.yml'),
  };

  if (pipelineLevel === 'execute-only') {
    return [executeHandoff];
  }

  // full-tlm: 4 workflows only (actions are referenced cross-repo from agent-forge)
  const [
    tlmReviewWorkflow,
    tlmSpecReviewWorkflow,
    tlmOutcomeTrackerWorkflow,
  ] = await Promise.all([
    readTemplate('workflows/tlm-review.yml'),
    readTemplate('workflows/tlm-spec-review.yml'),
    readTemplate('workflows/tlm-outcome-tracker.yml'),
  ]);

  return [
    executeHandoff,
    {
      path: '.github/workflows/tlm-review.yml',
      content: tlmReviewWorkflow,
    },
    {
      path: '.github/workflows/tlm-spec-review.yml',
      content: tlmSpecReviewWorkflow,
    },
    {
      path: '.github/workflows/tlm-outcome-tracker.yml',
      content: tlmOutcomeTrackerWorkflow,
    },
  ];
}

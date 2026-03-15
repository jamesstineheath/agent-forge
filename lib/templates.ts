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

  // full-tlm: all 4 workflows + 3 actions = 7 files
  const [
    tlmReviewWorkflow,
    tlmSpecReviewWorkflow,
    tlmOutcomeTrackerWorkflow,
    tlmReviewAction,
    tlmSpecReviewAction,
    tlmOutcomeTrackerAction,
  ] = await Promise.all([
    readTemplate('workflows/tlm-review.yml'),
    readTemplate('workflows/tlm-spec-review.yml'),
    readTemplate('workflows/tlm-outcome-tracker.yml'),
    readTemplate('actions/tlm-review/action.yml'),
    readTemplate('actions/tlm-spec-review/action.yml'),
    readTemplate('actions/tlm-outcome-tracker/action.yml'),
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
    {
      path: '.github/actions/tlm-review/action.yml',
      content: tlmReviewAction,
    },
    {
      path: '.github/actions/tlm-spec-review/action.yml',
      content: tlmSpecReviewAction,
    },
    {
      path: '.github/actions/tlm-outcome-tracker/action.yml',
      content: tlmOutcomeTrackerAction,
    },
  ];
}

#!/usr/bin/env npx tsx
// scripts/bootstrap-repo.ts
// One-command project setup: creates a GitHub repo with CI, TLM agents, and pipeline integration.
//
// Usage:
//   npx tsx scripts/bootstrap-repo.ts <repo-name> [options]
//
// Options:
//   --private            Create a private repo (default: public)
//   --description "..."  Repo description
//   --level <level>      Pipeline level: execute-only | full-tlm (default: full-tlm)
//   --vercel             Create a Vercel project linked to the repo
//   --framework <name>   Vercel framework preset (default: nextjs)
//
// Required env vars:
//   GH_PAT               GitHub PAT with repo:create scope
//   ANTHROPIC_API_KEY    For seeding repo secrets
//
// Example:
//   GH_PAT=ghp_xxx npx tsx scripts/bootstrap-repo.ts my-new-app --level full-tlm --vercel

import { bootstrapRepo } from '../lib/bootstrapper';
import type { PipelineLevel, BootstrapStep, PreflightChecklistItem } from '../lib/types';

function printUsage() {
  console.log(`
Usage: npx tsx scripts/bootstrap-repo.ts <repo-name> [options]

Options:
  --private            Create a private repo
  --description "..."  Repo description
  --level <level>      execute-only | full-tlm (default: full-tlm)
  --vercel             Create a Vercel project
  --framework <name>   Vercel framework preset (default: nextjs)

Required env vars: GH_PAT, ANTHROPIC_API_KEY
`);
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage();
    process.exit(0);
  }

  const repoName = args[0];
  let isPrivate = false;
  let description: string | undefined;
  let pipelineLevel: PipelineLevel = 'full-tlm';
  let createVercelProject = false;
  let vercelFramework: string | undefined;

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--private':
        isPrivate = true;
        break;
      case '--description':
        description = args[++i];
        break;
      case '--level':
        pipelineLevel = args[++i] as PipelineLevel;
        if (pipelineLevel !== 'execute-only' && pipelineLevel !== 'full-tlm') {
          console.error(`Invalid level: ${pipelineLevel}. Must be execute-only or full-tlm.`);
          process.exit(1);
        }
        break;
      case '--vercel':
        createVercelProject = true;
        break;
      case '--framework':
        vercelFramework = args[++i];
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        printUsage();
        process.exit(1);
    }
  }

  return { repoName, isPrivate, description, pipelineLevel, createVercelProject, vercelFramework };
}

function stepIcon(status: BootstrapStep['status']): string {
  switch (status) {
    case 'success': return '\u2713';
    case 'failed': return '\u2717';
    case 'skipped': return '-';
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main() {
  const opts = parseArgs(process.argv);

  // Validate required env vars
  if (!process.env.GH_PAT) {
    console.error('Error: GH_PAT environment variable is required.');
    process.exit(1);
  }

  console.log(`\nBootstrapping repo: ${opts.repoName}`);
  console.log(`  Pipeline: ${opts.pipelineLevel}`);
  console.log(`  Private: ${opts.isPrivate}`);
  console.log(`  Vercel: ${opts.createVercelProject}`);
  console.log('');

  const startTime = Date.now();

  const result = await bootstrapRepo(opts.repoName, {
    repoName: opts.repoName,
    description: opts.description,
    pipelineLevel: opts.pipelineLevel,
    isPrivate: opts.isPrivate,
    createVercelProject: opts.createVercelProject,
    vercelFramework: opts.vercelFramework,
    onProgress: (step, status) => {
      if (status === 'start') {
        process.stdout.write(`  ${step}... `);
      } else {
        console.log(status);
      }
    },
  });

  const elapsed = Date.now() - startTime;

  // Print results
  console.log(`\n${'='.repeat(60)}`);
  console.log('Bootstrap Results');
  console.log('='.repeat(60));

  for (const step of result.steps) {
    const icon = stepIcon(step.status);
    const detail = step.detail ? ` (${step.detail})` : '';
    console.log(`  [${icon}] ${step.name}${detail}`);
  }

  console.log(`\nCompleted in ${formatDuration(elapsed)}`);

  if (result.repoUrl) {
    console.log(`\nRepo URL: ${result.repoUrl}`);
  }
  if (result.vercelProjectUrl) {
    console.log(`Vercel:   ${result.vercelProjectUrl}`);
  }
  if (result.registrationId) {
    console.log(`Reg ID:   ${result.registrationId}`);
  }

  // Print pre-flight checklist
  const hasFailures = result.steps.some(s => s.status === 'failed');
  if (result.checklist.length > 0) {
    console.log(`\n${'='.repeat(60)}`);
    console.log('Pre-Flight Checklist');
    console.log('='.repeat(60));

    const required = result.checklist.filter((c: PreflightChecklistItem) => c.required);
    const optional = result.checklist.filter((c: PreflightChecklistItem) => !c.required);

    if (required.length > 0) {
      console.log('\nRequired:');
      for (const item of required) {
        console.log(`  [ ] [${item.category}] ${item.description}`);
      }
    }

    if (optional.length > 0) {
      console.log('\nOptional:');
      for (const item of optional) {
        console.log(`  [ ] [${item.category}] ${item.description}`);
      }
    }
  }

  if (hasFailures) {
    console.log('\nBootstrap completed with errors. Check the steps above.');
    process.exit(1);
  } else {
    console.log('\nBootstrap completed successfully!');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

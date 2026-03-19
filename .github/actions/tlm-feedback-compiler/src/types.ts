export interface DetectedPattern {
  id: string;
  description: string;
  severity: "high" | "medium" | "low";
  evidence: PatternEvidence[];
  affected_agent: "code_reviewer" | "spec_reviewer" | "outcome_tracker" | "cross_agent";
  category:
    | "elevated_failure_rate"
    | "repeated_failure_mode"
    | "cross_agent_misalignment"
    | "stale_pattern"
    | "prompt_gap"
    | "ineffective_change";
  recommendation: string;
}

export interface PatternEvidence {
  source: "memory" | "pr_history" | "prompt" | "history_json";
  reference: string;
  detail: string;
}

export interface ProposedChange {
  target_file: string;
  description: string;
  pattern_id: string;
  original_section: string;
  replacement_section: string;
  expected_impact: string;
}

export interface FileDiff {
  file_path: string;
  original_content: string;
  new_content: string;
}

export interface ChangeRecord {
  date: string;
  pattern_id: string;
  description: string;
  target_file: string;
  pr_number: number | null;
  pr_url: string | null;
  status: "proposed" | "merged" | "rejected" | "reverted";
  effective: boolean | null;
  follow_up_notes: string;
}

export interface CompilerHistory {
  changes: ChangeRecord[];
  last_run: string;
}

export interface CompilerAnalysis {
  patterns: DetectedPattern[];
  proposed_changes: ProposedChange[];
  work_items: ProposedWorkItem[];
  escalations: EscalationItem[];
  summary: string;
  data_quality: {
    total_assessments: number;
    non_premature_count: number;
    sufficient_data: boolean;
  };
}

export interface EscalationItem {
  title: string;
  description: string;
  severity: "high" | "medium";
  related_pattern_id: string;
}

export interface ProposedWorkItem {
  title: string;
  description: string;
  target_repo: string;
  type: "feature" | "bugfix" | "refactor" | "chore";
  complexity: "simple" | "moderate" | "complex";
  priority: "high" | "medium" | "low";
  related_pattern_id: string;
  expected_impact: string;
}

export interface TLMMemory {
  hot_patterns: Array<{ date: string; description: string }>;
  recent_outcomes: MemoryEntry[];
  lessons_learned: string[];
  stats: {
    total_assessed: number;
    correct_count: number;
    reversed_count: number;
    issues_count: number;
    missed_count: number;
    last_assessment: string;
    assessment_frequency: string;
  };
}

export interface MemoryEntry {
  pr_number: number;
  title: string;
  merged_at: string;
  outcome: string;
  assessed_at: string;
}

export interface AnalysisContext {
  memory: TLMMemory;
  agentPrompts: Record<string, string>;
  recentPRs: PRSummary[];
  previousChanges: CompilerHistory;
}

export interface PRSummary {
  number: number;
  title: string;
  merged_at: string;
  outcome: string | null;
  changed_files: string[];
  tlm_decision: string;
}

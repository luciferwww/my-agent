export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly relativeDirectory: string;
}

export interface SkillDiagnostic {
  readonly path: string;
  readonly code: 'invalid_skill' | 'read_failed' | 'duplicate_name';
  readonly message: string;
}

export interface SkillCatalog {
  readonly entries: readonly SkillSummary[];
  readonly diagnostics: readonly SkillDiagnostic[];
}

export interface LoadedSkill {
  readonly name: string;
  readonly directory: string;
  readonly content: string;
}

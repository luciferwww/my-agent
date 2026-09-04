import { existsSync } from 'node:fs';
import type { ResolvedModel } from '../model-resolution/index.js';
import type { AgentRunner, RunResult } from '../runner/index.js';
import type { SystemPromptBuilder } from '../prompt/SystemPromptBuilder.js';
import type { ContextFile } from '../workspace/types.js';
import { buildSubagentBehavioralAddendum } from './behavioral-addendum.js';
import type { SubagentProfile } from './types.js';

export interface SubagentExecutorDeps {
  readonly agentRunner: AgentRunner;
  readonly systemPromptBuilder: SystemPromptBuilder;
  readonly loadContextFilesFromDir: (absDir: string) => Promise<ContextFile[]>;
  readonly workspaceDir: string;
  readonly promptSafetyLevel: 'relaxed' | 'normal' | 'strict';
}

export interface SubagentExecutionRequest {
  readonly profile: SubagentProfile;
  readonly description: string;
  readonly prompt: string;
  readonly parentContextFiles: readonly ContextFile[];
  readonly childDepth: number;
  readonly canSpawn: boolean;
  readonly childSessionKey: string;
  readonly childTurnId: string;
  readonly signal: AbortSignal;
}

export interface PreparedSubagentExecution {
  readonly sessionKey: string;
  readonly turnId: string;
  readonly message: string;
  readonly systemPrompt: string;
  readonly maxLlmCalls?: number;
  readonly signal: AbortSignal;
}

/** Internal executor for an already tracked and resolved Child Turn. */
export class SubagentExecutor {
  constructor(private readonly deps: SubagentExecutorDeps) {}

  async prepare(request: SubagentExecutionRequest): Promise<PreparedSubagentExecution> {
    const childFiles = await this.loadChildContextFiles(request.profile);
    const mergedFiles = mergeContextFilesByName(childFiles, request.parentContextFiles);
    const addendum = buildSubagentBehavioralAddendum({
      taskDescription: request.description,
      depth: request.childDepth,
      canSpawn: request.canSpawn,
    });
    const basePrompt = this.deps.systemPromptBuilder.build({
      mode: 'minimal',
      contextFiles: mergedFiles,
      workspaceDir: this.deps.workspaceDir,
      safetyLevel: this.deps.promptSafetyLevel,
    });

    return {
      sessionKey: request.childSessionKey,
      message: request.prompt,
      systemPrompt: basePrompt ? `${basePrompt}\n\n${addendum}` : addendum,
      turnId: request.childTurnId,
      maxLlmCalls: request.profile.maxLlmCalls,
      signal: request.signal,
    };
  }

  execute(request: PreparedSubagentExecution, resolvedModel: ResolvedModel): Promise<RunResult> {
    return this.deps.agentRunner.run({ ...request, resolvedModel });
  }

  private async loadChildContextFiles(profile: SubagentProfile): Promise<ContextFile[]> {
    if (!existsSync(profile.agentDir)) return [];
    return this.deps.loadContextFilesFromDir(profile.agentDir);
  }
}

export function mergeContextFilesByName(
  childFiles: ReadonlyArray<ContextFile>,
  parentFiles: ReadonlyArray<ContextFile>,
): ContextFile[] {
  const childByName = new Map<string, ContextFile>();
  for (const file of childFiles) childByName.set(file.path, file);
  return parentFiles.map((parent) => childByName.get(parent.path) ?? parent);
}

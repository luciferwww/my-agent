import { existsSync } from 'node:fs';
import type { ResolvedModel } from '../model-resolution/index.js';
import type { ChatToolDefinition } from '../model-invocation/index.js';
import type { AgentRunner, RunResult } from '../runner/index.js';
import type { HookProjection, ToolProjection } from '../registry/index.js';
import type { ApplicationToolPolicy } from '../tools/index.js';
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
  readonly getToolProjection: () => ToolProjection;
  readonly getHookProjection: () => HookProjection;
  readonly resolveToolPolicy: (profile: SubagentProfile) => ApplicationToolPolicy;
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
  readonly profile: SubagentProfile;
  readonly tools: readonly ChatToolDefinition[];
  readonly toolPolicy: ApplicationToolPolicy;
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
    const toolPolicy = this.deps.resolveToolPolicy(request.profile);
    const tools = this.deps.getToolProjection().visibleDefinitions(toolPolicy);
    const basePrompt = this.deps.systemPromptBuilder.build({
      mode: 'minimal',
      contextFiles: mergedFiles,
      toolNames: tools.map(({ name }) => name),
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
      profile: request.profile,
      tools,
      toolPolicy,
    };
  }

  execute(request: PreparedSubagentExecution, resolvedModel: ResolvedModel): Promise<RunResult> {
    const { profile: _profile, tools: _tools, toolPolicy, ...runRequest } = request;
    return this.deps.agentRunner.run({
      ...runRequest,
      resolvedModel,
      toolProjection: this.deps.getToolProjection(),
      hookProjection: this.deps.getHookProjection(),
      toolPolicy,
    });
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

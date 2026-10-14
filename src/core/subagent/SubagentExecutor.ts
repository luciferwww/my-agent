import { existsSync } from 'node:fs';
import type { ResolvedModel } from '../model-resolution/index.js';
import type { ChatToolDefinition } from '../model-invocation/index.js';
import type { AgentRunner, RunResult } from '../runner/index.js';
import type { HookProjection, ToolProjection } from '../registry/index.js';
import type { ApplicationToolPolicy } from '../tools/index.js';
import type { SystemPromptBuilder } from '../prompt/SystemPromptBuilder.js';
import type { ContextFile } from '../agent-context/types.js';
import { buildSubagentBehavioralAddendum } from './behavioral-addendum.js';
import type { SubagentProfile } from './types.js';
import type {
  CurrentCallApprovalCapability,
  SessionPermissionMode,
} from '../approval/index.js';

export interface SubagentExecutorDeps {
  readonly agentRunner: AgentRunner;
  readonly systemPromptBuilder: SystemPromptBuilder;
  readonly loadContextFilesFromDir: (absDir: string) => Promise<ContextFile[]>;
  readonly agentHome: string;
  readonly resolveToolPolicy: (
    profile: SubagentProfile,
    canSpawn: boolean,
  ) => ApplicationToolPolicy;
}

export interface SubagentExecutionRequest {
  readonly requestId: string;
  readonly profile: SubagentProfile;
  readonly description: string;
  readonly prompt: string;
  readonly parentContextFiles: readonly ContextFile[];
  readonly childDepth: number;
  readonly canSpawn: boolean;
  readonly childSessionId: string;
  readonly childTurnId: string;
  readonly maxLlmCallsPerTurn?: number;
  readonly signal: AbortSignal;
  readonly toolProjection: ToolProjection;
  readonly hookProjection: HookProjection;
  readonly approvalCapability: CurrentCallApprovalCapability;
  readonly getSessionPermissionMode: () => SessionPermissionMode;
}

export interface PreparedSubagentExecution {
  readonly requestId: string;
  readonly sessionId: string;
  readonly subagentDepth: number;
  readonly turnId: string;
  readonly message: string;
  readonly systemPrompt: string;
  readonly maxLlmCalls?: number;
  readonly signal: AbortSignal;
  readonly profile: SubagentProfile;
  readonly tools: readonly ChatToolDefinition[];
  readonly toolPolicy: ApplicationToolPolicy;
  readonly toolProjection: ToolProjection;
  readonly hookProjection: HookProjection;
  readonly approvalCapability: CurrentCallApprovalCapability;
  readonly getSessionPermissionMode: () => SessionPermissionMode;
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
    const toolPolicy = this.deps.resolveToolPolicy(request.profile, request.canSpawn);
    const tools = request.toolProjection.visibleDefinitions(toolPolicy);
    const basePrompt = this.deps.systemPromptBuilder.build({
      mode: 'minimal',
      contextFiles: mergedFiles,
      toolNames: tools.map(({ name }) => name),
      agentHome: this.deps.agentHome,
    });

    return {
      requestId: request.requestId,
      sessionId: request.childSessionId,
      subagentDepth: request.childDepth,
      message: request.prompt,
      systemPrompt: basePrompt ? `${basePrompt}\n\n${addendum}` : addendum,
      turnId: request.childTurnId,
      maxLlmCalls: request.maxLlmCallsPerTurn,
      signal: request.signal,
      profile: request.profile,
      tools,
      toolPolicy,
      toolProjection: request.toolProjection,
      hookProjection: request.hookProjection,
      approvalCapability: request.approvalCapability,
      getSessionPermissionMode: request.getSessionPermissionMode,
    };
  }

  execute(request: PreparedSubagentExecution, resolvedModel: ResolvedModel): Promise<RunResult> {
    const {
      sessionId,
      profile: _profile,
      tools: _tools,
      toolPolicy,
      toolProjection,
      hookProjection,
      approvalCapability,
      getSessionPermissionMode,
      ...runRequest
    } = request;
    return this.deps.agentRunner.run({
      ...runRequest,
      sessionId: sessionId,
      resolvedModel,
      toolProjection,
      hookProjection,
      toolPolicy,
      approvalCapability,
      getSessionPermissionMode,
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

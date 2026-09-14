import {
  acquireExtensions,
  readHostExtensionsConfig,
  resolveAgentHome,
} from '../src/extensions/acquisition/index.js';
import type {
  AgentHomeResolutionOptions,
  ExtensionAcquisitionDiagnostic,
  ExtensionAcquisitionOptions,
  ExtensionAcquisitionResult,
  ResolvedHostExtensionsConfig,
} from '../src/extensions/acquisition/index.js';
import type { RuntimeErrorInfo } from '../src/runtime/index.js';

const MAX_OPERATOR_FIELD_LENGTH = 200;

interface HostAcquisitionDependencies {
  resolveAgentHome(options: AgentHomeResolutionOptions): Promise<string>;
  readHostExtensionsConfig(agentHome: string): Promise<ResolvedHostExtensionsConfig>;
  acquireExtensions(options: ExtensionAcquisitionOptions): Promise<ExtensionAcquisitionResult>;
}

export interface WebSocketHostAcquisition {
  readonly agentHome: string;
  readonly result: ExtensionAcquisitionResult;
}

const DEFAULT_DEPENDENCIES: HostAcquisitionDependencies = {
  resolveAgentHome,
  readHostExtensionsConfig,
  acquireExtensions,
};

export async function prepareWebSocketHostAcquisition(
  explicitAgentHome: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: HostAcquisitionDependencies = DEFAULT_DEPENDENCIES,
): Promise<WebSocketHostAcquisition> {
  const agentHome = await dependencies.resolveAgentHome({
    ...(explicitAgentHome === undefined ? {} : { explicitPath: explicitAgentHome }),
    environment,
  });
  const hostConfig = await dependencies.readHostExtensionsConfig(agentHome);
  const result = await dependencies.acquireExtensions({ agentHome, hostConfig, environment });
  return Object.freeze({ agentHome, result });
}

export function parseAgentHomeArgument(args: readonly string[]): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument.startsWith('--agent-home=')) {
      values.push(argument.slice('--agent-home='.length));
      continue;
    }
    if (argument !== '--agent-home') continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('--agent-home requires a path.');
    }
    values.push(value);
    index += 1;
  }
  if (values.length > 1) throw new Error('--agent-home may be provided only once.');
  return values[0];
}

export function formatAcquisitionWarning(
  diagnostic: ExtensionAcquisitionDiagnostic,
): string | undefined {
  if (diagnostic.category === 'disabled') return undefined;
  const fields = [
    `category=${diagnostic.category}`,
    `code=${diagnostic.code}`,
    ...('extensionId' in diagnostic && diagnostic.extensionId !== undefined
      ? [`extensionId=${quoteField(diagnostic.extensionId)}`]
      : []),
    ...(diagnostic.locator === undefined ? [] : [`locator=${boundField(diagnostic.locator)}`]),
    ...('referencePath' in diagnostic && diagnostic.referencePath !== undefined
      ? [`referencePath=${quoteField(diagnostic.referencePath)}`]
      : []),
    ...('environmentVariable' in diagnostic && diagnostic.environmentVariable !== undefined
      ? [`environmentVariable=${quoteField(diagnostic.environmentVariable)}`]
      : []),
  ];
  return `Extension startup warning: ${fields.join(' ')}`;
}

export function formatRuntimeWarning(info: RuntimeErrorInfo): string {
  const fields = [
    `code=${info.code}`,
    ...(info.unitId === undefined ? [] : [`unitId=${quoteField(info.unitId)}`]),
    ...(info.contributionId === undefined
      ? []
      : [`contributionId=${quoteField(info.contributionId)}`]),
    ...(info.phase === undefined ? [] : [`phase=${info.phase}`]),
  ];
  return `Runtime warning: ${fields.join(' ')}`;
}

function quoteField(value: string): string {
  return JSON.stringify(boundField(value));
}

function boundField(value: string): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= MAX_OPERATOR_FIELD_LENGTH) return value;
  return `${codePoints.slice(0, MAX_OPERATOR_FIELD_LENGTH - 3).join('')}...`;
}

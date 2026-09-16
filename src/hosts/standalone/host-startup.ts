import { acquireExtensions } from '../../extension-acquisition/index.js';
import type {
  ExtensionAcquisitionDiagnostic,
  ExtensionAcquisitionOptions,
  ExtensionAcquisitionResult,
  ResolvedHostExtensionsConfig,
} from '../../extension-acquisition/index.js';
import type { RuntimeErrorInfo } from '../../runtime/index.js';

const MAX_OPERATOR_FIELD_LENGTH = 200;

interface HostAcquisitionDependencies {
  acquireExtensions(options: ExtensionAcquisitionOptions): Promise<ExtensionAcquisitionResult>;
}

export interface StandaloneHostAcquisition {
  readonly result: ExtensionAcquisitionResult;
}

const DEFAULT_DEPENDENCIES: HostAcquisitionDependencies = {
  acquireExtensions,
};

export async function prepareStandaloneHostAcquisition(
  extensionsDir: string,
  extensionsConfig: ResolvedHostExtensionsConfig,
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: HostAcquisitionDependencies = DEFAULT_DEPENDENCIES,
): Promise<StandaloneHostAcquisition> {
  const result = await dependencies.acquireExtensions({
    extensionsDir,
    extensionsConfig,
    environment,
  });
  return Object.freeze({ result });
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
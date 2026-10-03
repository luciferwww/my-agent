export interface ToolCapability {
  readonly workspaceRoot: string;
}

export interface ExtensionApi {
  registerTool(tool: { readonly name: string }): void;
}

export function register(api: ExtensionApi, capability: ToolCapability): void {
  api.registerTool({ name: `read:${capability.workspaceRoot}` });
}

export interface SettingsActionRequest {
  readonly requestId: string;
  readonly action: string;
  readonly input: unknown;
}

export type SettingsActionResult =
  | { readonly requestId: string; readonly action: string; readonly ok: true; readonly output: unknown }
  | {
      readonly requestId: string;
      readonly action: string;
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string; readonly fieldPath?: string };
      readonly output?: unknown;
    };

export interface SettingsCapability {
  execute(request: SettingsActionRequest): Promise<SettingsActionResult>;
}

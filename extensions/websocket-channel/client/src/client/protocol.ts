export type ServerMessage = Record<string, unknown> & { readonly type?: unknown };

export type ServerMessageParseResult =
  | { readonly ok: true; readonly message: ServerMessage }
  | { readonly ok: false; readonly reason: 'invalid_json' | 'non_object' };

export function parseServerMessage(raw: unknown): ServerMessageParseResult {
  let value: unknown;
  try {
    value = JSON.parse(String(raw));
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
  ) {
    return { ok: false, reason: 'non_object' };
  }
  return { ok: true, message: value as ServerMessage };
}

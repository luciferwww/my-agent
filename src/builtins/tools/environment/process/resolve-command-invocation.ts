export interface ResolveCommandInvocationOptions {
  command: string;
  cwd: string;
  env: Record<string, string>;
  detached?: boolean;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  comSpec?: string;
  unixShell?: string;
}

export interface ResolvedCommandInvocation {
  file: string;
  args: string[];
  options: {
    cwd: string;
    env: Record<string, string>;
    shell: false;
    detached?: boolean;
    windowsHide?: boolean;
    windowsVerbatimArguments?: boolean;
  };
}

export function resolveCommandInvocation(
  options: ResolveCommandInvocationOptions,
): ResolvedCommandInvocation {
  const platform = options.platform ?? process.platform;

  if (platform === 'win32') {
    return {
      file: options.comSpec || process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', options.command],
      options: {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
      },
    };
  }

  return {
    file: options.unixShell ?? '/bin/sh',
    args: ['-c', options.command],
    options: {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      // Use a dedicated process group on Unix by default so timeout/abort can
      // reliably terminate the whole shell-launched tree, not just the shell.
      detached: options.detached !== false,
    },
  };
}
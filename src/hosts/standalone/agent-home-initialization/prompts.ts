import {
  confirm,
  intro,
  isCancel,
  note,
  outro,
  password,
  select,
  spinner,
  text,
} from '@clack/prompts';

export interface PromptOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
  readonly disabled?: boolean;
}

export interface TextPromptOptions {
  readonly message: string;
  readonly placeholder?: string;
  readonly masked?: boolean;
  readonly validate?: (value: string) => string | undefined;
}

export interface InitializationPrompter {
  intro(message: string): void;
  outro(message: string): void;
  note(message: string, title?: string): void;
  select(message: string, options: readonly PromptOption[], initialValue?: string): Promise<string>;
  confirm(message: string, initialValue?: boolean): Promise<boolean>;
  text(options: TextPromptOptions): Promise<string>;
  progress<T>(message: string, operation: () => Promise<T>): Promise<T>;
}

export class InitializationCancelledError extends Error {
  constructor() {
    super('Initialization cancelled. Agent Home was not changed.');
    this.name = 'InitializationCancelledError';
  }
}

export function createClackInitializationPrompter(): InitializationPrompter {
  const prompter: InitializationPrompter = {
    intro,
    outro,
    note,
    async select(message, options, initialValue) {
      const result = await select({
        message,
        options: options.map((option) => ({ ...option })),
        ...(initialValue === undefined ? {} : { initialValue }),
      });
      return unwrap(result);
    },
    async confirm(message, initialValue) {
      return unwrap(await confirm({
        message,
        ...(initialValue === undefined ? {} : { initialValue }),
      }));
    },
    async text(options) {
      const promptOptions = {
        message: options.message,
        ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
        ...(options.validate === undefined
          ? {}
          : { validate: (value: string | undefined) => options.validate?.(value ?? '') }),
      };
      return options.masked
        ? unwrap(await password(promptOptions))
        : unwrap(await text(promptOptions));
    },
    async progress(message, operation) {
      const indicator = spinner();
      indicator.start(message);
      try {
        const result = await operation();
        indicator.stop(message);
        return result;
      } catch (error) {
        indicator.error(message);
        throw error;
      }
    },
  };
  return Object.freeze(prompter);
}

function unwrap<T>(value: T): Exclude<T, symbol> {
  if (isCancel(value)) throw new InitializationCancelledError();
  return value as Exclude<T, symbol>;
}

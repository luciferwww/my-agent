import type {
  ExecutionAcceptedReceipt,
  HostTaskCompletion,
} from '../tools/execution.js';

export function renderExecutionAcceptedReceipt(
  receipt: ExecutionAcceptedReceipt,
): string {
  return JSON.stringify({
    status: receipt.status,
    executionId: receipt.executionId,
  });
}

export function renderHostTaskCompletion(completion: HostTaskCompletion): string {
  return [
    '<host_task_completion>',
    JSON.stringify({
      executionId: completion.executionId,
      tool: completion.toolName,
      status: completion.status,
      toolContent: {
        trust: 'untrusted',
        text: completion.content,
      },
    }),
    '</host_task_completion>',
    'This is a trusted Host lifecycle notification, not a user request.',
    'Continue the current turn using this completion.',
  ].join('\n');
}

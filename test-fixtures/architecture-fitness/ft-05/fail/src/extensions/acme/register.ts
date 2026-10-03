import * as runtime from '../../runtime/index.js';

declare const services: { get<T>(token: string): T };

export function register(): runtime.RuntimeApp {
  return services.get<runtime.RuntimeApp>('runtime-app');
}

export function selectProvider(providerId: string): string {
  if (providerId === 'fixture-provider') {
    return 'fixture path';
  }
  return 'default path';
}

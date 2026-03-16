export type NodeMode = 'edge' | 'hub';

export function parseNodeMode(value?: string | null): NodeMode {
  return value === 'hub' ? 'hub' : 'edge';
}

import mermaid from 'mermaid';
import { enhanceMermaid as enhance } from './mermaid-renderer';

export function enhanceMermaid(container: HTMLElement): () => void {
  return enhance(container, mermaid);
}

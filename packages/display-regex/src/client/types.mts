import type { DisplayTask, transformDisplayText } from '../../../../src/lib/display-regex.mjs';
export interface Block { kind: string; text?: string; }
export interface AssistantNode { kind: string; data: { blocks: Block[]; status: string; finalNode?: { messageId?: string } }; }
export interface Source { getSnapshot(): AssistantNode | undefined; subscribe(fn: () => void): () => void; }
export interface DisplayContext {
  effect(fn: () => void | (() => void), label?: string): void;
  uiConversation: { binding(id: string): { target(name: string): { getSnapshot(): { nodes: { source(key: string): Source | undefined } } | undefined } | undefined } };
}
export interface Root { render(value: unknown): void; unmount(): void; }
export interface RenderModules {
  React: { createElement(type: unknown, props: unknown): unknown; useLayoutEffect(fn: () => void, deps: unknown[]): void };
  createRoot(el: HTMLElement): Root; MarkdownText: unknown;
}
export interface Configuration extends Omit<DisplayTask, 'texts'> { apiVersion: number; sessionId: string; enabled: boolean; revision: string; depths: Record<string, number>; }
export type DisplayResult = ReturnType<typeof transformDisplayText>;

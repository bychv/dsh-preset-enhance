/**
 * Compaction checkpoint recognition.
 *
 * DSH compaction replaces a range of summarized history with one user-role message whose
 * source carries the marker \`compact-checkpoint\`. That message is not something the user
 * typed, so presets must not treat it as a real user turn: doing so makes lastusermessage,
 * latestUser and userText resolve to a model-written summary, and lets history edits or
 * prompt regex rewrite summary text.
 *
 * The source lives in the host package \`@deepseek-ai/dsh-compaction\` (which exports
 * \`isCompactCheckpointSource\`), but the plugin deliberately imports no host package - it runs
 * under several DSH versions - so the marker is matched structurally on \`source.kind\`. The
 * marker is a field the host stamps on the message, never text guessed from the body, so a
 * preset that merely contains these words is unaffected.
 */
export const COMPACT_CHECKPOINT_KIND = 'compact-checkpoint';

/** Whether a history message is a compaction checkpoint rather than a real user turn. */
export function isCompactionCheckpoint(message: { source?: { kind?: string } } | undefined | null): boolean {
  return message?.source?.kind === COMPACT_CHECKPOINT_KIND;
}

/** Whether a message may be treated as user-authored chat text (not plumbing, not a checkpoint). */
export function isUserAuthored(message: { role?: string; source?: { kind?: string } } | undefined | null): boolean {
  return message?.role === 'user' && message?.source?.kind !== 'tool' && !isCompactionCheckpoint(message);
}

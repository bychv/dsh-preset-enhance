/** Adapt a completed JSON response to the host's streaming interface without another model call. */
export async function bufferedResponseToSse(response: Response, protocol: 'chat-completions' | 'messages'): Promise<Response> {
  if (!response.ok || response.headers.get('content-type')?.includes('text/event-stream')) return response;
  const raw = await response.text();
  let data: any;
  try { data = JSON.parse(raw); } catch { throw new Error('非流式接口返回了无效 JSON'); }
  if (data?.error) throw new Error(typeof data.error.message === 'string' ? data.error.message : JSON.stringify(data.error));
  let frames = '';
  if (protocol === 'chat-completions') {
    const choice = data?.choices?.[0];
    if (!choice?.message || typeof choice.finish_reason !== 'string') throw new Error('非流式 Chat 响应缺少完整消息或结束原因');
    const delta = { ...choice.message, ...(Array.isArray(choice.message.tool_calls) ? {
      tool_calls: choice.message.tool_calls.map((call: any, index: number) => ({ ...call, index })),
    } : {}) };
    const chunk = { ...data, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: choice.finish_reason }] };
    frames = 'data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n';
  } else {
    if (data?.type !== 'message' || !Array.isArray(data.content) || typeof data.stop_reason !== 'string') throw new Error('非流式 Messages 响应缺少完整消息或结束原因');
    const frame = (type: string, value: Record<string, unknown>) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n';
    frames += frame('message_start', { message: { ...data, content: [], stop_reason: null, stop_sequence: null,
      usage: { ...data.usage, output_tokens: 0 } } });
    for (const [index, block] of data.content.entries()) {
      let start = block, deltas: Record<string, unknown>[] = [];
      if (block.type === 'text') { start = { ...block, text: '' }; deltas = [{ type: 'text_delta', text: block.text }]; }
      else if (block.type === 'thinking') {
        start = { ...block, thinking: '', signature: '' };
        deltas = [{ type: 'thinking_delta', thinking: block.thinking }, ...(block.signature ? [{ type: 'signature_delta', signature: block.signature }] : [])];
      } else if (block.type === 'tool_use') {
        start = { ...block, input: {} }; deltas = [{ type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) }];
      }
      frames += frame('content_block_start', { index, content_block: start });
      for (const delta of deltas) frames += frame('content_block_delta', { index, delta });
      frames += frame('content_block_stop', { index });
    }
    frames += frame('message_delta', { delta: { stop_reason: data.stop_reason, stop_sequence: data.stop_sequence ?? null }, usage: data.usage ?? {} });
    frames += frame('message_stop', {});
  }
  const headers = new Headers(response.headers);
  for (const key of ['content-length', 'content-encoding', 'etag', 'content-md5']) headers.delete(key);
  headers.set('content-type', 'text/event-stream; charset=utf-8');
  return new Response(frames, { status: response.status, statusText: response.statusText, headers });
}

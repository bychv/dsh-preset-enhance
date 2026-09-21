#!/usr/bin/env node
/**
 * DSML capture tolerance audit (shared task-17).
 *
 * Runs a fixed corpus through the REAL built lib/toolcall-prefill.mjs transformation path
 * (parseToolCallsFromText for text capture, transformToolCallResponse for the SSE path)
 * and prints a per-variant PASS/FAIL list.
 *
 * Groups: positive (want captured), negative (MUST stay at ZERO calls), unsupported
 * (documented boundary, stays at zero), limitation (known pre-existing false positive, WARN).
 *
 * Usage:
 *   node scripts/dsml-variant-audit.mjs                  # offline corpus
 *   node scripts/dsml-variant-audit.mjs --live           # + real deepseek-flash samples
 *   node scripts/dsml-variant-audit.mjs --live --live-calls=3 --model=deepseek-flash
 * The API key is read at runtime from the sandbox .env and is never printed.
 */
import { readFile } from 'node:fs/promises';
import { buildToolsPrompt, parseToolCallsFromText, transformToolCallResponse } from '../lib/toolcall-prefill.mjs';

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const BS = String.fromCharCode(92);
const BAR = String.fromCharCode(0xFF5C);
const BLK = String.fromCharCode(0x2581);
const ZW = String.fromCharCode(0x200B);
const LQ = String.fromCharCode(0x201C);
const RQ = String.fromCharCode(0x201D);
const FENCE = String.fromCharCode(96).repeat(3);
const P = BAR + BAR + "DSML" + BAR + BAR;
const S = "||DSML||";
const TOOL = "get_weather";
const CITY = String.fromCharCode(0x4E0A, 0x6D77);
const OTHER_CITY = "Beijing";

const open = (prefix, name, attrs) => "<" + prefix + " " + name + (attrs ? " " + attrs : "") + ">";
const close = (prefix, name) => "</" + prefix + " " + name + ">";
const parameter = (prefix, name, flag, value, options = {}) => {
  const tag = open(prefix, "parameter", "name=" + JSON.stringify(name) + " string=" + JSON.stringify(flag) + (options.selfClosing ? "/" : ""));
  if (options.selfClosing) return tag;
  if (options.omitClose) return tag + value;
  return tag + value + close(prefix, "parameter");
};
const dsmlBlock = (prefix, options = {}) => [
  open(prefix, options.wrapper ?? "calls"),
  open(prefix, "invoke", "name=" + JSON.stringify(options.name ?? TOOL)),
  parameter(prefix, "city", "true", options.city ?? CITY),
  close(prefix, "invoke"),
  close(prefix, options.wrapper ?? "calls"),
].join(NL);
const OFFICIAL_BEGIN = BAR + "tool" + BLK + "calls" + BLK + "begin" + BAR;
const OFFICIAL_END = BAR + "tool" + BLK + "calls" + BLK + "end" + BAR;
const officialBlock = inner => ["<" + OFFICIAL_BEGIN + ">", inner, "<" + OFFICIAL_END + ">"].join(NL);
const officialInner = [
  "<" + BAR + "invoke name=" + JSON.stringify(TOOL) + BAR + ">",
  "<" + BAR + "parameter name=" + JSON.stringify("city") + " string=" + JSON.stringify("true") + ">" + CITY + "</" + BAR + "parameter" + BAR + ">",
  "<" + BAR + "/invoke" + BAR + ">",
].join(NL);

const corpus = [
  // --------------------------------------------------------------- positive
  { id: 'p01-own-prompt-fullwidth', group: 'positive', text: dsmlBlock(P), expect: 'calls' },
  { id: 'p02-halfwidth-pipes', group: 'positive', text: dsmlBlock(S), expect: 'calls' },
  { id: 'p03-lowercase-dsml', group: 'positive', text: dsmlBlock(BAR + BAR + 'dsml' + BAR + BAR), expect: 'calls' },
  { id: 'p04-single-quoted-attributes', group: 'positive', text: dsmlBlock(P).split('"').join("'"), expect: 'calls' },
  { id: 'p05-unquoted-attributes', group: 'positive', text: dsmlBlock(P).replace('name="city" string="true"', 'name=city string=true'), expect: 'calls' },
  { id: 'p06-attribute-order-padding-extra', group: 'positive', text: [
      open(P, 'calls'),
      open(P, 'invoke', 'extra="x"  name = "' + TOOL + '"  id="1"'),
      open(P, 'parameter', 'string="true"  name="city"  note="z"') + CITY + close(P, 'parameter'),
      close(P, 'invoke'), close(P, 'calls'),
    ].join(NL), expect: 'calls' },
  { id: 'p07-missing-parameter-close', group: 'positive', text: [
      open(P, 'calls'),
      open(P, 'invoke', 'name="' + TOOL + '"'),
      open(P, 'parameter', 'name="city" string="true"') + CITY,
      close(P, 'invoke'), close(P, 'calls'),
    ].join(NL), expect: 'calls' },
  { id: 'p08-self-closing-parameter', group: 'positive', text: [
      open(P, 'calls'),
      open(P, 'invoke', 'name="' + TOOL + '"'),
      parameter(P, 'city', 'true', '', { selfClosing: true }),
      close(P, 'invoke'), close(P, 'calls'),
    ].join(NL), expect: 'calls', city: '' },
  { id: 'p09-orphan-invoke-with-close', group: 'positive', text: [
      open(P, 'invoke', 'name="' + TOOL + '"'),
      parameter(P, 'city', 'true', CITY),
      close(P, 'invoke'),
    ].join(NL), expect: 'calls' },
  { id: 'p10-escaped-markers', group: 'positive', text: [BS + open(P, 'calls'), BS + open(P, 'invoke', 'name="' + TOOL + '"'), parameter(P, 'city', 'true', CITY), close(P, 'invoke')].join(NL), expect: 'calls' },
  { id: 'p11-crlf-and-blank-lines', group: 'positive', text: dsmlBlock(P).split(NL).join(CR + NL + CR + NL), expect: 'calls' },
  { id: 'p12-markdown-fence-around-dsml', group: 'positive', text: FENCE + NL + dsmlBlock(P) + NL + FENCE, expect: 'calls' },
  { id: 'p13-smart-quote-attributes', group: 'positive', text: dsmlBlock(P).replace(/"([^"]*)"/gu, (_, value) => LQ + value + RQ), expect: 'calls' },
  { id: 'p14-wrapper-toolcalls', group: 'positive', text: dsmlBlock(P, { wrapper: 'toolcalls' }), expect: 'calls' },
  { id: 'p15-wrapper-function_calls', group: 'positive', text: dsmlBlock(P, { wrapper: 'function_calls' }), expect: 'calls' },
  { id: 'p16-wrapper-blockspelled', group: 'positive', text: [open(P, 'tool' + BLK + 'calls'), open(P, 'invoke', 'name="' + TOOL + '"'), parameter(P, 'city', 'true', CITY), close(P, 'invoke'), close(P, 'tool' + BLK + 'calls')].join(NL), expect: 'calls' },
  { id: 'p17-namespace-qualified-name', group: 'positive', text: dsmlBlock(P, { name: 'weather::' + TOOL }), expect: 'calls' },
  { id: 'p18-two-invokes-one-block', group: 'positive', text: [
      open(P, 'calls'),
      open(P, 'invoke', 'name="' + TOOL + '"'), parameter(P, 'city', 'true', CITY), close(P, 'invoke'),
      open(P, 'invoke', 'name="' + TOOL + '"'), parameter(P, 'city', 'true', OTHER_CITY), close(P, 'invoke'),
      close(P, 'calls'),
    ].join(NL), expect: 'calls', calls: 2 },
  { id: 'p19-official-wrapper-dsml-invokes', group: 'positive', text: officialBlock(dsmlBlock(P)), expect: 'calls' },
  { id: 'p20-official-wrapper-bare-pipe-invokes', group: 'positive', text: officialBlock(officialInner), expect: 'calls' },
  { id: 'p21-zero-width-inside-marker', group: 'positive', text: dsmlBlock(BAR + ZW + BAR + 'DSML' + ZW + BAR + BAR).replace(' invoke', ZW + ' invoke'), expect: 'calls' },
  { id: 'p22-block-separator-inside-prefix', group: 'positive', text: dsmlBlock(BAR + BLK + BAR + BLK + 'DSML' + BLK + BAR + BLK + BAR), expect: 'calls' },
  { id: 'p23-streaming-one-char-deltas', group: 'positive', stream: dsmlBlock(P), expect: 'calls' },

  // --------------------------------------------------------------- negative
  { id: 'n01-prose-mentions-invoke-parameter', group: 'negative', text: 'You can invoke the parameter named city by calling the function shown below.', expect: 'none' },
  { id: 'n02-plain-xml-no-dsml-prefix', group: 'negative', text: ['<tool_calls>', '<invoke name="' + TOOL + '">', '<parameter name="city" string="true">' + CITY + '</parameter>', '</invoke>', '</tool_calls>'].join(NL), expect: 'none' },
  { id: 'n03-markdown-fenced-plain-xml', group: 'negative', text: FENCE + 'xml' + NL + '<tool_calls><invoke name="x"><parameter name="y">1</parameter></invoke></tool_calls>' + NL + FENCE, expect: 'none' },
  { id: 'n04-json-code-sample', group: 'negative', text: FENCE + 'json' + NL + '{' + '"tool_calls":[{"function":{"name":"' + TOOL + '","arguments":"{}"}}]}' + NL + FENCE, expect: 'none' },
  { id: 'n05-marker-name-in-prose', group: 'negative', text: 'The marker ' + P + ' calls> starts a calls block and </' + P + ' parameter> closes a parameter.', expect: 'none' },
  { id: 'n06-truncated-invoke-only', group: 'negative', text: open(P, 'invoke', 'name="' + TOOL + '"') + NL + open(P, 'parameter', 'name="city" string="true"') + CITY, expect: 'none' },
  { id: 'n07-invoke-without-name', group: 'negative', text: [open(P, 'calls'), open(P, 'invoke', 'id="1"'), parameter(P, 'city', 'true', CITY), close(P, 'invoke'), close(P, 'calls')].join(NL), expect: 'none' },
  { id: 'n08-parameter-without-invoke', group: 'negative', text: [open(P, 'calls'), parameter(P, 'city', 'true', CITY), close(P, 'calls')].join(NL), expect: 'none' },
  { id: 'n09-wrapper-without-invoke', group: 'negative', text: [open(P, 'calls'), close(P, 'calls')].join(NL), expect: 'none' },
  { id: 'n10-official-end-without-begin', group: 'negative', text: '<' + OFFICIAL_END + '>' + NL + officialInner, expect: 'none' },
  { id: 'n11-official-wrapper-no-invoke', group: 'negative', text: officialBlock('just prose'), expect: 'none' },
  { id: 'n12-bare-pipes-without-official-wrapper', group: 'negative', text: officialInner, expect: 'none' },
  { id: 'n13-html-like-example', group: 'negative', text: 'Use a request like POST /v1/chat/completions with {"messages":[...]} and read choices[0].message.tool_calls.', expect: 'none' },

  // ------------------------------------------------------------ unsupported
  { id: 'u01-fullwidth-angle-brackets', group: 'unsupported', text: dsmlBlock(P).split('<').join(String.fromCharCode(0xFF1C)).split('>').join(String.fromCharCode(0xFF1E)), expect: 'none' },
  { id: 'u02-fullwidth-dsml-letters', group: 'unsupported', text: dsmlBlock(BAR + BAR + String.fromCharCode(0xFF24, 0xFF33, 0xFF2D, 0xFF2C) + BAR + BAR), expect: 'none' },
  { id: 'u03-official-function-json', group: 'unsupported', text: officialBlock('function' + NL + '{"name":"' + TOOL + '","arguments":{"city":"' + CITY + '"}}'), expect: 'none' },
  { id: 'u04-dsml-literal-without-pipes', group: 'unsupported', text: dsmlBlock('DSML'), expect: 'none' },

  // ------------------------------------------------------------- limitation
  { id: 'l01-prompt-format-example-echo', group: 'limitation', text: [open(P, 'calls'), open(P, 'invoke', 'name="tool_name"'), open(P, 'parameter', 'name="param_name" string="true"') + 'string value' + close(P, 'parameter'), close(P, 'invoke'), close(P, 'calls')].join(NL), expect: 'none' },
];

function callsOf(text) {
  const { toolCalls } = parseToolCallsFromText(text);
  return (toolCalls ?? []).map(call => ({
    name: call.function?.name ?? null,
    args: (() => { try { return JSON.parse(call.function?.arguments ?? "null"); } catch { return null; } })(),
  }));
}

async function callsOfStream(text, chunkSize) {
  const encoder = new TextEncoder();
  const chunks = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push("data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: text.slice(index, index + chunkSize) } }] }) + NL + NL);
  }
  chunks.push("data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + NL + NL);
  chunks.push("data: [DONE]" + NL + NL);
  const source = new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); },
  });
  const response = new Response(source, { status: 200, headers: { "content-type": "text/event-stream" } });
  const transformed = await transformToolCallResponse(response, { contentPrefix: "", reasoningPrefix: "" });
  const body = await transformed.text();
  const calls = [];
  for (const line of body.split(NL)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") continue;
    let chunk; try { chunk = JSON.parse(payload); } catch { continue; }
    for (const choice of chunk.choices ?? []) {
      for (const call of choice.delta?.tool_calls ?? []) {
        calls.push({ name: call.function?.name ?? null, args: (() => { try { return JSON.parse(call.function?.arguments ?? "null"); } catch { return null; } })() });
      }
    }
  }
  return calls;
}

const results = [];
for (const row of corpus) {
  let actual = [];
  let error = "";
  try { actual = row.stream ? await callsOfStream(row.stream, 1) : callsOf(row.text); }
  catch (cause) { error = String(cause?.message ?? cause); }
  const wantCalls = row.expect === "calls";
  const expectedCount = row.calls ?? 1;
  let ok;
  if (wantCalls) {
    ok = actual.length >= expectedCount && actual[0]?.name === (row.name ?? TOOL);
    if (ok && actual[0]?.args && typeof actual[0].args === "object") ok = actual[0].args.city === (row.city ?? CITY);
  } else {
    ok = actual.length === 0;
  }
  results.push({ row, actual, ok, error });
}

const groups = ["positive", "negative", "unsupported", "limitation"];
const labels = {
  positive: "POSITIVE (want captured)",
  negative: "NEGATIVE (must stay ZERO calls)",
  unsupported: "UNSUPPORTED (expected zero; documented boundary)",
  limitation: "KNOWN LIMITATION (WARN only)",
};
let failures = 0;
let warns = 0;
for (const group of groups) {
  const rows = results.filter(entry => entry.row.group === group);
  if (rows.length === 0) continue;
  console.log(NL + "== " + labels[group] + " ==");
  for (const entry of rows) {
    const status = entry.row.group === "limitation" ? "WARN" : entry.ok ? "PASS" : "FAIL";
    if (status === "FAIL") failures += 1;
    if (status === "WARN") warns += 1;
    const detail = entry.error ? "error " + entry.error : JSON.stringify(entry.actual.map(call => call.name));
    console.log("  " + status.padEnd(4) + "  " + entry.row.id.padEnd(38) + " expect=" + (entry.row.expect === "calls" ? entry.row.calls ?? 1 : 0) + " actual=" + entry.actual.length + "  " + detail);
  }
}

const count = group => results.filter(entry => entry.row.group === group);
const zeroOk = group => count(group).filter(entry => entry.ok).length;
console.log(NL + "== summary ==");
console.log("  positives captured: " + count("positive").filter(entry => entry.ok).length + "/" + count("positive").length);
console.log("  negatives with ZERO tool calls: " + zeroOk("negative") + "/" + count("negative").length);
console.log("  unsupported kept at zero: " + zeroOk("unsupported") + "/" + count("unsupported").length);
console.log("  limitations (WARN): " + count("limitation").filter(entry => !entry.ok).length);
console.log("  failures: " + failures);

if (process.argv.includes("--live")) await live();

async function live() {
  const ENV_PATH = process.env.SANDBOX_ENV ?? "F:" + BS + "Git" + BS + "dsh-compact-sandbox" + BS + ".sandboxes" + BS + "alpha" + BS + "home" + BS + ".env";
  const envText = await readFile(ENV_PATH, "utf8");
  const line = envText.split(NL).find(entry => entry.trim().startsWith("DEEPSEEK_API_KEY"));
  if (!line) throw new Error("DEEPSEEK_API_KEY missing");
  const key = line.slice(line.indexOf("=") + 1).trim().split(String.fromCharCode(34)).join("").split(String.fromCharCode(39)).join("");
  const calls = Number((process.argv.find(item => item.startsWith("--live-calls=")) ?? "--live-calls=2").split("=")[1]);
  const model = (process.argv.find(item => item.startsWith("--model=")) ?? "--model=deepseek-flash").split("=")[1];
  const tools = [{ type: "function", function: { name: TOOL, description: "Query current weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }];
  console.log(NL + "== real model sampling (" + calls + " call(s), " + model + ", plugin DSML prompt) ==");
  let promptTokens = 0;
  let completionTokens = 0;
  for (let index = 0; index < calls; index += 1) {
    const body = {
      model,
      messages: [
        { role: "system", content: buildToolsPrompt(tools) },
        { role: "user", content: index === 0 ? "What is the current weather in Shanghai? You must call the tool." : "Check the weather in Beijing for me. Use the tool." },
        { role: "assistant", content: "" },
      ],
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: "disabled" },
      max_tokens: 256,
    };
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    let content = "";
    let reasoning = "";
    for (const rawLine of raw.split(NL)) {
      if (!rawLine.startsWith("data:")) continue;
      const payload = rawLine.slice(5).trim();
      if (payload === "[DONE]") continue;
      let chunk; try { chunk = JSON.parse(payload); } catch { continue; }
      if (chunk.usage) { promptTokens += chunk.usage.prompt_tokens ?? 0; completionTokens += chunk.usage.completion_tokens ?? 0; }
      for (const choice of chunk.choices ?? []) {
        if (typeof choice.delta?.content === "string") content += choice.delta.content;
        if (typeof choice.delta?.reasoning_content === "string") reasoning += choice.delta.reasoning_content;
      }
    }
    const parsed = callsOf(content);
    const markers = {
      dsmlLiteral: content.includes("DSML"),
      officialBegin: content.includes("tool" + BLK + "calls" + BLK + "begin"),
      plainToolCalls: content.includes("<tool_calls>"),
      hasInvoke: content.includes("invoke"),
      fenced: content.includes(FENCE),
    };
    console.log("  sample " + (index + 1) + ": status " + response.status + ", content " + content.length + " chars, reasoning " + reasoning.length + " chars, markers " + JSON.stringify(markers) + ", captured=" + parsed.length + (parsed.length ? " -> " + JSON.stringify(parsed) : ""));
    if (!parsed.length) console.log("    raw content: " + JSON.stringify(content.slice(0, 500)));
  }
  console.log("  tokens: prompt=" + promptTokens + " completion=" + completionTokens + " total=" + (promptTokens + completionTokens) + " over " + calls + " call(s)");
}

process.exitCode = failures === 0 ? 0 : 1;
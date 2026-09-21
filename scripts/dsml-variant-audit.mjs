#!/usr/bin/env node
/**
 * DSML capture tolerance audit (shared tasks task-17 / task-18).
 *
 * Runs a fixed corpus through the REAL built lib/toolcall-prefill.mjs transformation path
 * (parseToolCallsFromText for text capture, transformToolCallResponse for the SSE path).
 *
 * EVERY case asserts the recovered VALUE, not just call names or counts:
 *   positive    - exactly `calls` calls, each with the declared `args`
 *   negative    - ZERO calls AND the visible content left untouched
 *   unsupported - documented boundary, expected to stay at zero
 *   limitation  - known pre-existing false positive, reported as WARN
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

const attr = (name, value) => name + "=" + JSON.stringify(value);
const open = (prefix, name, attrs) => "<" + prefix + " " + name + (attrs ? " " + attrs : "") + ">";
const close = (prefix, name) => "</" + prefix + " " + name + ">";
const parameter = (prefix, name, flag, value) => open(prefix, "parameter", attr("name", name) + " " + attr("string", flag)) + value + close(prefix, "parameter");
const selfClosing = (prefix, suffix) => "<" + prefix + " parameter " + attr("name", "city") + " " + attr("string", "true") + suffix + "/>";
const dsmlBlock = (prefix, options = {}) => [
  open(prefix, options.wrapper ?? "calls"),
  open(prefix, "invoke", attr("name", options.name ?? TOOL)),
  parameter(prefix, "city", "true", options.city ?? CITY),
  close(prefix, "invoke"),
  close(prefix, options.wrapper ?? "calls"),
].join(NL);
const OFFICIAL_BEGIN = BAR + "tool" + BLK + "calls" + BLK + "begin" + BAR;
const OFFICIAL_END = BAR + "tool" + BLK + "calls" + BLK + "end" + BAR;
const officialBlock = inner => ["<" + OFFICIAL_BEGIN + ">", inner, "<" + OFFICIAL_END + ">"].join(NL);
const officialInner = [
  "<" + BAR + "invoke " + attr("name", TOOL) + BAR + ">",
  "<" + BAR + "parameter " + attr("name", "city") + " " + attr("string", "true") + ">" + CITY + "</" + BAR + "parameter" + BAR + ">",
  "<" + BAR + "/invoke" + BAR + ">"
].join(NL);

// One-line dialects: the same markers with no newline anywhere (the axis the user asked about).
const gapFor = options => options.spaced ? " " : "";
const oneLineDsml = (prefix, options = {}) => {
  const parts = [open(prefix, "calls"), open(prefix, "invoke", attr("name", TOOL))];
  parts.push(options.selfClosing ? selfClosing(prefix, "") : parameter(prefix, "city", "true", options.city ?? CITY));
  parts.push(close(prefix, "invoke"), close(prefix, "calls"));
  return parts.join(gapFor(options));
};
const oneLineOfficial = (options = {}) => {
  const pipe = options.trailing === false ? "" : BAR;
  const parts = ["<" + OFFICIAL_BEGIN + ">", "<" + BAR + "invoke " + attr("name", TOOL) + " " + pipe + ">"];
  parts.push(options.selfClosing
    ? "<" + BAR + "parameter " + attr("name", "city") + " " + attr("string", "true") + pipe + "/>"
    : "<" + BAR + "parameter " + attr("name", "city") + " " + attr("string", "true") + ">" + (options.city ?? CITY) + "</" + BAR + "parameter" + pipe + ">");
  parts.push("<" + BAR + "/invoke" + pipe + ">", "<" + OFFICIAL_END + ">");
  return parts.join(gapFor(options));
};
const CITY_ARGS = { city: CITY };
const EMPTY_CITY_ARGS = { city: "" };

const corpus = [
  { id: "p01-own-prompt-fullwidth", group: "positive", text: dsmlBlock(P), args: {"city": CITY} },
  { id: "p02-halfwidth-pipes", group: "positive", text: dsmlBlock(S), args: {"city": CITY} },
  { id: "p03-lowercase-dsml", group: "positive", text: dsmlBlock(BAR + BAR + "dsml" + BAR + BAR), args: {"city": CITY} },
  { id: "p04-single-quoted-attributes", group: "positive", text: dsmlBlock(P).split(String.fromCharCode(34)).join(String.fromCharCode(39)), args: {"city": CITY} },
  { id: "p05-unquoted-attributes", group: "positive", text: dsmlBlock(P).replace(attr("name", "city") + " " + attr("string", "true"), "name=city string=true"), args: {"city": CITY} },
  { id: "p06-attribute-order-padding-extra", group: "positive", text: [
      open(P, "calls"),
      open(P, "invoke", "extra=" + JSON.stringify("x") + "  name = " + JSON.stringify(TOOL) + "  id=" + JSON.stringify("1")),
      open(P, "parameter", attr("string", "true") + "  " + attr("name", "city") + "  " + attr("note", "z")) + CITY + close(P, "parameter"),
      close(P, "invoke"), close(P, "calls"),
    ].join(NL), args: { city: CITY } },
  { id: "p07-missing-parameter-close", group: "positive", text: [
      open(P, "calls"), open(P, "invoke", attr("name", TOOL)),
      open(P, "parameter", attr("name", "city") + " " + attr("string", "true")) + CITY,
      close(P, "invoke"), close(P, "calls"),
    ].join(NL), args: { city: CITY } },
  { id: "p08-self-closing-parameter", group: "positive", text: [
      open(P, "calls"), open(P, "invoke", attr("name", TOOL)), selfClosing(P, ""), close(P, "invoke"), close(P, "calls"),
    ].join(NL), args: EMPTY_CITY_ARGS },
  { id: "p09-orphan-invoke-with-close", group: "positive", text: [
      open(P, "invoke", attr("name", TOOL)), parameter(P, "city", "true", CITY), close(P, "invoke"),
    ].join(NL), args: { city: CITY } },
  { id: "p10-escaped-markers", group: "positive", text: [BS + open(P, "calls"), BS + open(P, "invoke", attr("name", TOOL)), parameter(P, "city", "true", CITY), close(P, "invoke")].join(NL), args: { city: CITY } },
  { id: "p11-crlf-and-blank-lines", group: "positive", text: dsmlBlock(P).split(NL).join(CR + NL + CR + NL), args: { city: CITY } },
  { id: "p12-markdown-fence-around-dsml", group: "positive", text: FENCE + NL + dsmlBlock(P) + NL + FENCE, args: { city: CITY } },
  { id: "p13-smart-quote-attributes", group: "positive", text: dsmlBlock(P).replace(/"([^"]*)"/gu, (_, value) => LQ + value + RQ), args: { city: CITY } },
  { id: "p14-wrapper-toolcalls", group: "positive", text: dsmlBlock(P, { wrapper: "toolcalls" }), args: { city: CITY } },
  { id: "p15-wrapper-function_calls", group: "positive", text: dsmlBlock(P, { wrapper: "function_calls" }), args: { city: CITY } },
  { id: "p16-wrapper-blockspelled", group: "positive", text: [open(P, "tool" + BLK + "calls"), open(P, "invoke", attr("name", TOOL)), parameter(P, "city", "true", CITY), close(P, "invoke"), close(P, "tool" + BLK + "calls")].join(NL), args: { city: CITY } },
  { id: "p17-namespace-qualified-name", group: "positive", text: dsmlBlock(P, { name: "weather::" + TOOL }), namespace: "weather", args: { city: CITY } },
  { id: "p18-two-invokes-one-block", group: "positive", calls: 2, args: [{ city: CITY }, { city: OTHER_CITY }], text: [
      open(P, "calls"),
      open(P, "invoke", attr("name", TOOL)), parameter(P, "city", "true", CITY), close(P, "invoke"),
      open(P, "invoke", attr("name", TOOL)), parameter(P, "city", "true", OTHER_CITY), close(P, "invoke"),
      close(P, "calls"),
    ].join(NL) },
  { id: "p19-official-wrapper-dsml-invokes", group: "positive", text: officialBlock(dsmlBlock(P)), args: { city: CITY } },
  { id: "p20-official-wrapper-bare-pipe-invokes", group: "positive", text: officialBlock(officialInner), args: { city: CITY } },
  { id: "p21-zero-width-inside-marker", group: "positive", text: dsmlBlock(BAR + ZW + BAR + "DSML" + ZW + BAR + BAR).replace(" invoke", ZW + " invoke"), args: { city: CITY } },
  { id: "p22-block-separator-inside-prefix", group: "positive", text: dsmlBlock(BAR + BLK + BAR + BLK + "DSML" + BLK + BAR + BLK + BAR), args: { city: CITY } },
  { id: "p23-streaming-one-char-deltas", group: "positive", stream: dsmlBlock(P), args: { city: CITY } },

  // ------------------------------------------- positive: compact / no-newline group
  { id: "c01-one-line-glued", group: "positive", text: oneLineDsml(P), args: { city: CITY } },
  { id: "c02-one-line-spaced", group: "positive", text: oneLineDsml(S, { spaced: true }), args: { city: CITY } },
  { id: "c03-two-invokes-one-line", group: "positive", calls: 2, args: [{ city: CITY }, { city: OTHER_CITY }], text:
      open(P, "calls")
      + open(P, "invoke", attr("name", TOOL)) + parameter(P, "city", "true", CITY) + close(P, "invoke")
      + open(P, "invoke", attr("name", TOOL)) + parameter(P, "city", "true", OTHER_CITY) + close(P, "invoke")
      + close(P, "calls") },
  { id: "c04-one-line-self-closing", group: "positive", text: oneLineDsml(P, { selfClosing: true }), args: EMPTY_CITY_ARGS },
  { id: "c05-official-one-line-trailing-pipe", group: "positive", text: oneLineOfficial(), args: { city: CITY } },
  { id: "c06-official-one-line-no-trailing-pipe", group: "positive", text: oneLineOfficial({ trailing: false }), args: { city: CITY } },
  { id: "c07-official-one-line-spaced", group: "positive", text: oneLineOfficial({ spaced: true }), args: { city: CITY } },
  { id: "c08-official-one-line-self-closing-pipe", group: "positive", text: oneLineOfficial({ selfClosing: true }), args: EMPTY_CITY_ARGS },
  { id: "c09-official-one-line-self-closing-none", group: "positive", text: oneLineOfficial({ selfClosing: true, trailing: false }), args: EMPTY_CITY_ARGS },
  { id: "c10-self-closing-then-next-same-line", group: "positive", text:
      open(P, "calls") + open(P, "invoke", attr("name", TOOL)) + selfClosing(P, "") + parameter(P, "days", "false", "2") + close(P, "invoke") + close(P, "calls"),
      args: { city: "", days: 2 } },
  { id: "c11-self-closing-then-next-newline", group: "positive", text:
      [open(P, "calls"), open(P, "invoke", attr("name", TOOL)), selfClosing(P, ""), parameter(P, "days", "false", "2"), close(P, "invoke"), close(P, "calls")].join(NL),
      args: { city: "", days: 2 } },
  { id: "c12-self-closing-string-false", group: "positive", text: [
      open(P, "calls"), open(P, "invoke", attr("name", TOOL)),
      open(P, "parameter", attr("name", "limit") + " " + attr("string", "false")).slice(0, -1) + "/>",
      close(P, "invoke"), close(P, "calls"),
    ].join(NL), args: { limit: "" } },
  { id: "c13-one-line-missing-parameter-close", group: "positive", text:
      open(P, "calls") + open(P, "invoke", attr("name", TOOL))
      + open(P, "parameter", attr("name", "city") + " " + attr("string", "true")) + CITY
      + close(P, "invoke") + close(P, "calls"),
      args: { city: CITY } },
  { id: "c14-streaming-one-line-self-closing", group: "positive", stream: oneLineDsml(P, { selfClosing: true }), args: EMPTY_CITY_ARGS },
  { id: "c15-closed-value-keeps-padding", group: "positive", text: [
      open(P, "calls"), open(P, "invoke", attr("name", TOOL)),
      open(P, "parameter", attr("name", "city") + " " + attr("string", "true")) + " " + CITY + " " + close(P, "parameter"),
      close(P, "invoke"), close(P, "calls"),
    ].join(NL), args: { city: " " + CITY + " " } },
];

// ---------------------------------------------------------------- negatives
const negatives = [
  { id: "n01-prose-mentions-invoke-parameter", group: "negative", text: "You can invoke the parameter named city by calling the function shown below." },
  { id: "n02-plain-xml-no-dsml-prefix", group: "negative", text: ["<tool_calls>", "<invoke " + attr("name", TOOL) + ">", "<parameter " + attr("name", "city") + " " + attr("string", "true") + ">" + CITY + "</parameter>", "</invoke>", "</tool_calls>"].join(NL) },
  { id: "n03-markdown-fenced-plain-xml", group: "negative", text: FENCE + "xml" + NL + "<tool_calls><invoke name=" + JSON.stringify("x") + "><parameter name=" + JSON.stringify("y") + ">1</parameter></invoke></tool_calls>" + NL + FENCE },
  { id: "n04-json-code-sample", group: "negative", text: FENCE + "json" + NL + JSON.stringify({ tool_calls: [{ function: { name: TOOL, arguments: "{}" } }] }) + NL + FENCE },
  { id: "n05-marker-name-in-prose", group: "negative", text: "The marker " + P + " calls> starts a calls block and </" + P + " parameter> closes a parameter." },
  { id: "n06-truncated-invoke-only", group: "negative", text: open(P, "invoke", attr("name", TOOL)) + NL + open(P, "parameter", attr("name", "city") + " " + attr("string", "true")) + CITY },
  { id: "n07-invoke-without-name", group: "negative", text: [open(P, "calls"), open(P, "invoke", attr("id", "1")), parameter(P, "city", "true", CITY), close(P, "invoke"), close(P, "calls")].join(NL) },
  { id: "n08-parameter-without-invoke", group: "negative", text: [open(P, "calls"), parameter(P, "city", "true", CITY), close(P, "calls")].join(NL) },
  { id: "n09-wrapper-without-invoke", group: "negative", text: [open(P, "calls"), close(P, "calls")].join(NL) },
  { id: "n10-official-end-without-begin", group: "negative", text: "<" + OFFICIAL_END + ">" + NL + officialInner },
  { id: "n11-official-wrapper-no-invoke", group: "negative", text: officialBlock("just prose") },
  { id: "n12-bare-pipes-without-official-wrapper", group: "negative", text: officialInner },
  { id: "n13-html-like-example", group: "negative", text: "Use a request like POST /v1/chat/completions with messages and read choices[0].message.tool_calls." },
  { id: "n14-one-line-prose-mentioning-markers", group: "negative", text: "call invoke parameter calls tool_calls parameter all on one line" },
];

const unsupported = [
  { id: "u01-fullwidth-angle-brackets", group: "unsupported", text: dsmlBlock(P).split("<").join(String.fromCharCode(0xFF1C)).split(">").join(String.fromCharCode(0xFF1E)) },
  { id: "u02-fullwidth-dsml-letters", group: "unsupported", text: dsmlBlock(BAR + BAR + String.fromCharCode(0xFF24, 0xFF33, 0xFF2D, 0xFF2C) + BAR + BAR) },
  { id: "u03-official-function-json", group: "unsupported", text: officialBlock("function" + NL + JSON.stringify({ name: TOOL, arguments: { city: CITY } })) },
  { id: "u04-dsml-literal-without-pipes", group: "unsupported", text: dsmlBlock("DSML") },
];

const limitations = [
  { id: "l01-prompt-format-example-echo", group: "limitation", text: [open(P, "calls"), open(P, "invoke", attr("name", "tool_name")), open(P, "parameter", attr("name", "param_name") + " " + attr("string", "true")) + "string value" + close(P, "parameter"), close(P, "invoke"), close(P, "calls")].join(NL) },
];

const cases = corpus.concat(negatives, unsupported, limitations);

function callsOf(text) {
  const result = parseToolCallsFromText(text);
  return {
    content: result.content,
    calls: (result.toolCalls ?? []).map(call => ({
      name: call.function?.name ?? null,
      namespace: call.namespace ?? null,
      args: (() => { try { return JSON.parse(call.function?.arguments ?? "null"); } catch { return null; } })(),
    })),
  };
}

async function callsOfStream(text, chunkSize) {
  const encoder = new TextEncoder();
  const chunks = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push("data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: text.slice(index, index + chunkSize) } }] }) + NL + NL);
  }
  chunks.push("data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + NL + NL, "data: [DONE]" + NL + NL);
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
        calls.push({ name: call.function?.name ?? null, namespace: call.namespace ?? null, args: (() => { try { return JSON.parse(call.function?.arguments ?? "null"); } catch { return null; } })() });
      }
    }
  }
  return { content: null, calls };
}

function sameArgs(actual, expected) {
  if (actual == null || expected == null) return actual === expected;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (actualKeys.length !== expectedKeys.length) return false;
  if (actualKeys.some((key, index) => key !== expectedKeys[index])) return false;
  return actualKeys.every(key => actual[key] === expected[key]);
}

const results = [];
for (const row of cases) {
  let outcome = { content: null, calls: [] };
  let error = "";
  try { outcome = row.stream ? await callsOfStream(row.stream, 1) : callsOf(row.text); }
  catch (cause) { error = String(cause?.message ?? cause); }
  const calls = outcome.calls;
  let ok = true;
  let detail = "";
  if (row.group === "positive") {
    const expectedCount = row.calls ?? 1;
    if (calls.length !== expectedCount) { ok = false; detail = "count " + calls.length + " != " + expectedCount; }
    for (let index = 0; ok && index < expectedCount; index += 1) {
      const wantArgs = Array.isArray(row.args) ? row.args[index] : row.args;
      const wantName = row.name ?? TOOL;
      if (calls[index].name !== wantName) { ok = false; detail = "name " + calls[index].name + " != " + wantName; break; }
      if (row.namespace !== undefined && calls[index].namespace !== row.namespace) { ok = false; detail = "namespace " + calls[index].namespace; break; }
      if (!sameArgs(calls[index].args, wantArgs)) { ok = false; detail = "args " + JSON.stringify(calls[index].args) + " != " + JSON.stringify(wantArgs); break; }
    }
  } else {
    if (calls.length !== 0) { ok = false; detail = "invented " + JSON.stringify(calls.map(call => call.name)); }
    else if (outcome.content !== null && outcome.content !== row.text) { ok = false; detail = "content was consumed"; }
  }
  results.push({ row, calls, ok, error, detail });
}

const groups = ["positive", "negative", "unsupported", "limitation"];
const labels = {
  positive: "POSITIVE (captured with the declared value)",
  negative: "NEGATIVE (ZERO calls, content untouched)",
  unsupported: "UNSUPPORTED (kept at zero; documented boundary)",
  limitation: "KNOWN LIMITATION (WARN only)",
};
let failures = 0;
for (const group of groups) {
  const rows = results.filter(entry => entry.row.group === group);
  if (rows.length === 0) continue;
  console.log(NL + "== " + labels[group] + " ==");
  for (const entry of rows) {
    let status = entry.ok ? "PASS" : "FAIL";
    if (entry.row.group === "limitation") status = entry.ok ? "PASS" : "WARN";
    if (status === "FAIL") failures += 1;
    const expected = entry.row.group === "positive"
      ? "expect=" + (entry.row.calls ?? 1) + " " + JSON.stringify(entry.row.args)
      : "expect=0";
    const actual = entry.error ? "error " + entry.error : JSON.stringify(entry.calls.map(call => call.args));
    const suffix = entry.detail ? "  [" + entry.detail + "]" : "";
    console.log("  " + status.padEnd(4) + "  " + entry.row.id.padEnd(40) + expected + "  actual=" + entry.calls.length + " " + actual + suffix);
  }
}

const byGroup = group => results.filter(entry => entry.row.group === group);
const passing = group => byGroup(group).filter(entry => entry.ok).length;
console.log(NL + "== summary ==");
console.log("  positives with the declared value: " + passing("positive") + "/" + byGroup("positive").length);
console.log("  negatives at ZERO calls with content untouched: " + passing("negative") + "/" + byGroup("negative").length);
console.log("  unsupported kept at zero: " + passing("unsupported") + "/" + byGroup("unsupported").length);
console.log("  limitations (WARN): " + byGroup("limitation").filter(entry => !entry.ok).length);
console.log("  failures: " + failures);

if (process.argv.includes("--live")) await live();

async function live() {
  const ENV_PATH = process.env.SANDBOX_ENV ?? "F:" + String.fromCharCode(92) + "Git" + String.fromCharCode(92) + "dsh-compact-sandbox" + String.fromCharCode(92) + ".sandboxes" + String.fromCharCode(92) + "alpha" + String.fromCharCode(92) + "home" + String.fromCharCode(92) + ".env";
  const envText = await readFile(ENV_PATH, "utf8");
  const keyLine = envText.split(NL).find(entry => entry.trim().startsWith("DEEPSEEK_API_KEY"));
  if (!keyLine) throw new Error("DEEPSEEK_API_KEY missing");
  const key = keyLine.slice(keyLine.indexOf("=") + 1).trim().split(String.fromCharCode(34)).join("").split(String.fromCharCode(39)).join("");
  const callCount = Number((process.argv.find(item => item.startsWith("--live-calls=")) ?? "--live-calls=2").split("=")[1]);
  const model = (process.argv.find(item => item.startsWith("--model=")) ?? "--model=deepseek-flash").split("=")[1];
  const tools = [{ type: "function", function: { name: TOOL, description: "Query current weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }];
  console.log(NL + "== real model sampling (" + callCount + " call(s), " + model + ", plugin DSML prompt) ==");
  let promptTokens = 0;
  let completionTokens = 0;
  for (let index = 0; index < callCount; index += 1) {
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
      fenced: content.includes(FENCE),
      selfClosingTag: content.includes("/>"),
    };
    const captured = parsed.calls.map(call => call.name + " " + JSON.stringify(call.args)).join("; ");
    console.log("  sample " + (index + 1) + ": status " + response.status + ", content " + content.length + " chars, reasoning " + reasoning.length + " chars, markers " + JSON.stringify(markers) + ", captured=" + parsed.calls.length + (captured ? " -> " + captured : ""));
    if (!parsed.calls.length) console.log("    raw content: " + JSON.stringify(content.slice(0, 500)));
  }
  console.log("  tokens: prompt=" + promptTokens + " completion=" + completionTokens + " total=" + (promptTokens + completionTokens) + " over " + callCount + " call(s)");
}

process.exitCode = failures === 0 ? 0 : 1;

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { after, test } from 'node:test';
import { AgentRouterAuthPlugin, _internal } from './index.mjs';

const plugin = await AgentRouterAuthPlugin();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const testDirectory = await mkdtemp(join(tmpdir(), 'agentrouter-test-'));
after(async () => {
  const withinTemp = relative(resolve(tmpdir()), resolve(testDirectory));
  assert.ok(withinTemp && !withinTemp.startsWith('..') && basename(testDirectory).startsWith('agentrouter-test-'));
  await rm(testDirectory, { recursive: true, force: true });
});
const cachePlugin = (directory = join(testDirectory, randomUUID())) => AgentRouterAuthPlugin({
  project: { id: 'magpie' }, directory,
});

const apiMethod = (p) => p.auth.methods.find((m) => m.type === 'api');
const prompt = (p, key) => apiMethod(p).prompts.find((x) => x.key === key);

test('GitHub login requires a system access token before requesting authorization', async () => {
  const method = plugin.auth.methods.find((m) => m.type === 'oauth');
  await assert.rejects(() => method.authorize({ site: 'org', accessToken: '  ' }), /系统访问令牌/);
});

test('GitHub login saves the entered token and never regenerates it', async () => {
  const method = plugin.auth.methods.find((m) => m.type === 'oauth');
  const original = globalThis.fetch;
  const calls = [];
  const responses = [
    json({ success: true, data: 'oauth-state' }),
    json({ data: { github_client_id: 'example', server_address: 'https://agentrouter.org' } }),
    new Response(JSON.stringify({ success: true, data: { id: 123, access_token: 'site-token' } }), {
      headers: { 'Set-Cookie': 'session=example; Path=/; HttpOnly' },
    }),
    json({ success: true, data: { items: [{ status: 1, key: 'sk-example' }] } }),
  ];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, ...init });
    assert.ok(responses.length, `Unexpected request: ${url}`);
    return responses.shift();
  };
  try {
    const authorization = await method.authorize({ site: 'org', accessToken: '  entered-token  ' });
    const result = await authorization.callback('examplecode');
    assert.equal(result.type, 'success');
    assert.equal(result.metadata.accessToken, 'entered-token');
    assert.equal(result.metadata.cookie, 'session=example');
    assert.equal(result.metadata.userId, '123');
    assert.equal(result.key, 'sk-example');
    assert.equal(calls.at(-1).headers.Authorization, 'entered-token');
    assert.ok(calls.every((call) => !call.url.includes('/api/user/token')));
  } finally {
    globalThis.fetch = original;
  }
});

test('A key pasted into the endpoint question is refused there and ignored at request time', async () => {
  // The question is where the key used to go, so a key pasted into it is the
  // mistake this guards: told to the user while they can still fix it, and
  // never used to build a base even when it is already stored.
  const validate = prompt(plugin, 'endpoint').validate;
  assert.equal(validate(''), undefined);
  assert.equal(validate('https://agentrouter.org'), undefined);
  assert.match(validate('sk-example'), /不要在这里填/);

  const { calls } = await readUsage(
    { key: 'sk-example', metadata: { endpoint: 'sk-example' } },
    [json({ total_usage: 0 })],
  );
  assert.equal(calls[0].url, 'https://agentrouter.org/v1/dashboard/billing/usage');
});

test('Billing keeps the original front door while model requests default to ps.air-outer.com', () => {
  // Moving the model endpoint must not move the account's usage read with it:
  // the dashboard route belongs to the original site, and a silent change here
  // would make consumption vanish from the quota report.
  assert.equal(_internal.apiBase({}, {}), 'https://ps.air-outer.com/v1');
  assert.equal(_internal.billingBase({}, {}), 'https://agentrouter.org/v1');
  // An explicit endpoint still wins for both, so a user's own relay is kept.
  const own = { metadata: { endpoint: 'https://relay.example' } };
  assert.equal(_internal.apiBase({}, own), 'https://relay.example/v1');
  assert.equal(_internal.billingBase({}, own), 'https://relay.example/v1');
});

test('The Codex headers are sent unless the provider switch is turned off', async () => {
  // On — and on a host too old to offer the switch — the gateway sees the
  // client it admits. Off, the user's own headers are all that go.
  const withSwitch = (on) => AgentRouterAuthPlugin({ magpie: { option: () => on } });
  try {
    assert.equal(_internal.headersOf({}, {})['User-Agent'], 'codex_cli_rs/0.101.0');

    await withSwitch(false);
    const off = _internal.headersOf({}, {});
    assert.equal(off['User-Agent'], undefined);
    assert.equal(off.Accept, 'application/json');
    assert.equal(
      _internal.headersOf({}, { metadata: { headers: 'User-Agent: mine' } })['User-Agent'],
      'mine',
    );

    await withSwitch(true);
    assert.equal(_internal.headersOf({}, {})['User-Agent'], 'codex_cli_rs/0.101.0');

    // A host from before the switch hands over no reader at all.
    await AgentRouterAuthPlugin();
    assert.equal(_internal.headersOf({}, {})['User-Agent'], 'codex_cli_rs/0.101.0');
  } finally {
    await withSwitch(true);
  }
});

test('A retired model is never advertised back, whichever path lists it', async () => {
  // magpie's cached models.dev entry for this vendor still names models the
  // site has retired. The plugin's own list is what it answers with when the
  // vendor's list cannot be read, so those names cannot come back through it.
  const retired = ['claude-opus-5', 'claude-opus-4-8', 'deepseek-v4-flash', 'glm-5.3'];
  const declared = Object.keys(_internal.declaredModels());
  assert.deepEqual(declared, ['gpt-5.6-sol', 'gpt-6-astra', 'gpt-6.1-sol']);
  for (const id of retired) assert.ok(!declared.includes(id), `${id} must not be declared`);

  // No account yet: the vendor's list cannot be asked, and the row keeps the
  // plugin's list rather than the row's.
  const row = { models: { 'claude-opus-5': { name: 'x' }, 'gpt-6-astra': { name: 'y' } } };
  const listed = await plugin.provider.models(row);
  for (const id of retired) assert.ok(!(id in listed), `${id} must not be listed`);

  // The vendor refuses the list: same answer, not the row's.
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  try {
    const fell = await plugin.provider.models(row, { auth: { key: 'sk-example' } });
    assert.deepEqual(Object.keys(fell), declared);
  } finally {
    globalThis.fetch = original;
  }
});

test('A content-filter refusal is explained, not left looking like a rate limit', async () => {
  // The vendor's filter answers refused text with 400 content-blocked. Waiting
  // or retrying never clears it, so an agent that reads it as a transient
  // gateway failure burns its budget repeating the same text forever.
  const original = globalThis.fetch;
  const blocked = JSON.stringify({
    error: {
      code: 'content-blocked',
      message: 'content-blocked (request id: abc)',
      type: 'agent_router_api_error',
    },
  });
  globalThis.fetch = async () =>
    new Response(blocked, { status: 400, headers: { 'content-type': 'application/json' } });
  try {
    const p = await AgentRouterAuthPlugin();
    const loader = await p.auth.loader(async () => ({ key: 'sk-example' }), {});
    const res = await loader.fetch('https://agentrouter.org/v1/responses', {
      method: 'POST',
      body: '{}',
    });
    const text = await res.text();
    assert.equal(res.status, 400);
    assert.match(text, /content-blocked/);
    assert.match(text, /内容过滤器/);
    assert.match(text, /改写/);

    // magpie decides "may another provider retry this?" by matching quota /
    // rate-limit words in the body (fallback.go's retryable/quotaWords). If
    // the note reads like one of those, a hard refusal is retried on every
    // account and then fails over — surfacing as another provider's 429.
    // So the note must not contain any of them.
    const quotaWords =
      /quota|insufficient|balance|credit|billing|out of budget|budget (exceeded|exhausted)|exceeded|rate.?limit|usage.?limit|limit.?reached|hit your .*limit|too many requests|overloaded|余额|额度|欠费|限流|频率|套餐|用量|上限/i;
    assert.equal(quotaWords.test(text), false, 'the refusal must not read like a quota error');
  } finally {
    globalThis.fetch = original;
  }
});

test('A token-rate-limit 429 says it is a rate cap with a wait, not a spent account', async () => {
  // The vendor answers its per-minute token cap with 429 and no Retry-After,
  // and says nothing about when it lifts. magpie retries it on every account
  // (each retry spending more of the same counted tokens) and then fails over,
  // so the caller can end up seeing another provider's 429. Saying "wait a
  // minute" and sending Retry-After is what a caller can act on.
  const original = globalThis.fetch;
  const capped = JSON.stringify({
    message: 'Your requests to gpt-6.1-sol for gpt-6.1-sol in eastus2 have exceeded token rate limit.',
    type: 'api_error',
  });
  globalThis.fetch = async () =>
    new Response(capped, { status: 429, headers: { 'content-type': 'application/json' } });
  try {
    const p = await AgentRouterAuthPlugin();
    const loader = await p.auth.loader(async () => ({ key: 'sk-example' }), {});
    const res = await loader.fetch('https://agentrouter.org/v1/responses', {
      method: 'POST',
      body: '{}',
    });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '60');
    const text = await res.text();
    assert.match(text, /gpt-6\.1-sol/);
    assert.match(text, /一分钟后重试/);
    // still a rate limit, so magpie keeps treating it as one (failRate)
    assert.match(text, /token rate limit/i);
  } finally {
    globalThis.fetch = original;
  }
});

test('A 429 that is not this cap is passed through untouched', async () => {
  const original = globalThis.fetch;
  const body = JSON.stringify({ error: { code: 'insufficient_quota', message: 'out of quota' } });
  globalThis.fetch = async () =>
    new Response(body, { status: 429, headers: { 'content-type': 'application/json' } });
  try {
    const p = await AgentRouterAuthPlugin();
    const loader = await p.auth.loader(async () => ({ key: 'sk-example' }), {});
    const res = await loader.fetch('https://agentrouter.org/v1/responses', {
      method: 'POST',
      body: '{}',
    });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), null);
    assert.equal(await res.text(), body);
  } finally {
    globalThis.fetch = original;
  }
});

test('Any other refusal is passed through untouched', async () => {
  const original = globalThis.fetch;
  const body = JSON.stringify({ error: { code: 'invalid_api_key', message: 'bad key' } });
  globalThis.fetch = async () =>
    new Response(body, { status: 401, headers: { 'content-type': 'application/json' } });
  try {
    const p = await AgentRouterAuthPlugin();
    const loader = await p.auth.loader(async () => ({ key: 'sk-example' }), {});
    const res = await loader.fetch('https://agentrouter.org/v1/responses', {
      method: 'POST',
      body: '{}',
    });
    assert.equal(res.status, 401);
    assert.equal(await res.text(), body);
  } finally {
    globalThis.fetch = original;
  }
});

async function readUsage(auth, responses, provider = {}, target = undefined) {
  const original = globalThis.fetch;
  const calls = [];
  const unexpected = [];
  const currentPlugin = target ?? await cachePlugin();
  globalThis.fetch = async (url, init) => {
    calls.push({ url, ...init });
    const response = responses.shift();
    if (!response) unexpected.push(url);
    assert.ok(response, `Unexpected request: ${url}`);
    return response;
  };
  try {
    const usage = await currentPlugin.auth.usage(async () => auth, provider);
    assert.deepEqual(unexpected, [], 'The balance recovery must make only its bounded requests');
    assert.equal(responses.length, 0, 'All expected reads were made');
    return { usage, calls };
  } finally {
    globalThis.fetch = original;
  }
}

test('Cookie-only account reads remaining balance and real consumption', async () => {
  const { usage, calls } = await readUsage(
    { metadata: { cookie: 'session=example', userId: '123' } },
    [json({ success: true, data: { quota: 75000000, used_quota: 25000000 } })],
  );
  assert.equal(calls[0].headers.Cookie, 'session=example');
  assert.equal(calls[0].headers['New-Api-User'], '123');
  assert.equal(usage.balance, '$150.00');
  assert.equal(usage.windows[0].amount, 50);
  assert.equal(usage.windows[0].limit, 200);
  assert.equal(usage.windows[0].used, 25);
});

test('WAF-blocked balance falls back to account consumption without inventing remaining quota', async () => {
  const { usage, calls } = await readUsage(
    { key: 'sk-example', metadata: { cookie: 'session=example', userId: '123' } },
    [new Response('<!doctype html><html>captcha</html>'), json({ success: true, data: { quota: 4500000 } })],
  );
  assert.ok(calls[1].url.endsWith('/api/log/self/stat'));
  assert.match(usage.error, /累计消耗 \$9\.00/);
  assert.match(usage.error, /剩余额度未知/);
  assert.equal(usage.balance, undefined);
  assert.deepEqual(usage.windows, []);
});

test('Missing quota fields are not zero balance; key usage is converted from cents', async () => {
  const { usage, calls } = await readUsage(
    { key: 'sk-example', metadata: { accessToken: 'example', userId: '123', endpoint: 'https://relay.example' } },
    [json({ success: true, data: {} }), json({ success: false }), json({ total_usage: 12345.67 })],
  );
  assert.equal(calls[2].url, 'https://relay.example/v1/dashboard/billing/usage');
  assert.equal(calls[2].headers.Authorization, 'Bearer sk-example');
  assert.match(usage.error, /累计消耗 \$123\.46/);
  assert.equal(usage.balance, undefined);
});

test('Key-only account can report zero consumption without claiming zero balance', async () => {
  const { usage, calls } = await readUsage({ key: 'sk-example' }, [json({ total_usage: 0 })]);
  assert.equal(calls.length, 1);
  assert.match(usage.error, /累计消耗 \$0\.00/);
  assert.equal(usage.balance, undefined);
  assert.deepEqual(usage.windows, []);
});

test('Successful login without quota does not crash or invent balance', async () => {
  const { usage } = await readUsage(
    { metadata: { username: 'example', password: 'example' } },
    [json({ success: true, data: { checked_in: true } })],
  );
  assert.match(usage.error, /没有返回额度字段/);
  assert.equal(usage.balance, undefined);
});

test('Password login supplies balance when user read is blocked', async () => {
  const { usage } = await readUsage(
    { metadata: { accessToken: 'example', username: 'example', password: 'example' } },
    [new Response('<html>captcha</html>'), json({ success: true, data: { quota: 0, used_quota: 500000, username: 'example' } })],
  );
  assert.equal(usage.balance, '$0.00');
  assert.equal(usage.plan, 'example');
  assert.equal(usage.windows[0].used, 100);
});

test('Malformed account and billing amounts stay unknown', async () => {
  const { usage } = await readUsage(
    { key: 'sk-example', metadata: { cookie: 'session=example', userId: '123' } },
    [json({ success: true, data: { quota: null, used_quota: 1 } }), json({ data: { quota: null } }), json({ total_usage: -1 })],
  );
  assert.match(usage.error, /没有返回额度字段/);
  assert.equal(usage.balance, undefined);
});

test('A loading zero never replaces the cached balance, including after a host restart', async () => {
  const directory = join(testDirectory, randomUUID());
  const current = await cachePlugin(directory);
  const auth = { key: 'sk-cache-secret', metadata: { accessToken: 'token-cache-secret', userId: '123' } };
  const full = { success: true, data: { id: 123, username: 'example', quota: 75000000, used_quota: 25000000 } };
  const pending = { success: true, data: { id: 123, quota: 0, used_quota: 0 } };
  const first = await readUsage(auth, [json(full)], {}, current);
  assert.equal(first.usage.balance, '$150.00');

  const second = await readUsage(auth, [json(pending), json(pending)], {}, current);
  assert.equal(second.usage.balance, '$150.00');
  assert.equal(second.usage.windows[0].used, 25);
  assert.match(second.usage.windows[0].display, /缓存.*网站余额仍在加载/);
  assert.equal(second.usage.error, undefined);

  const restarted = await cachePlugin(directory);
  const restored = await readUsage(auth, [json(pending), json(pending)], {}, restarted);
  assert.equal(restored.usage.balance, '$150.00');
  assert.equal(restored.usage.windows[0].display, second.usage.windows[0].display);

  const files = await readdir(join(directory, 'agentrouter-balance-cache'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^[a-f0-9]{64}\.json$/);
  const contents = await readFile(join(directory, 'agentrouter-balance-cache', files[0]), 'utf8');
  assert.doesNotMatch(contents, /sk-cache-secret|token-cache-secret|password|cookie/);
  assert.ok(Number.isFinite(Date.parse(JSON.parse(contents).at)));
});

test('A ready response updates the cache and real exhaustion is not hidden', async () => {
  const current = await cachePlugin();
  const auth = { metadata: { accessToken: 'example', userId: '456' } };
  await readUsage(auth, [json({ success: true, data: { id: 456, quota: 5000000, used_quota: 1000000 } })], {}, current);
  const pending = json({ success: true, data: { id: 456, quota: 0, used_quota: 0 } });
  const recovered = await readUsage(auth, [pending, json({ success: true, data: { id: 456, quota: 2500000, used_quota: 3500000 } })], {}, current);
  assert.equal(recovered.usage.balance, '$5.00');
  assert.doesNotMatch(recovered.usage.windows[0].display, /缓存/);

  const exhausted = await readUsage(auth, [json({ success: true, data: { id: 456, quota: 0, used_quota: 6000000 } })], {}, current);
  assert.equal(exhausted.usage.balance, '$0.00');
  assert.equal(exhausted.usage.windows[0].used, 100);
  assert.equal(exhausted.usage.windows[0].remaining, 0);
  const stillZero = await readUsage(auth, [json({ success: false, message: 'temporarily unavailable' })], {}, current);
  assert.equal(stillZero.usage.balance, '$0.00');
  assert.match(stillZero.usage.windows[0].display, /缓存/);
});

test('Login loading values use the new session to read the real balance', async () => {
  const auth = { metadata: { userId: '123', username: 'example', password: 'example' } };
  const login = new Response(JSON.stringify({ success: true, data: { id: 123, quota: 0, used_quota: 0 } }), {
    headers: { 'Set-Cookie': 'session=fresh; Path=/; HttpOnly' },
  });
  const { usage, calls } = await readUsage(auth, [login, json({ success: true, data: { id: 123, quota: 5000000, used_quota: 1000000 } })]);
  assert.equal(usage.balance, '$10.00');
  assert.ok(calls[0].url.endsWith('/api/user/login'));
  assert.ok(calls[1].url.endsWith('/api/user/self'));
  assert.equal(calls[1].headers.Cookie, 'session=fresh');
  assert.equal(calls[1].headers['New-Api-User'], '123');
  assert.equal(auth.cookie, undefined);
});

test('Blocked reads and a still-loading login keep the previous balance', async () => {
  const current = await cachePlugin();
  const auth = { metadata: { accessToken: 'example', userId: '123', username: 'example', password: 'example' } };
  await readUsage(auth, [json({ success: true, data: { id: 123, quota: 5000000, used_quota: 1000000 } })], {}, current);
  const { usage } = await readUsage(auth, [
    new Response('<html>captcha</html>'),
    json({ success: true, data: { id: 123, quota: 0, used_quota: 0 } }),
    new Response('<html>captcha</html>'),
  ], {}, current);
  assert.equal(usage.balance, '$10.00');
  assert.match(usage.windows[0].display, /缓存.*网站余额仍在加载/);
});

test('Uncached loading responses say unknown rather than zero or 100% remaining', async () => {
  const pending = { success: true, data: { id: 123, quota: 0, used_quota: 0 } };
  const { usage } = await readUsage({ metadata: { accessToken: 'example', userId: '123' } }, [json(pending), json(pending), json({ success: false })]);
  assert.equal(usage.balance, undefined);
  assert.deepEqual(usage.windows, []);
  assert.match(usage.error, /余额仍在加载.*尚无本地缓存/);
});

test('Different accounts, corrected IDs and sites never share a cached balance', async () => {
  const current = await cachePlugin();
  const first = { key: 'sk-first', metadata: { accessToken: 'example', userId: '123' } };
  await readUsage(first, [json({ success: true, data: { id: 123, quota: 5000000, used_quota: 1000000 } })], {}, current);
  for (const auth of [
    { key: 'sk-second', metadata: { accessToken: 'example', userId: '123' } },
    { key: 'sk-first', metadata: { accessToken: 'example', userId: '456' } },
    { key: 'sk-first', metadata: { accessToken: 'example', userId: '123', site: 'air' } },
  ]) {
    const { usage } = await readUsage(auth, [json({ success: true, data: {} }), json({ success: false }), json({ total_usage: 0 })], {}, current);
    assert.equal(usage.balance, undefined);
    assert.match(usage.error, /剩余额度未知/);
  }
});

test('A different login account cannot replace the cached account', async () => {
  const current = await cachePlugin();
  const auth = { metadata: { accessToken: 'example', userId: '123', username: 'example', password: 'example' } };
  await readUsage(auth, [json({ success: true, data: { id: 123, username: 'first', quota: 5000000, used_quota: 1000000 } })], {}, current);
  const { usage } = await readUsage(auth, [new Response('<html>captcha</html>'), json({ success: true, data: { id: 456, username: 'other', quota: 75000000, used_quota: 25000000 } })], {}, current);
  assert.equal(usage.balance, '$10.00');
  assert.equal(usage.plan, 'first');
  assert.match(usage.windows[0].display, /缓存.*用户 ID 不一致/);
});

// ---- request body: dropping Azure node-bound state -------------------------
//
// These exercise the pure helpers directly, then once end to end through the
// loader's fetch hook, so a helper that works in isolation but is never wired
// into the request path would still fail.

test('A Responses reasoning item is removed whole', () => {
  // Reasoning items carry encrypted state minted by one backend; another
  // backend rejects the request that contains them. The item is pure
  // bookkeeping, so dropping it whole loses nothing the model needs.
  const body = {
    input: [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'message', role: 'user', content: 'hello' },
    ],
  };
  _internal.stripResponseState(body);
  assert.deepEqual(body.input, [{ type: 'message', role: 'user', content: 'hello' }]);
});

test('A Responses item carrying encrypted_content is removed whole', () => {
  // encrypted_content is the node-bound reasoning payload. The field alone
  // marks the item as bound even when it is not typed as reasoning, so it is
  // not enough to look at `type`.
  const body = {
    input: [
      { type: 'message', role: 'assistant', encrypted_content: 'abc' },
      { type: 'message', role: 'user', content: 'hi' },
    ],
  };
  _internal.stripResponseState(body);
  assert.equal(body.input.length, 1, 'only the plain message should remain');
  assert.equal(body.input[0].content, 'hi');
});

test('A Responses message id is removed while call_id and arguments are kept', () => {
  // A function call is tied to its output by call_id, not by the item id, so
  // removing the id is safe; removing the call fields would break the pairing.
  const body = {
    input: [
      { type: 'function_call', id: 'fc_9', call_id: 'call_9', name: 'f', arguments: '{"x":1}' },
      { type: 'message', id: 'msg_9', role: 'assistant', content: 'ok' },
    ],
  };
  _internal.stripResponseState(body);
  assert.equal(body.input[0].id, undefined, 'the item id must be gone');
  assert.equal(body.input[0].call_id, 'call_9', 'call_id must survive');
  assert.equal(body.input[0].arguments, '{"x":1}', 'arguments must survive');
});

test('previous_response_id is removed from the request body', () => {
  // A stored response id references state on one backend that another cannot
  // resolve. The conversation is replayed anyway, so the id is dropped.
  const body = { previous_response_id: 'resp_1', input: [] };
  _internal.stripRequestState(body);
  assert.equal('previous_response_id' in body, false);
});

test('A reasoning block nested in Responses message content is removed', () => {
  // Reasoning can arrive as a block inside a message instead of a whole item,
  // so the content array is scanned too; surviving blocks lose their id.
  const body = {
    input: [
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'reasoning', id: 'rs_2' },
          { type: 'text', id: 'ctc_2', text: 'answer' },
        ],
      },
    ],
  };
  _internal.stripResponseState(body);
  assert.equal(body.input[0].content.length, 1, 'the reasoning block must be gone');
  assert.deepEqual(body.input[0].content[0], { type: 'text', text: 'answer' });
});

test('A chat message id is removed and a string content is untouched', () => {
  // The plugin sees chat-completions bodies (`body.messages`); their ids are
  // node-bound too, but a string content must never be rewritten.
  const body = { messages: [{ role: 'user', id: 'msg_1', content: 'hello world' }] };
  _internal.stripChatState(body);
  assert.equal(body.messages[0].id, undefined);
  assert.equal(body.messages[0].content, 'hello world');
});

test('A reasoning block in a chat message content array is removed', () => {
  // Clients may put reasoning inline in a chat message; it is node-bound there
  // as well, so the block goes and the visible text stays.
  const body = {
    messages: [
      { role: 'assistant', content: [{ type: 'reasoning', id: 'rs_3' }, { type: 'text', text: 'done' }] },
    ],
  };
  _internal.stripChatState(body);
  assert.equal(body.messages[0].content.length, 1);
  assert.equal(body.messages[0].content[0].text, 'done');
});

test('A failed assistant message is dropped in both request shapes', () => {
  // A turn that errored upstream carries no usable content; replaying it only
  // feeds the model an error it did not produce this time.
  const responses = {
    input: [
      { type: 'message', role: 'assistant', status: 'error', content: 'boom' },
      { type: 'message', role: 'user', content: 'next' },
    ],
  };
  _internal.stripResponseState(responses);
  assert.equal(responses.input.length, 1, 'the failed message must be gone');
  assert.equal(responses.input[0].content, 'next');

  const chat = {
    messages: [
      { role: 'assistant', status: 'error', content: 'boom' },
      { role: 'user', content: 'next' },
    ],
  };
  _internal.stripChatState(chat);
  assert.equal(chat.messages.length, 1, 'the failed chat message must be gone');
  assert.equal(chat.messages[0].content, 'next');
});

test('A tool schema loses $schema and gains an empty required array', () => {
  // The vendor's parser rejects $schema and wants every object schema to
  // declare required, even an empty one; nested property schemas get cleaned.
  const body = {
    tools: [
      {
        type: 'function',
        function: {
          name: 'f',
          parameters: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: { q: { type: 'string' } },
          },
        },
      },
    ],
  };
  _internal.stripRequestState(body);
  const params = body.tools[0].function.parameters;
  assert.equal('$schema' in params, false, '$schema must be gone');
  assert.deepEqual(params.required, [], 'required must be an empty array');
});

test('An items value of null is removed from a tool schema', () => {
  // items: null is not a schema the vendor's parser accepts, so the key is
  // dropped rather than forwarded as null.
  const body = {
    tools: [
      {
        type: 'function',
        function: {
          name: 'f',
          parameters: { type: 'object', properties: { list: { type: 'array', items: null } } },
        },
      },
    ],
  };
  _internal.stripRequestState(body);
  assert.equal('items' in body.tools[0].function.parameters.properties.list, false);
});

test('DeepSeek requests lose thinking while other models keep it', () => {
  // The vendor's DeepSeek path rejects the thinking field; other models use it,
  // so the field is only removed when the model name says DeepSeek.
  const deepseek = { model: 'deepseek-v4-flash', thinking: { type: 'enabled' } };
  _internal.stripRequestState(deepseek);
  assert.equal('thinking' in deepseek, false);

  const other = { model: 'gpt-6-astra', thinking: { type: 'enabled' } };
  _internal.stripRequestState(other);
  assert.deepEqual(other.thinking, { type: 'enabled' }, 'a non-DeepSeek model is untouched');
});

test('A non-JSON body and a body with nothing to strip pass through unchanged', async () => {
  // Stripping must never break a request it cannot parse. A non-JSON body and
  // a JSON body with no node-bound fields are forwarded byte-for-byte.
  const p = await AgentRouterAuthPlugin();
  const loader = await p.auth.loader(async () => ({ key: 'sk-example' }), {});
  const original = globalThis.fetch;
  const received = [];
  globalThis.fetch = async (url, init) => {
    received.push(init.body);
    return json({ ok: true });
  };
  try {
    const raw = 'not json at all';
    const res1 = await loader.fetch('https://agentrouter.org/v1/responses', { method: 'POST', body: raw });
    assert.equal(res1.status, 200);

    const plain = JSON.stringify({ model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hi' }] });
    const res2 = await loader.fetch('https://agentrouter.org/v1/responses', { method: 'POST', body: plain });
    assert.equal(res2.status, 200);

    assert.equal(received[0], raw, 'a non-JSON body must reach fetch byte-for-byte');
    assert.equal(received[1], plain, 'a body with nothing to strip must be unchanged');
  } finally {
    globalThis.fetch = original;
  }
});

test('The loader strips node-bound state from the body the upstream receives', async () => {
  // End to end trap: @ai-sdk/openai sends chat-completions (`body.messages`)
  // with a top-level reasoning_content. If only the Responses shape were
  // handled, the strip would silently do nothing on real traffic.
  const p = await AgentRouterAuthPlugin();
  const loader = await p.auth.loader(async () => ({ key: 'sk-example' }), {});
  const original = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return json({ ok: true });
  };
  try {
    const body = {
      model: 'gpt-6-astra',
      messages: [
        { role: 'assistant', id: 'msg_1', reasoning_content: 'hidden', content: 'answer' },
        { role: 'user', content: 'next' },
      ],
      previous_response_id: 'resp_1',
      tools: [
        {
          type: 'function',
          function: { name: 'f', parameters: { $schema: 'x', type: 'object', properties: { q: { type: 'string' } } } },
        },
      ],
    };
    await loader.fetch('https://agentrouter.org/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal('previous_response_id' in sent, false, 'previous_response_id must be stripped upstream');
    assert.equal(sent.messages[0].id, undefined, 'the message id must be stripped upstream');
    assert.equal('reasoning_content' in sent.messages[0], false, 'reasoning_content must be stripped upstream');
    assert.equal(sent.messages[0].content, 'answer', 'visible content is kept');
    assert.equal('$schema' in sent.tools[0].function.parameters, false, '$schema must be stripped upstream');
    assert.deepEqual(sent.tools[0].function.parameters.required, [], 'required must be filled upstream');
  } finally {
    globalThis.fetch = original;
  }
});

test('A Request-carried body is sanitised without hand-setting Content-Length', async () => {
  // When the SDK hands a Request, the body lives in the request, not init.body.
  // The request is rebuilt from the new bytes so the platform derives framing.
  const p = await AgentRouterAuthPlugin();
  const loader = await p.auth.loader(async () => ({ key: 'sk-example' }), {});
  const original = globalThis.fetch;
  let sent;
  globalThis.fetch = async (input) => {
    sent = JSON.parse(await input.text());
    return json({ ok: true });
  };
  try {
    const req = new Request('https://agentrouter.org/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', id: 'msg_1', content: 'hi' }] }),
    });
    await loader.fetch(req);
    assert.equal(sent.messages[0].id, undefined, 'a Request-carried body must be stripped too');
    assert.equal(sent.messages[0].content, 'hi');
  } finally {
    globalThis.fetch = original;
  }
});

test('A normal 200 response passes through explainRefusal untouched', async () => {
  // Stripping is a request-side change; the reply path must behave exactly as
  // before, so a 200 body reaches the caller unchanged.
  const p = await AgentRouterAuthPlugin();
  const loader = await p.auth.loader(async () => ({ key: 'sk-example' }), {});
  const original = globalThis.fetch;
  const payload = JSON.stringify({ id: 'resp_ok', output: [] });
  globalThis.fetch = async () => new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const res = await loader.fetch('https://agentrouter.org/v1/responses', { method: 'POST', body: '{}' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), payload, 'a 200 body must be passed through unchanged');
  } finally {
    globalThis.fetch = original;
  }
});

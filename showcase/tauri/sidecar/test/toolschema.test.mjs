// Tool schemas every provider accepts. Run: npm test
import assert from 'node:assert/strict';
import { resolveToolSchema } from '@kenkaiiii/gg-ai';
import { createTools, shellFor } from '../tools.mjs';

const noop = async () => {};
const { tools } = createTools({ allowActions: false, ui: () => {}, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test', focus: { start: () => 'ok', stop: () => 'ok' } });
// Focus mode's tools are there where the window in front can be read (focus given), and checked below with the rest.
assert.ok(tools.some((t) => t.name === 'start_focus') && tools.some((t) => t.name === 'stop_focus'), 'focus tools');

// Regression: the old fetch_url's url had format "uri", which OpenAI strict schemas reject, failing every OpenAI request.
const formats = [];
const walk = (name, node, at) => {
  if (Array.isArray(node)) return node.forEach((n, i) => walk(name, n, `${at}/${i}`));
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'format' && typeof v === 'string') formats.push(`${name}${at}: ${v}`); // a property named format is an object
    walk(name, v, `${at}/${k}`);
  }
};
for (const t of tools) walk(t.name, resolveToolSchema(t), '');
assert.deepEqual(formats, [], 'no tool uses a string format');
// draw replaced point_at, on every platform (pixels from a screenshot work everywhere).
assert.ok(tools.some((t) => t.name === 'draw') && !tools.some((t) => t.name === 'point_at'), 'draw, not point_at');
const drawSchema = JSON.stringify(resolveToolSchema(tools.find((t) => t.name === 'draw')));
assert.ok(!/"(oneOf|anyOf|allOf)"/.test(drawSchema), 'draw is one flat object schema (no unions some providers reject)');
// Labels on a photo need a look at the picture first: see_photo is there, and draw refuses labels on an unseen one
// before anything is fetched or drawn, saying which call to make.
{
  assert.ok(tools.some((t) => t.name === 'see_photo'), 'see_photo is a tool');
  const draw = tools.find((t) => t.name === 'draw'), see = tools.find((t) => t.name === 'see_photo');
  const labelled = { beats: [{ say: 'The parts of a guitar.', marks: [{ kind: 'photo', query: 'Acoustic guitar', labels: [{ text: 'neck', x: 0.5, y: 0.3 }] }] }] };
  await assert.rejects(draw.execute(labelled, { toolCallId: 't1' }), /labels go on a picture you have looked at[^\n]*First call see_photo with \{"query":"Acoustic guitar"\}/, 'labels on an unseen picture are refused with what to do');
  await assert.rejects(see.execute({}), /Give query/, 'see_photo needs something to look at');
  await assert.rejects(see.execute({ url: 'http://127.0.0.1:8080/cam.png' }), /Blocked for safety/, 'see_photo goes through the URL rules');
}
// What the model reads is what the schema takes: every new card's fields are there, and the text has real backslashes.
{
  const d = tools.find((t) => t.name === 'draw'), mark = resolveToolSchema(d).properties.beats.items.properties.marks.items.properties;
  for (const f of ['nodes', 'links', 'columns', 'rows', 'bars', 'unit', 'labels', 'region', 'shade', 'pins', 'routes', 'steps', 'vertices', 'lines', 'angles', 'circles', 'questions']) assert.ok(mark[f], `a mark can have ${f}`);
  for (const k of ['flow', 'table', 'bars', 'map', 'math', 'geometry', 'quiz']) assert.ok(mark.kind.enum.includes(k), `${k} is a kind of mark`);
  assert.ok(mark.parts.items.properties.motion, 'a part can move');
  assert.ok(d.description.includes('\\frac{a}{b}, \\sqrt{x}') && d.description.includes('no \\begin, & or \\\\ line breaks'), 'the LaTeX in the description reaches the model with single backslashes');
  assert.ok(d.description.includes('At most 4 cards show at once (one more closes the oldest)'), 'the model knows only a few cards stay up');
  assert.ok(d.description.length < 9000, `the draw description stays a readable size (${d.description.length})`);
}
console.log('tool schema ok');

// act_in_app that only types a web address into a browser's bar becomes a direct open.
{
  const { typedAddress } = await import('../tools.mjs');
  const go = (t) => [{ do: 'type', text: t }, { do: 'key', key: 'return' }];
  assert.equal(typedAddress('Safari', [{ do: 'key', key: 'cmd+l' }, ...go('example.com'), { do: 'wait', seconds: 2 }]), 'example.com');
  assert.equal(typedAddress('Safari', [{ do: 'click_text', text: 'smart search field' }, ...go('example.com')]), 'example.com');
  assert.equal(typedAddress('Google Chrome', [{ do: 'key', key: 'cmd+t' }, ...go('https://bbc.co.uk/news')]), 'https://bbc.co.uk/news');
  assert.equal(typedAddress('browser', [{ do: 'click_text', text: 'New Tab' }, ...go('example.com')]), 'example.com');
  // Not just opening a link: leave it alone.
  assert.equal(typedAddress('TextEdit', [{ do: 'key', key: 'cmd+l' }, ...go('example.com')]), null);
  assert.equal(typedAddress('Safari', [{ do: 'key', key: 'cmd+l' }, ...go('cheap flights to rome')]), null);
  assert.equal(typedAddress('Safari', [{ do: 'click_text', text: 'Search' }, ...go('example.com')]), null);
  assert.equal(typedAddress('Safari', [{ do: 'key', key: 'cmd+l' }, ...go('example.com'), { do: 'click_text', text: 'More information' }]), null);
  assert.equal(typedAddress('Safari', [{ do: 'key', key: 'cmd+l' }, { do: 'type', text: 'example.com' }]), null);
  assert.equal(typedAddress('Safari', [{ do: 'fill', field: 'Email', text: 'a@b.com' }, ...go('example.com')]), null);
  console.log('typed address ok');
}

// Regression: a YouTube search typed into the search box failed and re-ran the old search; the search URL works.
// act_in_app is there on macOS, and elsewhere when the hands helper is (ROAMIES_HANDS).
assert.equal(tools.some((t) => t.name === 'act_in_app'), process.platform === 'darwin' || !!process.env.ROAMIES_HANDS, 'act_in_app follows the helper');
if (process.platform === 'darwin') {
  const actInApp = tools.find((t) => t.name === 'act_in_app').description;
  assert.match(actInApp, /youtube\.com\/results\?search_query=/);
  // ...but when the user asks for the page's own search box, it uses the box.
  assert.match(actInApp, /unless the user asks you to use the box: then fill it/);
}

// Linux: apps are opened by name through their .desktop files.
{
  const { parseDesktopEntry, findDesktopApp } = await import('../tools.mjs');
  const e = parseDesktopEntry('# a comment\n[Desktop Entry]\nType=Application\nName=Files\nName[de]=Dateien\nGenericName=File Manager\nExec=nautilus --new-window %U\n\n[Desktop Action new-window]\nName=New Window\nExec=nautilus --new-window\n');
  assert.equal(e.Name, 'Files', 'the main name, not a translation');
  assert.equal(e.Exec, 'nautilus --new-window %U', 'keys from [Desktop Entry] only, not its actions');
  assert.equal(e.GenericName, 'File Manager');
  const app = (id, entry) => ({ id, file: `/usr/share/applications/${id}.desktop`, entry: { Type: 'Application', Exec: id, ...entry } });
  const apps = [
    app('org.gnome.Nautilus', { Name: 'Files', GenericName: 'File Manager' }),
    app('google-chrome', { Name: 'Google Chrome', GenericName: 'Web Browser' }),
    app('firefox', { Name: 'Firefox Web Browser', GenericName: 'Web Browser' }),
    app('secret-tool-helper', { Name: 'Hidden Helper', NoDisplay: 'true' }),
    app('gone', { Name: 'Gone', Hidden: 'true' }),
    { id: 'a-link', file: '/x/a-link.desktop', entry: { Type: 'Link', Name: 'A Link', URL: 'https://example.com' } },
  ];
  const find = (n) => findDesktopApp(apps, n)?.id ?? null;
  assert.equal(find('Files'), 'org.gnome.Nautilus', 'by the name in the menus');
  assert.equal(find('files'), 'org.gnome.Nautilus', 'any case');
  assert.equal(find('nautilus'), 'org.gnome.Nautilus', 'by the last part of its id');
  assert.equal(find('org.gnome.Nautilus.desktop'), 'org.gnome.Nautilus', 'by its file name');
  assert.equal(find('chrome'), 'google-chrome', 'a word of its name');
  assert.equal(find('firefox'), 'firefox');
  assert.equal(find('Web Browser'), 'google-chrome', 'by its kind when nothing is named that');
  assert.equal(find('Hidden Helper'), null, 'never one hidden from the menus');
  assert.equal(find('Gone'), null);
  assert.equal(find('A Link'), null, 'only apps');
  assert.equal(find('Photoshop'), null);
  assert.equal(find('  '), null);
  console.log('linux app tests: passed');
}

// Regression: a launcher's output is inherited by the app it starts, so waiting for it to close waited for the app.
{
  const { launch } = await import('../tools.mjs');
  const t0 = Date.now();
  const r = await launch(process.execPath, ['-e', "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'inherit', detached: true }).unref()"]);
  assert.equal(r.err, null);
  assert.ok(Date.now() - t0 < 2500, 'done when the launcher exits, not when the app it started does');
  const bad = await launch(process.execPath, ['-e', "process.stderr.write('Unable to find application'); process.exit(2)"]);
  assert.equal(bad.err.code, 2);
  assert.match(bad.stderr, /Unable to find application/);
  assert.equal((await launch('/no/such/launcher', [])).err.code, 'ENOENT');
  console.log('launch tests: passed');
}
// Regression: on Windows a command with quotes in it (node -e "…") reached cmd with Node's \" escapes and broke.
{
  const cmd = `node -e "require('fs').writeFileSync('a b.txt', 'x')"`;
  assert.deepEqual(shellFor(cmd, 'win32'), ['cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { windowsVerbatimArguments: true }], 'cmd gets the command as is');
  assert.deepEqual(shellFor(cmd, 'darwin', {}), ['/bin/zsh', ['-lc', cmd], {}]);
  assert.deepEqual(shellFor(cmd, 'linux', {}), ['/bin/bash', ['-lc', cmd], {}]);
  assert.equal(shellFor('ls', 'linux', { SHELL: '/usr/bin/fish' })[0], '/usr/bin/fish', 'their own shell where set');
  console.log('run_command shell tests: passed');
}

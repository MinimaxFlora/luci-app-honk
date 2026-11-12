'use strict';
'require baseclass';
'require view';
'require form';
'require fs';
'require ui';
'require uci';
'require rpc';
'require request';
'require poll';
'require honk.nativeapi as nativeApi';

/*
 * The honk LuCI page, in three tabs: the
 * service status with its controls and the Start at boot switch, an editor for
 * the configuration file and every file it includes, and the service log. An
 * app extends `View` and only supplies `app`:
 *
 *   name           service, UCI package and init script
 *   other          the service that cannot run at the same time; starting this
 *                  one stops that one first, and turning Start at boot on here
 *                  turns it off there
 *   defaultConfig  entry file when UCI has none
 *   validate       [ command, args ] that take the entry file and exit non-zero
 *                  on a broken configuration, or null
 *   logIdent       RegExp matching the start of the service's log messages
 *   webUi          optional async hook: loaded files to { url?, note? } or null
 *   webUiFlag      optional { read, path, write }: a checkbox for the web UI
 *                  that lives in the configuration files, not in UCI.
 *                  read(files) is the state, path(files) the file to change
 *                  and write(text, on) the new text of that file. Saving
 *                  writes the file and restarts a running service.
 *   storeFlag      optional { dataDir, problems }: a checkbox for the UCI
 *                  option `store` ('db' or 'file'). dataDir is the default
 *                  of the UCI option data_dir, problems(files, dataDir) the
 *                  messages that stop the configuration from being kept in a
 *                  database. Turning it on is refused while there are any;
 *                  the init script restarts the service when it is applied.
 */

const callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: [ 'name' ],
	expect: { '': {} }
});

const callInitAction = rpc.declare({
	object: 'rc',
	method: 'init',
	params: [ 'name', 'action' ]
});

const callRcList = rpc.declare({
	object: 'rc',
	method: 'list',
	params: [ 'name' ],
	expect: { '': {} }
});

const callLogRead = rpc.declare({
	object: 'log',
	method: 'read',
	params: [ 'lines', 'stream', 'oneshot' ],
	expect: { log: [] }
});

function isRunning(name) {
	return L.resolveDefault(callServiceList(name), {}).then(res =>
		Object.values(res?.[name]?.instances ?? {}).some(i => i.running));
}

// The rc.d link of the init script; false for a service that is not installed
function isBootEnabled(name) {
	return L.resolveDefault(callRcList(name), {}).then(res => res?.[name]?.enabled === true);
}

function notify(text, type) {
	return ui.addTimeLimitedNotification(null, E('p', text), 8000, type);
}

/* Paths */

function dirname(path) {
	const i = path.lastIndexOf('/');
	return i > 0 ? path.slice(0, i) : '/';
}

function basename(path) {
	return path.slice(path.lastIndexOf('/') + 1);
}

function normalize(path) {
	const out = [];
	for (const seg of path.split('/')) {
		if (seg === '' || seg === '.')
			continue;
		if (seg === '..')
			out.pop();
		else
			out.push(seg);
	}
	return '/' + out.join('/');
}

function globToRegExp(glob) {
	let re = '';
	for (const c of glob) {
		if (c === '*')
			re += '[^/]*';
		else if (c === '?')
			re += '[^/]';
		else
			re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp('^' + re + '$');
}

/* include { ... } */

function stripComments(text) {
	return text.split('\n').map(line => {
		let quote = null;
		for (let i = 0; i < line.length; i++) {
			const c = line[i];
			if (quote) {
				if (c === '\\')
					i++;
				else if (c === quote)
					quote = null;
			}
			else if (c === '\'' || c === '"')
				quote = c;
			else if (c === '#')
				return line.slice(0, i);
		}
		return line;
	}).join('\n');
}

function includePatterns(text) {
	const patterns = [];
	const block = /(?:^|[\s}])include\s*\{([^}]*)\}/g;
	const src = stripComments(text);
	let m;
	while ((m = block.exec(src)) != null) {
		const token = /'([^']*)'|"([^"]*)"|([^\s'",;]+)/g;
		let t;
		while ((t = token.exec(m[1])) != null)
			patterns.push(t[1] ?? t[2] ?? t[3]);
	}
	return patterns;
}

/*
 * Both dae and honk resolve relative include paths against the directory of
 * the entry file, refuse files outside of it, only take *.dae and only expand
 * globs in the file name.
 */
function expandPattern(root, pattern) {
	const path = normalize(pattern.startsWith('/') ? pattern : root + '/' + pattern);
	if (!path.startsWith(root + '/'))
		return Promise.resolve([]);
	if (!/[*?]/.test(basename(path)))
		return Promise.resolve(path.endsWith('.dae') ? [ path ] : []);

	const dir = dirname(path), re = globToRegExp(basename(path));
	return L.resolveDefault(fs.list(dir), []).then(entries => entries
		.filter(e => e.type === 'file' && e.name.endsWith('.dae') && re.test(e.name))
		.map(e => dir + '/' + e.name)
		.sort());
}

/* Resolves to [ { path, text } ], entry first; text is null for a missing file. */
function collectFiles(entry, readText) {
	const root = dirname(entry), files = [], seen = new Set();

	const visit = path => {
		if (seen.has(path))
			return Promise.resolve();
		seen.add(path);

		const file = { path, text: null };
		files.push(file);

		return readText(path).then(text => {
			file.text = text;
			if (text == null)
				return;
			return Promise.all(includePatterns(text).map(p => expandPattern(root, p)))
				.then(lists => lists.flat().reduce((chain, child) => chain.then(() => visit(child)), Promise.resolve()));
		});
	};

	return visit(entry).then(() => files);
}

/* null for a missing file; any other error (permission, size) is raised, as
   an editor that showed such a file as new would overwrite it on save. */
function readFromDisk(path) {
	return fs.read(path).catch(err => {
		if (err.name !== 'NotFoundError')
			throw err;
		return null;
	});
}

/* Highlighting */

const TOKEN = new RegExp([
	/(#.*)/.source,                                            // comment
	/('(?:[^'\\]|\\.)*'?|"(?:[^"\\]|\\.)*"?)/.source,           // string
	/(->|&&|\|\||!)/.source,                                   // operator
	/([A-Za-z_][\w-]*)(?=\s*\()/.source,                       // function: domain(, dip(, ...
	/([A-Za-z_][\w-]*)(?=\s*\{)/.source,                       // section: global {, routing {, ...
	/(-?\b\d+(?:\.\d+)*(?:\/\d+)?(?:ms|s|m|h|d)?\b)/.source    // number, duration, IPv4/CIDR
].join('|'), 'g');
const TOKEN_CLASS = [ null, 'c', 's', 'o', 'f', 'k', 'n' ];

function escapeHTML(s) {
	return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

function highlightLine(line) {
	let html = '', pos = 0, m;

	// "key: value" at the start of a line
	const key = /^(\s*)([A-Za-z_][\w.-]*)(?=\s*:)/.exec(line);
	if (key) {
		html = escapeHTML(key[1]) + '<span class="du-p">' + escapeHTML(key[2]) + '</span>';
		pos = key[0].length;
	}

	TOKEN.lastIndex = pos;
	while ((m = TOKEN.exec(line)) != null) {
		const group = m.findIndex((v, i) => i > 0 && v !== undefined);
		html += escapeHTML(line.slice(pos, m.index));
		html += '<span class="du-' + TOKEN_CLASS[group] + '">' + escapeHTML(m[0]) + '</span>';
		pos = m.index + m[0].length;
	}

	return html + escapeHTML(line.slice(pos));
}

/*
 * The themes have no shared palette, and no single color reaches 4.5:1 on both
 * white and dark backgrounds. Each hue is mixed with the theme's own text color,
 * which darkens it on light themes and lightens it on dark ones.
 */
const STYLE = `
.du-editor { position: relative; height: 60vh; min-height: 300px; border: 1px solid rgba(128,128,128,.4); border-radius: 4px; overflow: hidden; }
.du-editor pre, .du-editor textarea {
	position: absolute; top: 0; left: 0; width: 100%; height: 100%; margin: 0; padding: 8px; border: 0; box-sizing: border-box;
	font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; tab-size: 4; overflow: auto;
	background: transparent; letter-spacing: normal; word-spacing: normal;
	/* Both layers wrap the same way, and both reserve the textarea's scrollbar,
	   so each line breaks at the same column and the caret stays on its text. */
	white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal; scrollbar-gutter: stable;
}
.du-editor pre { pointer-events: none; overflow: hidden; color: inherit; }
.du-gutter {
	position: absolute; top: 0; left: 0; width: 46px; height: 100%;
	padding: 8px 6px 8px 0; box-sizing: border-box; overflow: hidden;
	text-align: right; white-space: pre; user-select: none;
	font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	color: color-mix(in srgb, #8a8a8a 60%, currentColor);
	border-right: 1px solid rgba(128,128,128,.25);
}
.du-editor pre, .du-editor textarea { padding-left: 56px; }
/* Themes style code/span inside pre; anything that changes a glyph's box would
   push the colored text away from the caret, so only color is allowed here. */
.du-editor pre * { background: none; padding: 0; margin: 0; border: 0; font: inherit; }
.du-editor textarea { color: transparent; resize: none; outline: none; max-width: none; min-height: 0; }
.du-c { color: color-mix(in srgb, #8a8a8a 60%, currentColor); }
.du-s, .du-running { color: color-mix(in srgb, #2e9e5b 60%, currentColor); }
.du-o { color: color-mix(in srgb, #d14d4d 60%, currentColor); }
.du-f { color: color-mix(in srgb, #c7841a 60%, currentColor); }
.du-k { color: color-mix(in srgb, #a35bd0 60%, currentColor); }
.du-n { color: color-mix(in srgb, #c4660a 60%, currentColor); }
.du-p { color: color-mix(in srgb, #3d7ed6 60%, currentColor); }
/* The page buttons save the settings of the status tab only; the editor has its own. */
/* 配置页和日志页没有表单，别显示“保存并应用 / 保存 / 重置”那一栏 */
body[data-page="admin-services-honk-config"] .cbi-page-actions,
body[data-page="admin-services-honk-log"] .cbi-page-actions { display: none; }
/* 检测结果跟在按钮后面，不换行占一整行 */
.du-pkg-status { display: inline; margin-left: .6em; }
/* Bootstrap's warning and error colors, else Argon's: its warning text color
   (--warning itself is close to red) and --danger. A theme with neither
   leaves the line in its text color. */
.du-logtext {
	width: 100%; height: 60vh; min-height: 320px; box-sizing: border-box; resize: vertical;
	font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	white-space: pre; overflow: auto; margin-bottom: .5em;
}
.du-log { max-height: 50vh; overflow: auto; white-space: pre-wrap; word-break: break-all; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
`;

function createEditor(text, onInput) {
	const pre = E('pre', { 'aria-hidden': 'true' });
	const gutter = E('div', { 'class': 'du-gutter', 'aria-hidden': 'true' });
	const textarea = E('textarea', { 'spellcheck': 'false', 'autocomplete': 'off', 'autocapitalize': 'off' });

	const syncScroll = () => {
		pre.scrollTop = textarea.scrollTop;
		pre.scrollLeft = textarea.scrollLeft;
		gutter.scrollTop = textarea.scrollTop;
	};
	const paint = () => {
		const rows = textarea.value.split('\n');
		pre.innerHTML = rows.map(highlightLine).join('\n') + '\n';
		gutter.textContent = rows.map((_, i) => i + 1).join('\n');
		syncScroll();
	};

	textarea.value = text;
	// A theme may force the textarea's font size (Bootstrap uses 16px on phones
	// so that focusing it does not zoom); the highlight has to follow it.
	new ResizeObserver(() => { pre.style.fontSize = getComputedStyle(textarea).fontSize; }).observe(textarea);
	textarea.addEventListener('input', () => { paint(); onInput(); });
	textarea.addEventListener('scroll', syncScroll);
	// The text itself is transparent, so give the caret the color of the theme.
	textarea.addEventListener('focus', () => { textarea.style.caretColor = getComputedStyle(pre).color; });
	textarea.addEventListener('keydown', ev => {
		if (ev.key !== 'Tab' || ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey)
			return;
		ev.preventDefault();
		// insertText keeps the browser's undo history; setRangeText does not fire input
		if (!document.execCommand('insertText', false, '    ')) {
			textarea.setRangeText('    ', textarea.selectionStart, textarea.selectionEnd, 'end');
			paint();
			onInput();
		}
	});

	paint();
	// Ctrl+S 保存
	textarea.addEventListener('keydown', ev => {
		if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
			ev.preventDefault();
			document.getElementById('du-save-files')?.click();
		}
	});

	return {
		node: E('div', { 'class': 'du-editor' }, [ gutter, pre, textarea ]),
		textarea,
		setText(value) {
			if (textarea.value !== value) {
				textarea.value = value;
				paint();
			}
		}
	};
}

const callLanAddress = rpc.declare({
	object: 'uci',
	method: 'get',
	params: [ 'config', 'section', 'option' ],
	expect: { '': {} }
});

function isIp(host) {
	if (/^\d+\.\d+\.\d+\.\d+$/.test(host))
		return host.split('.').every(part => Number(part) <= 255);
	if (!host.includes(':'))
		return false;
	try {
		return new URL('http://[' + host + ']/').hostname !== '';
	}
	catch (_) {
		return false;
	}
}

/* doona 面板地址；不可达（没开、绑在 127.0.0.1）时返回 null。 */
async function webUi(files) {
	for (const file of files) {
		const body = nativeApi.body(file.text ?? '');
		if (body == null)
			continue;
		const value = key => {
			const match = new RegExp('(?:^|[\\s;,])' + key + '\\s*:\\s*(?:\'([^\']*)\'|"([^"]*)"|([^\\s;,]+))').exec(body);
			return match ? (match[1] ?? match[2] ?? match[3]) : '';
		};
		if (value('enabled') !== 'true' || !value('ui'))
			return null;
		const listen = /^(?:\[([^\]]+)\]|(.+)):(\d+)$/.exec(value('listen'));
		if (!listen || Number(listen[3]) < 1 || Number(listen[3]) > 65535)
			return null;
		let host = listen[1] ?? listen[2];
		const port = listen[3];
		// 绑在回环上：浏览器也打不开，不给按钮
		if (!isIp(host) || host.startsWith('127.') || host === '::1')
			return null;
		if (host === '0.0.0.0' || host === '::') {
			host = window.location.hostname.replace(/^\[|\]$/g, '');
			if (!isIp(host)) {
				const reply = await L.resolveDefault(callLanAddress('network', 'lan', 'ipaddr'), {});
				const address = reply.value ?? '';
				const lan = (Array.isArray(address) ? address[0] ?? '' : address).split('/')[0];
				if (!isIp(lan) || lan.includes(':'))
					return null;
				host = lan;
			}
		}
		return 'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + port + '/';
	}
	return null;
}

const honkApp = {
		name: 'honk',
		title: 'Honk',
		webUi,
		// Both create dae0/daens and hook the same interfaces: only one may run.
		other: 'dae',
		defaultConfig: '/etc/honk/config.dae',
		// honk-core has no offline check; a broken file is reported in the log.
		validate: null,
		// honk-core has no switch for the native API either: its block in the
		// configuration is the single source of truth.
		webUiFlag: {
			read: files => nativeApi.isEnabled(files),
			path: files => nativeApi.targetPath(files),
			write: (text, on) => nativeApi.apply(text, on)
		},
		// honk-core takes the store as a command-line flag, so it is a UCI option
		// of the init script, not a line of the configuration.
		storeFlag: {
			dataDir: '/etc/honk/data',
			problems: (files, dataDir) => nativeApi.storeProblems(files, dataDir)
		},
		// procd forwards stdout as "honk-core[pid]:", the init script logs as "honk:".
		logIdent: /^honk(-core)?(\[\d+\])?: /
};

const ServiceView = view.extend({
	app: null,

	load() {
		return uci.load(this.app.name).then(() => {
			const entry = uci.get(this.app.name, 'config', 'config_file') || this.app.defaultConfig;
			// A file the page may not read leaves the status and the log usable,
			// so config_file can be set back from here.
			return Promise.all([ entry, collectFiles(entry, readFromDisk).catch(err => {
				ui.addNotification(null, E('p', _('Unable to read %s: %s').format(entry, err.message)), 'error');
				return [];
			}), this.queryPackages().catch(error => ({ error })), isBootEnabled(this.app.name) ]);
		});
	},

	/* Editor */

	renderFileTabs() {
		this.fileTabs.replaceChildren(...this.files.map(file => E('li', {
			'class': file.path === this.current ? 'cbi-tab' : 'cbi-tab-disabled'
		}, E('a', {
			'href': '#',
			'click': ev => { ev.preventDefault(); this.showFile(file.path); }
		}, (file.path === this.entry ? basename(file.path) : file.path.slice(dirname(this.entry).length + 1))
			+ (file.text == null ? ' ' + _('(new)') : '')
			+ (file.dirty ? ' *' : '')))));
	},

	showFile(path) {
		this.current = path;
		for (const file of this.files)
			file.editor.node.style.display = file.path === path ? '' : 'none';
		this.renderFileTabs();
	},

	setFiles(files) {
		const previous = new Map((this.files ?? []).map(f => [ f.path, f ]));

		this.files = files.map(file => {
			// Existing editors stay, so the caret and scroll position survive a
			// save or a rescan; unsaved edits are kept as they are.
			const old = previous.get(file.path);
			previous.delete(file.path);
			if (old) {
				if (!old.dirty)
					old.editor.setText(file.text ?? '');
				return Object.assign(old, { text: file.text });
			}

			file.dirty = false;
			file.editor = createEditor(file.text ?? '', () => {
				if (!file.dirty) {
					file.dirty = true;
					this.renderFileTabs();
				}
			});
			return file;
		});

		// Unsaved edits stay even when no include reaches the file any more.
		for (const old of previous.values())
			if (old.dirty)
				this.files.push(old);

		this.editorBox.replaceChildren(...this.files.map(f => f.editor.node));
		this.showFile(this.files.some(f => f.path === this.current) ? this.current : this.entry);
	},

	/* Picks up include lines that were just typed, without saving or losing edits. */
	handleRescan() {
		const buffers = new Map(this.files.filter(f => f.dirty).map(f => [ f.path, f.editor.textarea.value ]));

		return collectFiles(this.entry, path => buffers.has(path) ? Promise.resolve(buffers.get(path)) : readFromDisk(path))
			.then(files => this.setFiles(files));
	},

	handleSaveFiles() {
		const dirty = this.files.filter(f => f.dirty);
		if (!dirty.length)
			return Promise.resolve();

		// dae refuses configuration files that are readable by others; 0600 only
		// applies to new files, existing ones keep their mode. Text typed while
		// saving keeps the file dirty, so the reload below does not drop it.
		return Promise.all(dirty.map(f => {
			const text = f.editor.textarea.value;
			return fs.write(f.path, text, 0o600).then(() => { f.dirty = f.editor.textarea.value !== text; });
		}))
			.then(() => this.applySaved(),
				err => ui.addNotification(null, E('p', _('Unable to save: %s').format(err.message)), 'error'))
			.then(() => collectFiles(this.entry, readFromDisk))
			.then(files => this.setFiles(files));
	},

	/* After a save: a running service has its configuration checked, then the
	   init script reloads or restarts it. A stopped one stays stopped. */
	applySaved() {
		const { name, validate } = this.app;
		const saved = () => ui.addTimeLimitedNotification(null, E('p', _('Saved')), 5000, 'info');

		return isRunning(name).then(running => {
			if (!running)
				return saved();

			return (validate ? fs.exec(validate[0], [ ...validate[1], this.entry ]) : Promise.resolve({ code: 0 }))
				.then(res => {
					if (res.code !== 0) {
						ui.addNotification(_('Configuration is invalid, the service was not reloaded'),
							E('pre', {}, [ res.stderr || '', res.stdout || '' ].join('\n').trim()), 'error');
						return;
					}
					return callInitAction(name, 'reload').then(() =>
						ui.addTimeLimitedNotification(null, E('p', _('Saved, the service is reloading')), 5000, 'info'));
				});
		})
			.catch(err => ui.addNotification(null,
				E('p', _('Saved, but the service could not be reloaded: %s').format(err.message)), 'warning'));
	},

	/* Web UI */

	/* Unsaved edits in the editor would undo the change, be overwritten by it,
	   or be lost when the page reloads after Save & Apply. */
	webUiFlagConflict() {
		const dirty = this.files.find(file => file.dirty);
		return dirty ? _('Save or discard the unsaved changes of %s first').format(dirty.path) : '';
	},

	/* The webUiFlag is saved with the page: write the file, restart the
	   service when it runs, then show what the files say now. */
	async writeWebUiFlag(on) {
		const { name, webUiFlag } = this.app;
		const files = await collectFiles(this.entry, readFromDisk);
		const path = webUiFlag.path(files);
		const old = files.find(file => file.path === path)?.text ?? '';
		const text = webUiFlag.write(old, on);

		if (text !== old) {
			const conflict = this.webUiFlagConflict();
			if (conflict)
				throw new Error(conflict);

			await fs.write(path, text, 0o600);
			if (await isRunning(name)) {
				try {
					await callInitAction(name, 'restart');
					ui.addTimeLimitedNotification(null, E('p', _('Saved, the service is restarting')), 5000, 'info');
				}
				catch (err) {
					ui.addNotification(null, E('p', _('Saved, but the service could not be restarted: %s').format(err.message)), 'warning');
				}
			}
		}

		this.webUiState = on;
		await collectFiles(this.entry, readFromDisk).then(fresh => {
			this.setFiles(fresh);
			return this.app.webUi(fresh).catch(() => null);
		}).then(url => {
			this.webUiUrl = url;
			return this.updateStatus();
		});
	},

	/* Packages */

	async packageCommand(args) {
		const command = '/usr/libexec/honk-pkg';
		// rpc.declare has no per-call timeout in LuCI 25.12 and the GitHub API
		// call can take longer than the default, so this one gets its own.
		const result = args[0] === 'check' ? await new Promise((resolve, reject) => {
			const call = { object: 'file', method: 'exec', raise: true, resolve, reject };
			request.post(rpc.getBaseURL(), {
				jsonrpc: '2.0', id: 'daeuniverse-check', method: 'call',
				params: [ rpc.getSessionID(), 'file', 'exec', { command, params: args } ]
			}, { timeout: 28000, nobatch: true, credentials: true })
				.then(response => rpc.parseCallReply(call, response), reject);
		}) : await fs.exec(command, args);
		if (result.code !== 0) {
			const error = new Error(_('apk exited with code %s.').format(result.code));
			error.output = (result.stdout || '') + (result.stderr || '');
			error.exitCode = result.code;
			throw error;
		}
		return JSON.parse(result.stdout);
	},

	queryPackages(app = this.app.name) {
		return this.packageCommand([ 'installed', app ]);
	},

	/* `tag` is 'div' for text in the version field: LuCI's widgets render a
	   field's text in a div, and themes style a p in a section as section
	   prose, which Argon indents away from the value column. */
	packageHint(names, tag = 'p') {
		return E(tag, {}, _('To use this feed\'s version, run %s; other packages can be added to the same command.')
			.format('apk add ' + names.join(' ')));
	},

	packageError(error, tag = 'p') {
		const output = error.output ?? error.message;
		const nodes = [ E(tag, {}, error.message), E('pre', { 'class': 'du-log' }, output) ];
		const pinned = [ 'honk', 'luci-app-honk',
			'luci-i18n-honk-zh-cn', 'luci-i18n-honk-zh-tw',
			'v2ray-geoip', 'v2ray-geosite' ].filter(name =>
				new RegExp('breaks: world\\[' + name + '(?=[\\]@<>=~])').test(output));
		if (pinned.length)
			nodes.push(this.packageHint(pinned, tag));
		return nodes;
	},

	async handleCheckUpdates() {
		this.checkButton.disabled = true;
		this.packageStatus.replaceChildren(_('Checking for updates…'));
		try {
			const result = await this.packageCommand([ 'check', this.app.name ]);
			const installed = await this.queryPackages();
			if (!installed.some(pkg => pkg.name === this.app.name))
				throw new Error(_('Not installed'));
			// 只跟我们自己的软件源比版本（helper 直接读 index.json），不再触发
			// apk update，所以镜像上坏掉的源影响不到这里；拿不到索引会走 catch
			const updates = result.packages.filter(pkg => installed.some(current => current.name === pkg.name));
			if (!updates.length) {
				this.packageStatus.replaceChildren(E('em', { 'class': 'du-running' }, _('Up to date')));
				return;
			}
			this.packageStatus.replaceChildren(
				E('em', { 'class': 'du-f' }, '发现 %s 个更新'.replace('%s', updates.length)));
			const current = Object.fromEntries(installed.map(pkg => [ pkg.name, pkg.version ]));
			const boxes = updates.map(pkg => E('input', { 'type': 'checkbox', 'checked': true, 'value': pkg.name,
				'change': () => { upgrade.disabled = !boxes.some(box => box.checked); } }));
			const upgrade = E('button', {
				'class': 'btn cbi-button-action',
				'click': () => this.handleUpgrade(boxes.filter(box => box.checked).map(box => box.value))
			}, _('Upgrade'));
			ui.showModal(_('Upgrade'), [
				E('p', {}, _('Select the packages to upgrade:')),
				// Rows, not a list: Bootstrap gives li its muted text color.
				E('div', {}, updates.map((pkg, i) => E('div', {}, E('label', {}, [
					boxes[i], ' ', pkg.name + ': ' + (current[pkg.name] || pkg.installed) + ' → ' + pkg.version
				])))),
				E('p', {}, _('Upgrading %s restarts the service and interrupts connections for a few seconds; upgrading only the other packages reloads it. Continue?').format(this.app.name)),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
					' ',
					upgrade
				])
			]);
		}
		catch (error) {
			this.packageStatus.replaceChildren(...this.packageError(error, 'div'));
		}
		finally {
			this.checkButton.disabled = false;
		}
	},

	showPackageJob(status, message) {
		this.packageLog = E('pre', { 'class': 'du-log', 'aria-live': 'polite' }, status.log || '');
		this.packageProgress = E('p', { 'class': 'spinning' }, message || _('Upgrading…'));
		ui.showModal(_('Upgrade'), [ this.packageProgress, this.packageLog ]);
	},

	/* 一键安装：helper 先配好本仓库的 apk 源（写入 repositories.d + 公钥），
	   然后在后台 apk add。之后的轮询、日志、错误处理都和升级共用。 */
	async handleInstall() {
		this.installButton.disabled = true;
		this.checkButton.disabled = true;
		this.packageLaunchError = null;
		this.showPackageJob({}, _('Installing…'));
		let previous;
		try {
			previous = await this.packageCommand([ 'status' ]);
		}
		catch (error) {
			this.finishPackageJob(this.packageError(error), false);
			return;
		}
		this.packagePreviousJob = previous.id;
		try {
			const status = previous.running ? previous :
				await this.packageCommand([ 'install', this.app.name ]);
			this.showPackageJob(status, previous.running || status.already_running ? _('An upgrade is already running.') : _('Installing…'));
		}
		catch (error) {
			if (error.exitCode != null || error.name === 'PermissionError') {
				this.finishPackageJob(this.packageError(error), false);
				return;
			}
			this.packageLaunchError = error;
		}
		this.packagePolling = true;
		this.packagePollFailure = null;
	},

	async handleUpgrade(packages) {
		this.checkButton.disabled = true;
		this.packageLaunchError = null;
		this.showPackageJob({});
		let previous;
		try {
			previous = await this.packageCommand([ 'status' ]);
		}
		catch (error) {
			this.finishPackageJob(this.packageError(error), false);
			return;
		}
		this.packagePreviousJob = previous.id;
		try {
			const status = previous.running ? previous :
				await this.packageCommand([ 'upgrade', this.app.name, ...packages ]);
			this.showPackageJob(status, previous.running || status.already_running ? _('An upgrade is already running.') : null);
		}
		catch (error) {
			if (error.exitCode != null || error.name === 'PermissionError') {
				this.finishPackageJob(this.packageError(error), false);
				return;
			}
			// A reload of rpcd can lose even the launch reply. Observe the job;
			// never submit a second transaction to guess whether it started.
			this.packageLaunchError = error;
		}
		this.packagePolling = true;
		this.packagePollFailure = null;
	},

	async pollPackageJob() {
		if (!this.packagePolling)
			return;
		try {
			const status = await this.packageCommand([ 'status' ]);
			if (this.packageLaunchError && status.id === this.packagePreviousJob)
				throw this.packageLaunchError;
			if (status.running) {
				this.checkButton.disabled = true;
				if (!this.packageProgress)
					this.showPackageJob(status, _('An upgrade is already running.'));
				else if (this.packagePollFailure)
					this.packageProgress.replaceChildren(_('Upgrading…'));
				this.packageLog.textContent = status.log;
				this.packageLog.scrollTop = this.packageLog.scrollHeight;
			}
			else if (status.code != null && this.packageProgress) {
				if (status.code !== 0) {
					const error = new Error(_('apk exited with code %s.').format(status.code));
					error.output = status.log;
					this.finishPackageJob(this.packageError(error), false);
				}
				else {
					// Query again after postinst (and rpcd) have finished. A pinned
					// world entry can make apk return zero without changing anything.
					const installed = await this.queryPackages();
					const current = Object.fromEntries(installed.map(pkg => [ pkg.name, pkg.version ]));
					const before = Object.fromEntries(status.before.map(pkg => [ pkg.name, pkg.version ]));
					const unchanged = status.packages.filter(name => !current[name] || current[name] === before[name]);
					this.finishPackageJob([
						E('pre', { 'class': 'du-log' }, status.log),
						...(unchanged.length ? [
							E('p', {}, _('These packages were not upgraded: %s').format(unchanged.join(', '))),
							this.packageHint(unchanged)
						] : [ E('p', {}, _('Upgrade complete.')) ])
					], true);
				}
			}
			else {
				if (this.packageLaunchError)
					throw this.packageLaunchError;
				this.packagePolling = false;
				this.checkButton.disabled = false;
			}
			this.packagePollFailure = null;
			this.packageLaunchError = null;
		}
		catch (error) {
			// rpcd restarts while LuCI packages are installed. Allow two minutes
			// of failed polls, independently of how long the download takes.
			this.packagePollFailure ??= Date.now();
			if (Date.now() - this.packagePollFailure < 120000) {
				if (this.packageProgress)
					this.packageProgress.replaceChildren(_('Waiting for the package manager to reconnect…'));
				return;
			}
			this.finishPackageJob([
				E('p', {}, _('Unable to read upgrade status. The job may still be running; reload to reconnect.')),
				...this.packageError(error)
			], false);
		}
	},

	finishPackageJob(nodes, reload) {
		this.packagePolling = false;
		this.checkButton.disabled = false;
		if (this.installButton)
			this.installButton.disabled = false;
		this.packageProgress = null;
		ui.showModal(_('Upgrade'), [ ...nodes,
			E('div', { 'class': 'right' }, E('button', {
				'class': 'btn', 'click': reload ? () => window.location.reload() : ui.hideModal
			}, _('Close')))
		]);
	},

	/* Status and log */

	updateStatus() {
		const { name } = this.app;
		return isRunning(name).then(running => {
			const state = running ? _('Running') : _('Not running');
			// HomeProxy 的写法：<em><span style="color:red"><strong>名字 (版本) 状态</strong></span></em>
			const line = document.getElementById(name + '-status-line');
			if (line) {
				const color = running ? 'green' : 'red';
				const text = 'Honk (' + (this.heroVersion || _('Not installed')) + ') ' + state;
				line.innerHTML = '<em><span style="color:' + color + '"><strong>' +
					String(text).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]) +
					'</strong></span></em>';
				// 只有运行中才有面板按钮（和 adguardhome 的 Open Web Interface 一样）
				if (running && this.webUiUrl)
					line.append(' ', E('a', {
						'class': 'btn cbi-button',
						'href': this.webUiUrl,
						'target': '_blank',
						'rel': 'noopener noreferrer'
					}, _('Open Web Interface')));
			}
		});
	},

	/* 保存并应用之后按“启用”直接 start/stop（和 adguardhome 一样：开关是 UCI 的
	   enabled，init 脚本读它来决定能不能起，所以这里必须等 Map.save() 把文件写完再动作）。
	   不用 reload：reload 只在服务已经注册到 procd 时才可靠，停着的时候不一定会起。 */
	async applyRunState() {
		const { name, other } = this.app;
		const want = uci.get(name, 'config', 'enabled') === '1';
		// honk 和 dae 都要 dae0/daens：启用 honk 前先把 dae 停掉
		if (want)
			await callInitAction(other, 'stop').catch(() => {});
		await callInitAction(name, want ? 'start' : 'stop').catch(() => {});
		await this.updateStatus();
	},

	updateBoot() {
		return isBootEnabled(this.app.name).then(enabled => {
			if (!this.bootBusy)
				this.bootSwitch.checked = enabled;
		});
	},

	/* The switch acts at once through the init script; there is nothing to save.
	   Only one of dae and honk may start at boot, so turning it on here turns it
	   off for the other. */
	async handleBootChange(on) {
		const { name, other } = this.app;

		this.bootBusy = true;
		this.bootSwitch.disabled = true;
		try {
			const turnedOff = on && await isBootEnabled(other);
			if (turnedOff)
				await callInitAction(other, 'disable');
			await callInitAction(name, on ? 'enable' : 'disable');
			notify(turnedOff
				? _('Start at boot is on; %s no longer starts at boot, because dae and honk cannot run at the same time.').format(other)
				: on ? _('Start at boot is on') : _('Start at boot is off'), 'info');
		}
		catch (err) {
			ui.addNotification(null, E('p', _('Unable to change Start at boot: %s').format(err.message)), 'error');
		}
		finally {
			this.bootBusy = false;
			this.bootSwitch.disabled = false;
			await this.updateBoot();
		}
	},

	updateLog() {
		// logd returns nothing for lines=0; 1000 is what LuCI's own log view reads.
		return L.resolveDefault(callLogRead(1000, false, true), []).then(entries => {
			const text = entries
				.filter(e => this.app.logIdent.test(e.msg))
				.slice(-500)
				.map(e => new Date(e.time).toLocaleString() + '  ' + e.msg)
				.join('\n');
			const box = this.logBox;
			const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
			box.value = text || _('No log entries.');
			if (atBottom)
				box.scrollTop = box.scrollHeight;
		});
	},

	downloadLog() {
		const blob = new Blob([ this.logBox.value || '' ], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = E('a', { 'href': url, 'download': 'honk-' + Date.now() + '.log' });
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	},

	async render([ entry, files, installed, bootEnabled ]) {
		const { name } = this.app;
		const tab = this.app.tab || 'status';

		document.head.appendChild(E('style', {}, STYLE));

		this.entry = entry;
		this.fileTabs = E('ul', { 'class': 'cbi-tabmenu' });
		this.editorBox = E('div');
		this.logBox = E('textarea', {
			'class': 'du-logtext', 'readonly': 'readonly',
			'spellcheck': 'false', 'wrap': 'off', 'rows': '24', 'aria-live': 'polite'
		});
		this.setFiles(files);

		// 和 HomeProxy 一样：每个标签是独立的菜单页，标签条由 LuCI 自己渲染
		if (tab === 'config')
			return this.renderConfigPage();
		if (tab === 'log')
			return this.renderLogPage();
		return this.renderStatusPage(files, installed, bootEnabled);
	},

	/* 服务状态页：form.Map 的标题和简介 + 状态行 + 各项设置 */
	async renderStatusPage(files, installed, bootEnabled) {
		const { name, defaultConfig } = this.app;
		// 表单直接读 UCI（“启用”是 option enabled），缓存没加载的话勾选框会显示成
		// 未勾选，和服务实际状态对不上
		await uci.load(name).catch(() => {});
		this.heroVersion = installed.error ? null
			: installed.find(pkg => pkg.name === name)?.version || null;

		const m = new form.Map(name, 'Honk',
			'基于 Rust 与 eBPF 的新一代 Linux 高性能透明代理引擎。');

		// 运行状态单独一个 section，和 HomeProxy 的 service_status 一样
		const st = m.section(form.TypedSection);
		st.render = () => E('div', { 'class': 'cbi-section' },
			E('p', { 'id': name + '-status-line' }, '…'));

		const s = m.section(form.NamedSection, 'config', name);
		s.anonymous = true;

		// 和 adguardhome 一样：启用就是 /etc/config/honk 里的 option enabled，
		// 勾选只是表单改动，点“保存并应用”才由 init 脚本 start/stop
		let o = s.option(form.Flag, 'enabled', _('Enable'));
		o.default = '0';
		o.rmempty = false;
		o.description = '勾选表示运行，取消表示停止；点“保存并应用”后生效。';

		// 结果跟在按钮后面（和 passwall 一样），不是单独占一行
		this.packageStatus = E('span', { 'class': 'du-pkg-status', 'aria-live': 'polite' });
		this.checkButton = E('button', {
			'class': 'btn cbi-button', 'type': 'button',
			'click': () => this.handleCheckUpdates()
		}, _('Check for updates'));
		this.installButton = E('button', {
			'class': 'btn cbi-button-action', 'type': 'button',
			'click': () => this.handleInstall()
		}, _('Install'));
		o = s.option(form.DummyValue, '_version', _('Version'));
		o.renderWidget = () => E('div', {}, [
			E('span', {}, installed.error ? _('Unable to read version: %s').format(installed.error.message)
				: installed.find(pkg => pkg.name === name)?.version || _('Not installed')),
			' ',
			installed.error ? '' : (installed.some(pkg => pkg.name === name) ? this.checkButton : this.installButton),
			this.packageStatus
		]);

		// Not a UCI option: the rc.d link of the init script, which the switch
		// changes at once
		this.bootSwitch = E('input', {
			'type': 'checkbox', 'id': name + '-boot',
			'change': ev => this.handleBootChange(ev.target.checked)
		});
		this.bootSwitch.checked = bootEnabled;
		o = s.option(form.DummyValue, '_boot', _('Start at boot'),
			_('Starts automatically when the router boots; does not change whether it is running now.'));
		o.renderWidget = () => E('div', { 'class': 'cbi-checkbox' }, [
			this.bootSwitch, E('label', { 'for': name + '-boot' })
		]);

		o = s.option(form.Value, 'config_file', _('Configuration file'));
		o.placeholder = defaultConfig;
		o.rmempty = false;
		// The page may only read and write this directory (see the ACL)
		o.validate = (section_id, value) => {
			const dir = dirname(defaultConfig);
			return (normalize(value) === value && value.startsWith(dir + '/')) || _('Must be a file in %s').format(dir);
		};

		const { webUi, webUiFlag, storeFlag } = this.app;
		if (webUiFlag) {
			this.webUiState = webUiFlag.read(files);
			const flag = s.option(form.Flag, '_web_ui_enabled', _('Enable the doona web UI'),
				_('Unchecked, honk runs without the native API and doona. Saving restarts honk.'));
			flag.rmempty = false;
			flag.cfgvalue = () => this.webUiState ? '1' : '0';
			flag.write = (section_id, value) => this.writeWebUiFlag(value === '1');
			flag.remove = () => {};
			// Only a changed box can conflict. A checkbox widget reports '1' as its
			// value whatever its state, so the form value is read instead.
			flag.validate = section_id => (flag.formvalue(section_id) === '1') === this.webUiState
				|| this.webUiFlagConflict() || true;
		}

		if (storeFlag) {
			const dataDir = uci.get(name, 'config', 'data_dir') || storeFlag.dataDir;
			const flag = s.option(form.Flag, 'store', _('Keep the configuration in a database'),
				_('Lets doona import the configuration and keep a revision history. honk then reads the database, not the configuration file. Saving restarts honk.'));
			flag.enabled = 'db';
			flag.disabled = 'file';
			flag.default = 'file';
			flag.rmempty = false;
			// Once the database holds the configuration, the files are not read again
			flag.validate = section_id => {
				if (flag.formvalue(section_id) !== 'db' || flag.cfgvalue(section_id) === 'db')
					return true;
				return this.webUiFlagConflict()
					|| storeFlag.problems(this.files, dataDir).join(' ')
					|| true;
			};
		}


		// “保存并应用”会调用 map.save()；保存完再按 enabled 让服务启停
		const save = m.save.bind(m);
		m.save = (cb, silent) => Promise.resolve(save(cb, silent))
			.then(result => this.applyRunState().catch(() => {}).then(() => result));

		return m.render().then(async mapNode => {
			// 面板地址只算一次；运行中时按钮出现在状态行后面（照 adguardhome 的做法）
			this.webUiUrl = await this.app.webUi(files).catch(() => null);
			poll.add(() => Promise.all([ this.updateStatus(), this.updateBoot() ]), 5);
			this.updateStatus();
			this.packagePolling = true;
			// 立刻查一次，别让“检查更新”按钮要等第一次轮询之后才可点
			this.pollPackageJob();
			poll.add(() => this.pollPackageJob(), 2);
			return mapNode;
		});
	},

	/* 配置页 */
	renderConfigPage() {
		const m = new form.Map(this.app.name, _('Configuration'),
			_('Edit the configuration file and every file it includes; each tab is saved to its own file.'));
		const s = m.section(form.TypedSection);
		s.render = () => E('div', { 'class': 'cbi-section' }, [
			this.fileTabs,
			this.editorBox,
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn cbi-button',
					'click': ui.createHandlerFn(this, 'handleRescan')
				}, _('Re-read includes')),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-save',
					'id': 'du-save-files',
					'click': ui.createHandlerFn(this, 'handleSaveFiles')
				}, _('Save files'))
			])
		]);
		// 这一页有自己的“保存文件”按钮，不要再出现表单的保存栏
		return m.render().then(node => { node.querySelector('.cbi-page-actions')?.remove(); return node; });
	},

	/* 日志页 */
	renderLogPage() {
		const m = new form.Map(this.app.name, _('Log'));
		const s = m.section(form.TypedSection);
		this.logPaused = false;
		const pauseBtn = E('button', {
			'class': 'btn cbi-button',
			'click': () => {
				this.logPaused = !this.logPaused;
				pauseBtn.textContent = this.logPaused ? _('Resume') : _('Pause');
			}
		}, _('Pause'));
		s.render = () => E('div', { 'class': 'cbi-section' }, [
			this.logBox,
			E('div', { 'class': 'right' }, [
				pauseBtn,
				' ',
				E('button', {
					'class': 'btn cbi-button',
					'click': ui.createHandlerFn(this, 'updateLog')
				}, _('Refresh')),
				' ',
				E('button', {
					'class': 'btn cbi-button',
					'click': () => { this.logBox.value = ''; }
				}, _('Clear')),
				' ',
				E('button', {
					'class': 'btn cbi-button',
					'click': () => this.downloadLog()
				}, _('Download'))
			])
		]);
		return m.render().then(node => {
			node.querySelector('.cbi-page-actions')?.remove();
			this.updateLog().then(() => { this.logBox.scrollTop = this.logBox.scrollHeight; });
			poll.add(() => this.logPaused ? null : this.updateLog(), 5);
			return node;
		});
	}
});

// LuCI instantiates the class a module returns, so the view is a member.
ServiceView.app = honkApp;

return baseclass.extend({ View: ServiceView });

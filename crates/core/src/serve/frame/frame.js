// 生成物。packages/frame-runtime を scripts/build-frame.mjs でまとめたもの。直接は直さない。
(function() {
	// packages/frame-runtime/src/api-members.ts
	var MAX_MEMBERS = 1e3;
	var MAX_DEPTH = 4;
	function apiPaths(api) {
		const out = [];
		const seen = /* @__PURE__ */ new Set();
		const walk = (value, prefix, depth) => {
			if (out.length >= MAX_MEMBERS) return;
			if (typeof value !== "object" || value === null) return;
			if (seen.has(value) || depth > MAX_DEPTH) return;
			seen.add(value);
			for (const key of Object.keys(value)) {
				if (!/^[A-Za-z_$][\w$]*$/.test(key)) continue;
				const item = value[key];
				const path = prefix === "" ? key : `${prefix}.${key}`;
				if (typeof item === "function") {
					if (out.length < MAX_MEMBERS) out.push(path);
				} else walk(item, path, depth + 1);
			}
		};
		walk(api, "", 0);
		return out;
	}
	/** `a.b.c` の形の名前で、オブジェクトの中の関数を引く（親の `this` つき）。 */
	function resolveMember(api, path) {
		let owner = null;
		let current = api;
		for (const part of path.split(".")) {
			if (typeof current !== "object" || current === null) return null;
			owner = current;
			current = current[part];
		}
		return typeof current === "function" ? {
			fn: current,
			owner
		} : null;
	}
	// packages/frame-runtime/src/errors.ts
	function toReport(phase, error) {
		if (error instanceof Error) {
			const report = {
				phase,
				message: error.message
			};
			if (typeof error.stack === "string") report.stack = error.stack.slice(0, 2e3);
			return report;
		}
		return {
			phase,
			message: String(error).slice(0, 500)
		};
	}
	/** `error` と `unhandledrejection` を拾って報告する。戻り値で外せる。 */
	function installErrorReporting(win, report) {
		const onError = (event) => {
			const e = event;
			report(e.error instanceof Error ? {
				...toReport("error", e.error),
				message: e.message || e.error.message
			} : {
				phase: "error",
				message: e.message ?? "error"
			});
		};
		const onRejection = (event) => {
			report(toReport("unhandledrejection", event.reason));
		};
		win.addEventListener("error", onError);
		win.addEventListener("unhandledrejection", onRejection);
		return () => {
			win.removeEventListener("error", onError);
			win.removeEventListener("unhandledrejection", onRejection);
		};
	}
	// packages/frame-runtime/src/host-proxy.ts
	var methodNames = Object.keys({
		version: 1,
		permissions: [
			"assets.read",
			"assets.metadata",
			"annotations.read",
			"annotations.write",
			"labels.read",
			"labels.write",
			"project.status",
			"project.files",
			"fs.export",
			"fs.import",
			"python.spawn",
			"network"
		],
		methods: {
			"extension": null,
			"editors.register": null,
			"previewers.register": null,
			"items.register": null,
			"annotationTypes.register": null,
			"views.register": null,
			"exporters.register": null,
			"importers.register": null,
			"commands.register": null,
			"commands.execute": null,
			"tools.active": null,
			"tools.activate": null,
			"tools.onDidChange": null,
			"selection.get": null,
			"selection.set": null,
			"selection.onDidChange": null,
			"extensions.getApi": null,
			"storage.get": null,
			"storage.set": null,
			"settings.get": null,
			"settings.onDidChange": null,
			"ui.notify": null,
			"ui.setStatusBarItem": null,
			"ui.confirm": null,
			"ui.showView": null,
			"context.set": null,
			"i18n.locale": null,
			"i18n.t": null,
			"log": null,
			"assets.get": "assets.read",
			"assets.url": "assets.read",
			"assets.read": "assets.read",
			"assets.readText": "assets.read",
			"assets.getItem": "assets.read",
			"assets.current": "assets.read",
			"assets.onDidChangeCurrent": "assets.read",
			"assets.setMetadata": "assets.metadata",
			"assets.setStatus": "project.status",
			"annotations.query": "annotations.read",
			"annotations.onDidChange": "annotations.read",
			"relations.query": "annotations.read",
			"groups.query": "annotations.read",
			"annotations.create": "annotations.write",
			"annotations.update": "annotations.write",
			"annotations.remove": "annotations.write",
			"annotations.transaction": "annotations.write",
			"annotations.suggest": "annotations.write",
			"relations.create": "annotations.write",
			"relations.update": "annotations.write",
			"relations.remove": "annotations.write",
			"groups.create": "annotations.write",
			"groups.setMembers": "annotations.write",
			"groups.update": "annotations.write",
			"groups.remove": "annotations.write",
			"labels.list": "labels.read",
			"labels.attributeSchema": "labels.read",
			"labels.active": "labels.read",
			"labels.onDidChangeActive": "labels.read",
			"labels.onDidChange": "labels.read",
			"python.request": "python.spawn",
			"python.readBlob": "python.spawn",
			"projectFiles.read": "project.files",
			"projectFiles.write": "project.files",
			"export.writeFile": "fs.export",
			"import.readFile": "fs.import"
		},
		commands: {
			"create_annotation": "annotations.write",
			"update_annotation": "annotations.write",
			"delete_annotation": "annotations.write",
			"create_relation": "annotations.write",
			"update_relation": "annotations.write",
			"delete_relation": "annotations.write",
			"create_group": "annotations.write",
			"update_group": "annotations.write",
			"delete_group": "annotations.write",
			"add_group_members": "annotations.write",
			"remove_group_members": "annotations.write",
			"move_group_member": "annotations.write",
			"create_label": "labels.write",
			"update_label": "labels.write",
			"delete_label": "labels.write",
			"set_attribute_schema": "labels.write",
			"delete_attribute_schema": "labels.write",
			"set_asset_status": "project.status",
			"set_item_status": "project.status",
			"set_asset_metadata": "assets.metadata",
			"set_item_metadata": "assets.metadata",
			"set_plugin_data": false,
			"set_asset_note": false,
			"set_asset_attributes": false,
			"set_item_attributes": false,
			"sync_assets": false,
			"relink_asset": false,
			"delete_asset": false
		}
	}.methods);
	/** 写しから返す同期のメソッド。 */
	function syncMethods(d) {
		const { mirror } = d;
		return {
			"selection.get": () => mirror.get("selection"),
			"labels.active": () => mirror.get("labels.active"),
			"assets.current": () => mirror.get("assets.current"),
			"tools.active": () => mirror.get("tools.active"),
			"settings.get": (key) => {
				const all = mirror.get("settings") ?? {};
				return typeof key === "string" ? all[key] : all;
			},
			"assets.url": (id) => `${d.base}/asset/${String(id)}`,
			"i18n.t": (key, vars) => {
				const template = d.messages[String(key)] ?? String(key);
				const v = vars ?? {};
				return template.replace(/\{(\w+)\}/g, (_, name) => name in v ? String(v[name]) : `{${name}}`);
			}
		};
	}
	var EVENT_KEYS = {
		"selection.onDidChange": "selection",
		"labels.onDidChangeActive": "labels.active",
		"labels.onDidChange": "labels.change",
		"assets.onDidChangeCurrent": "assets.current",
		"annotations.onDidChange": "annotations.change",
		"tools.onDidChange": "tools.active",
		"settings.onDidChange": "settings"
	};
	/** 関数の値（`impl` の関数メンバー）の名前を取り出す。 */
	function memberNames(impl) {
		if (typeof impl !== "object" || impl === null) return [];
		return Object.entries(impl).filter(([, v]) => typeof v === "function").map(([k]) => k);
	}
	function createHost(deps) {
		const handlers = /* @__PURE__ */ new Map();
		const sync = syncMethods(deps);
		const host = { extension: deps.ext };
		const ns = (name) => {
			const existing = host[name];
			if (existing !== void 0) return existing;
			const created = {};
			host[name] = created;
			return created;
		};
		for (const full of methodNames) {
			const dot = full.indexOf(".");
			if (dot < 0) continue;
			const space = full.slice(0, dot);
			const name = full.slice(dot + 1);
			const target = ns(space);
			if (name === "register") target[name] = (localId, impl) => {
				handlers.set(`${space}:${localId}`, impl);
				deps.request(full, {
					localId,
					members: memberNames(impl)
				}).catch((error) => deps.report("log", {
					level: "error",
					args: [`${full}(${localId}) was rejected: ${error instanceof Error ? error.message : String(error)}`]
				}));
				return { dispose: () => void handlers.delete(`${space}:${localId}`) };
			};
			else if (full in EVENT_KEYS) {
				const key = EVENT_KEYS[full];
				target[name] = (listener) => deps.mirror.on(key, listener);
			} else if (full === "selection.set") target[name] = (ids) => {
				deps.mirror.apply("selection", ids);
				return deps.request(full, [ids]);
			};
			else if (full === "annotations.transaction") target[name] = async (label, fn) => {
				if (typeof fn !== "function") throw new TypeError("fn must be a function");
				await deps.request(full, {
					op: "begin",
					label: String(label)
				});
				let result;
				try {
					result = await fn();
				} catch (error) {
					await deps.request(full, { op: "abort" }).catch(() => {});
					throw error;
				}
				await deps.request(full, { op: "commit" });
				return result;
			};
			else if (full === "i18n.locale") Object.defineProperty(target, "locale", {
				get: () => deps.locale,
				enumerable: true
			});
			else if (full in sync) target[name] = sync[full];
			else if (full === "assets.readText") target[name] = async (id, encoding) => {
				const label = typeof encoding === "string" ? encoding : "utf-8";
				let converter;
				try {
					converter = new TextDecoder(label);
				} catch {
					throw Object.assign(/* @__PURE__ */ new Error(`unknown encoding: ${label}`), { code: "ValidationFailed" });
				}
				const bytes = await deps.request("assets.read", [id]);
				return converter.decode(bytes);
			};
			else if (full === "extensions.getApi") target[name] = async (id) => {
				const members = await deps.request(full, { id });
				const api = {};
				for (const path of members) {
					const parts = path.split(".");
					const last = parts.pop();
					let node = api;
					for (const part of parts) {
						const next = node[part] ?? {};
						node[part] = next;
						node = next;
					}
					node[last] = (...args) => deps.request(full, {
						id,
						call: path,
						args
					});
				}
				return api;
			};
			else target[name] = (...args) => deps.request(full, args);
		}
		host.log = Object.fromEntries([
			"debug",
			"info",
			"warn",
			"error"
		].map((level) => [level, (...args) => deps.report("log", {
			level,
			args: args.map(String)
		})]));
		let publishedApi;
		return {
			host,
			registry: {
				setApi(api) {
					publishedApi = api;
				},
				async invoke(kind, localId, member, args) {
					if (kind === "api") {
						const target = member === void 0 ? null : resolveMember(publishedApi, member);
						if (target === null) throw new Error(`no api member: ${String(member)}`);
						return await target.fn.apply(target.owner, args);
					}
					const impl = handlers.get(`${kind}:${localId}`);
					if (impl === void 0) throw new Error(`not registered: ${kind}/${localId}`);
					if (member === void 0) {
						if (typeof impl !== "function") throw new Error("not callable");
						return await impl(...args);
					}
					const fn = impl[member];
					if (typeof fn !== "function") throw new Error(`no member: ${member}`);
					return await fn.apply(impl, args);
				}
			}
		};
	}
	// packages/frame-runtime/src/mirror.ts
	function createMirror(initial) {
		const values = new Map(Object.entries(initial));
		const listeners = /* @__PURE__ */ new Map();
		return {
			get: (key) => values.get(key),
			apply(key, value) {
				if (values.has(key)) values.set(key, value);
				for (const listener of [...listeners.get(key) ?? []]) try {
					listener(value);
				} catch {}
			},
			on(key, listener) {
				const set = listeners.get(key) ?? /* @__PURE__ */ new Set();
				set.add(listener);
				listeners.set(key, set);
				return { dispose: () => void set.delete(listener) };
			}
		};
	}
	// packages/frame-runtime/src/styles.ts
	/** 枠の基本のスタイル。本体の色の変数（`--color-*`）が使える。 */
	var BASE_CSS = `
html, body { margin: 0; padding: 0; height: 100%; }
body {
  background: var(--color-bg, #fff);
  color: var(--color-fg, #000);
  font: 14px/1.5 system-ui, sans-serif;
}
*, *::before, *::after { box-sizing: border-box; }
`;
	var NAME = /^--[A-Za-z0-9_-]+$/;
	function isSafeValue(value) {
		for (const ch of value) {
			const code = ch.charCodeAt(0);
			if (code < 32 || code === 127 || ";{}<>\\".includes(ch)) return false;
		}
		return true;
	}
	function applyBaseStyles(doc) {
		const adopt = doc;
		const Sheet = (doc.defaultView ?? globalThis).CSSStyleSheet;
		if (Array.isArray(adopt.adoptedStyleSheets) && typeof Sheet === "function") {
			const sheet = new Sheet();
			sheet.replaceSync(BASE_CSS);
			adopt.adoptedStyleSheets = [sheet];
			return;
		}
		const body = doc.body;
		if (body !== void 0 && body !== null) {
			body.style.margin = "0";
			body.style.background = "var(--color-bg)";
			body.style.color = "var(--color-fg)";
		}
	}
	/** テーマの色の変数をルートに設定する（`style` 属性を書かず、CSSOM で）。 */
	function applyTheme(doc, variables) {
		const style = doc.documentElement.style;
		for (const [name, value] of Object.entries(variables)) {
			if (!NAME.test(name) || typeof value !== "string" || !isSafeValue(value)) continue;
			style.setProperty(name, value);
		}
	}
	// packages/frame-runtime/src/bootstrap.ts
	function isInit(data) {
		if (typeof data !== "object" || data === null) return false;
		const d = data;
		return d.t === "init" && typeof d.url === "string" && typeof d.role === "string" && typeof d.ext === "object" && d.ext !== null;
	}
	/** 起動する。戻り値で、購読を外す（テスト用）。 */
	function startFrame(deps) {
		let started = false;
		let removeErrors = null;
		const onMessage = (event) => {
			if (started) return;
			const e = event;
			if (e.source !== deps.win.parent) return;
			const port = e.ports?.[0];
			if (port === void 0 || !isInit(e.data)) return;
			started = true;
			deps.win.removeEventListener("message", onMessage);
			run(port, e.data);
		};
		async function run(port, init) {
			const post = (message) => port.postMessage(message);
			const reportError = (r) => post({
				t: "rep",
				kind: "error",
				v: r
			});
			removeErrors = installErrorReporting(deps.win, reportError);
			applyBaseStyles(deps.doc);
			applyTheme(deps.doc, init.theme);
			const mirror = createMirror(init.mirror);
			let nextId = 1;
			const pending = /* @__PURE__ */ new Map();
			const request = (m, a) => new Promise((resolve, reject) => {
				const id = nextId++;
				pending.set(id, {
					resolve,
					reject
				});
				post({
					t: "req",
					id,
					m,
					a
				});
			});
			const { host, registry } = createHost({
				ext: init.ext,
				mirror,
				locale: init.locale,
				messages: init.messages,
				base: init.base,
				request,
				report: (kind, v) => post({
					t: "rep",
					kind,
					v
				})
			});
			let mod = {};
			const surfaceAbort = new AbortController();
			let surface = null;
			const controllers = /* @__PURE__ */ new Map();
			port.onmessage = (event) => {
				const data = event.data;
				if (typeof data !== "object" || data === null) return;
				if (data.t === "ev" && typeof data.k === "string") {
					if (data.k === "theme") {
						if (typeof data.v === "object" && data.v !== null) applyTheme(deps.doc, data.v);
						return;
					}
					mirror.apply(data.k, data.v);
				} else if (data.t === "res" && typeof data.id === "number") {
					const p = pending.get(data.id);
					if (p === void 0) return;
					pending.delete(data.id);
					if (data.ok === true) p.resolve(data.v);
					else p.reject(Object.assign(new Error(String(data.msg ?? "")), { code: String(data.code ?? "Internal") }));
				} else if (data.t === "call" && typeof data.id === "number") answer(data.id, String(data.m), data.a);
			};
			async function answer(id, m, a) {
				try {
					let v;
					if (m === "invoke") {
						const arg = a;
						const args = [...arg.args ?? []];
						const token = arg.withSignal;
						if (typeof token === "string") {
							const controller = new AbortController();
							controllers.set(token, controller);
							args.push(controller.signal);
						}
						try {
							v = await registry.invoke(arg.kind, arg.localId, arg.member, args);
						} finally {
							if (typeof token === "string") controllers.delete(token);
						}
					} else if (m === "abort") {
						const token = a?.token;
						if (typeof token === "string") controllers.get(token)?.abort();
					} else if (m === "dispose") {
						surfaceAbort.abort();
						await surface?.dispose?.();
						surface = null;
					} else if (m === "ping") {} else if (m === "deactivate") v = await mod.deactivate?.();
					else throw new Error(`unknown call: ${m}`);
					post({
						t: "res",
						id,
						ok: true,
						v: v ?? null
					});
				} catch (error) {
					const r = toReport("call", error);
					post({
						t: "res",
						id,
						ok: false,
						code: "Internal",
						msg: r.message
					});
				}
			}
			try {
				mod = await deps.importModule(init.url);
			} catch (error) {
				reportError(toReport("import", error));
				return;
			}
			try {
				const ctx = {
					...init.ctx,
					container: deps.doc.body,
					signal: surfaceAbort.signal,
					setTitle: (title) => {
						deps.doc.title = String(title);
					},
					onDidChangeVisibility: (listener) => mirror.on("visibility", (v) => listener(v === true))
				};
				if (init.role === "background") {
					const api = await mod.activate?.(host);
					const paths = apiPaths(api);
					if (paths.length > 0) {
						registry.setApi(api);
						await request("extensions.getApi", { publish: paths });
					}
				} else if (init.role === "editor") surface = await mod.openEditor?.(ctx, host);
				else if (init.role === "view") surface = await mod.resolveView?.(ctx, host);
				else surface = await mod.renderPreview?.(ctx, host);
			} catch (error) {
				reportError(toReport(init.role === "background" ? "activate" : "surface", error));
				return;
			}
			post({
				t: "rep",
				kind: "ready",
				v: null
			});
		}
		deps.win.addEventListener("message", onMessage);
		return () => {
			deps.win.removeEventListener("message", onMessage);
			removeErrors?.();
		};
	}
	// packages/frame-runtime/src/index.ts
	startFrame({
		win: window,
		doc: document,
		importModule: (url) => import(
			/* @vite-ignore */
			url
)
	});
})();

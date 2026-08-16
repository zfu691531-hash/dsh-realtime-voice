window.__ModuleLoader__.load({
	id: "dsh-realtime-voice",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/harness-delegate.ts
		var HarnessBridge = class {
			api;
			promptTimeoutMs;
			setVoiceContext;
			streamAbort = new AbortController();
			streamStarted = false;
			subscribed = /* @__PURE__ */ new Set();
			readyWaiters = /* @__PURE__ */ new Map();
			operations = /* @__PURE__ */ new Map();
			recentFrames = /* @__PURE__ */ new Map();
			reservations = /* @__PURE__ */ new Set();
			observers = /* @__PURE__ */ new Map();
			constructor(api, promptTimeoutMs = 3e4, setVoiceContext = updateVoiceContext) {
				this.api = api;
				this.promptTimeoutMs = promptTimeoutMs;
				this.setVoiceContext = setVoiceContext;
			}
			async delegate(sessionId, task, signal, callbacks = {}) {
				if (callbacks.voiceOutputContract !== true) return await this.delegateCore(sessionId, task, signal, callbacks);
				if (this.reservations.has(sessionId) || this.operations.has(sessionId)) return {
					ok: false,
					error: "该会话已有一个语音委派任务在执行"
				};
				try {
					await this.setVoiceContext(sessionId, true, signal);
					return await this.delegateCore(sessionId, task, signal, callbacks);
				} catch (error) {
					if (signal?.aborted === true) return {
						ok: false,
						cancelled: true,
						error: "已取消"
					};
					return {
						ok: false,
						error: `语音输出上下文注入失败：${error instanceof Error ? error.message : String(error)}`
					};
				} finally {
					try {
						await this.setVoiceContext(sessionId, false);
					} catch {}
				}
			}
			async setVoiceMode(sessionId, active, signal) {
				await this.setVoiceContext(sessionId, active, signal);
			}
			observeSession(sessionId, callbacks) {
				this.startStream();
				const observer = {
					callbacks,
					lastAssistantText: ""
				};
				this.observers.set(sessionId, observer);
				return () => {
					if (this.observers.get(sessionId) === observer) this.observers.delete(sessionId);
				};
			}
			async delegateCore(sessionId, task, signal, callbacks = {}) {
				if (this.reservations.has(sessionId) || this.operations.has(sessionId)) return {
					ok: false,
					error: "该会话已有一个语音委派任务在执行"
				};
				this.reservations.add(sessionId);
				let response;
				let cancelRequested = false;
				const requestCancel = () => {
					cancelRequested = true;
					if (this.operations.has(sessionId)) this.cancel(sessionId);
				};
				try {
					this.startStream();
					await this.waitUntilSubscribed(sessionId, signal);
					if (signal?.aborted === true) return {
						ok: false,
						cancelled: true,
						error: "已取消"
					};
					signal?.addEventListener("abort", requestCancel, { once: true });
					const promptAbort = new AbortController();
					const abortForDispose = () => promptAbort.abort(this.streamAbort.signal.reason);
					const timeout = setTimeout(() => promptAbort.abort(/* @__PURE__ */ new Error("Harness prompt 准入超时")), this.promptTimeoutMs);
					this.streamAbort.signal.addEventListener("abort", abortForDispose, { once: true });
					try {
						response = await this.api.sessions.prompt({
							sessionId,
							mode: "queue",
							content: [{
								type: "text",
								text: task
							}],
							clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
						}, promptAbort.signal);
					} catch (error) {
						if (cancelRequested) return {
							ok: false,
							cancelled: true,
							error: "已取消"
						};
						if (this.streamAbort.signal.aborted) return {
							ok: false,
							cancelled: true,
							error: "插件已卸载"
						};
						return {
							ok: false,
							error: error instanceof Error ? error.message : String(error)
						};
					} finally {
						clearTimeout(timeout);
						this.streamAbort.signal.removeEventListener("abort", abortForDispose);
					}
					if (!response.result.ok) {
						if (cancelRequested) return {
							ok: false,
							cancelled: true,
							error: "已取消"
						};
						return {
							ok: false,
							error: `${response.result.error.code}: ${response.result.error.message}`
						};
					}
				} finally {
					this.reservations.delete(sessionId);
				}
				return await new Promise((resolve) => {
					const timer = setTimeout(() => this.finish(sessionId, {
						ok: false,
						error: "Harness 任务等待超时"
					}), 6e5);
					const operation = {
						sessionId,
						rpcId: response.rpcId,
						phase: "pending",
						lastAssistantText: "",
						cancelRequested,
						onTextDelta: callbacks.onTextDelta,
						onTextReset: callbacks.onTextReset,
						settle: resolve,
						timer
					};
					this.operations.set(sessionId, operation);
					for (const frame of [...this.recentFrames.get(sessionId) ?? []]) this.consumeFrame(frame, false);
					if (cancelRequested || signal?.aborted === true) this.cancel(sessionId);
				});
			}
			async cancel(sessionId) {
				const operation = this.operations.get(sessionId);
				if (operation === void 0) return false;
				operation.cancelRequested = true;
				if (operation.phase === "active") {
					await this.expectOk(await this.api.sessions.cancel({ sessionId }));
					return true;
				}
				if (operation.queueItemId !== void 0) {
					const removed = await this.api.sessions.updateQueue({
						sessionId,
						itemId: operation.queueItemId,
						action: { kind: "remove" }
					});
					if (!removed.result.ok && removed.result.error.code !== "queue-item-not-found") throw new Error(`${removed.result.error.code}: ${removed.result.error.message}`);
					if (!removed.result.ok) await this.expectOk(await this.api.sessions.cancel({ sessionId }));
					else this.finish(sessionId, {
						ok: false,
						cancelled: true,
						error: "已取消"
					});
				}
				return true;
			}
			dispose() {
				this.streamAbort.abort();
				for (const sessionId of [...this.operations.keys()]) this.finish(sessionId, {
					ok: false,
					cancelled: true,
					error: "插件已卸载"
				});
				this.observers.clear();
			}
			/** Public for deterministic tests; production frames arrive from events.mux. */
			handleFrame(frame) {
				this.consumeFrame(frame, true);
			}
			consumeFrame(frame, record) {
				if (record && "sessionId" in frame && typeof frame.sessionId === "string" && frame.type !== "session/subscribed") {
					const recent = this.recentFrames.get(frame.sessionId) ?? [];
					recent.push(frame);
					if (recent.length > 100) recent.shift();
					this.recentFrames.set(frame.sessionId, recent);
				}
				if (frame.type === "session/subscribed") {
					this.subscribed.add(frame.sessionId);
					this.readyWaiters.get(frame.sessionId)?.splice(0).forEach((resolve) => resolve());
					return;
				}
				if (frame.type === "session/queue") return this.handleQueue(frame.sessionId, frame.items);
				if (frame.type === "session/event") this.handleEvent(frame.sessionId, frame.event);
			}
			startStream() {
				if (this.streamStarted) return;
				this.streamStarted = true;
				(async () => {
					while (!this.streamAbort.signal.aborted) {
						try {
							for await (const request of this.api.events.mux({}, this.streamAbort.signal)) this.handleFrame(request.payload);
						} catch {
							if (this.streamAbort.signal.aborted) return;
						}
						this.subscribed.clear();
						await abortableDelay(100, this.streamAbort.signal);
					}
				})();
			}
			waitUntilSubscribed(sessionId, signal) {
				if (this.subscribed.has(sessionId)) return Promise.resolve();
				return new Promise((resolve, reject) => {
					const timeout = setTimeout(() => reject(/* @__PURE__ */ new Error("Harness 事件流订阅超时")), 1e4);
					const done = () => {
						clearTimeout(timeout);
						resolve();
					};
					const list = this.readyWaiters.get(sessionId) ?? [];
					list.push(done);
					this.readyWaiters.set(sessionId, list);
					signal?.addEventListener("abort", () => {
						clearTimeout(timeout);
						resolve();
					}, { once: true });
				});
			}
			handleQueue(sessionId, items) {
				const operation = this.operations.get(sessionId);
				if (operation === void 0 || operation.phase !== "pending") return;
				const item = items.find((candidate) => candidate.message.source?.rpcId === operation.rpcId);
				if (item !== void 0) {
					operation.queueItemId = item.id;
					if (operation.cancelRequested) this.cancel(sessionId);
				}
			}
			handleEvent(sessionId, event) {
				this.handleObservedEvent(sessionId, event);
				const operation = this.operations.get(sessionId);
				if (operation === void 0) return;
				const turn = stringField(event.data, "turn");
				if (event.type === "turn/start" && turn !== void 0) operation.openTurn = turn;
				if (event.type === "user/message") {
					if (objectField(event.data, "source")?.rpcId === operation.rpcId) {
						operation.turn = turn ?? operation.openTurn;
						operation.phase = "active";
						operation.queueItemId = void 0;
						if (operation.cancelRequested) this.cancel(sessionId);
					}
				}
				if (event.type === "assistant/message" && turn === operation.turn) {
					const text = extractAssistantText(event.data?.message);
					if (text !== "") operation.lastAssistantText = text;
				}
				if (event.type === "assistant/chunk" && turn === operation.turn) {
					const chunk = objectField(event.data, "chunk");
					if (chunk?.type === "text-delta" && typeof chunk.text === "string" && chunk.text !== "") try {
						operation.onTextDelta?.(chunk.text);
					} catch {}
					else if (isToolChunk(chunk)) {
						operation.lastAssistantText = "";
						try {
							operation.onTextReset?.();
						} catch {}
					}
				}
				if (event.type === "tool/call" && turn === operation.turn) {
					operation.lastAssistantText = "";
					try {
						operation.onTextReset?.();
					} catch {}
				}
				if ((event.type === "llm/retry" || event.type === "llm/retry-started") && turn === operation.turn) {
					operation.lastAssistantText = "";
					try {
						operation.onTextReset?.();
					} catch {}
				}
				if (event.type === "turn/end" && turn === operation.turn) {
					const reason = objectField(event.data, "reason");
					const kind = typeof reason?.kind === "string" ? reason.kind : typeof event.data?.reason === "string" ? event.data.reason : "completed";
					if (kind === "completed") this.finish(sessionId, {
						ok: true,
						text: operation.lastAssistantText || "任务已完成。"
					});
					else if (kind === "aborted" || kind === "interrupted") this.finish(sessionId, {
						ok: false,
						cancelled: true,
						error: "已取消"
					});
					else this.finish(sessionId, {
						ok: false,
						error: `Harness 任务结束：${kind}`
					});
				}
			}
			handleObservedEvent(sessionId, event) {
				const observer = this.observers.get(sessionId);
				if (observer === void 0) return;
				const turn = stringField(event.data, "turn");
				if (event.type === "turn/start" && turn !== void 0) observer.openTurn = turn;
				if (event.type === "user/message") {
					if (objectField(event.data, "source")?.kind !== "user") return;
					const activeTurn = turn ?? observer.openTurn;
					if (activeTurn !== void 0) {
						observer.activeTurn = activeTurn;
						observer.lastAssistantText = "";
						observer.callbacks.onTurnStart(activeTurn);
					}
					return;
				}
				if (turn === void 0 || turn !== observer.activeTurn) return;
				if (event.type === "llm/retry" || event.type === "llm/retry-started") {
					observer.lastAssistantText = "";
					observer.callbacks.onTextReset?.(turn);
					return;
				}
				if (event.type === "assistant/chunk") {
					const chunk = objectField(event.data, "chunk");
					if (chunk?.type === "text-delta" && typeof chunk.text === "string" && chunk.text !== "") observer.callbacks.onTextDelta(turn, chunk.text);
					else if (isToolChunk(chunk)) {
						observer.lastAssistantText = "";
						observer.callbacks.onTextReset?.(turn);
					}
					return;
				}
				if (event.type === "tool/call") {
					observer.lastAssistantText = "";
					observer.callbacks.onTextReset?.(turn);
					return;
				}
				if (event.type === "assistant/message") {
					const text = extractAssistantText(event.data?.message);
					if (text !== "") observer.lastAssistantText = text;
					return;
				}
				if (event.type !== "turn/end") return;
				const reason = objectField(event.data, "reason");
				const kind = typeof reason?.kind === "string" ? reason.kind : typeof event.data?.reason === "string" ? event.data.reason : "completed";
				const result = kind === "completed" ? {
					ok: true,
					text: observer.lastAssistantText || "任务已完成。"
				} : kind === "aborted" || kind === "interrupted" ? {
					ok: false,
					cancelled: true,
					error: "已取消"
				} : {
					ok: false,
					error: `Harness 任务结束：${kind}`
				};
				observer.callbacks.onTurnEnd(turn, result);
				observer.activeTurn = void 0;
				observer.openTurn = void 0;
				observer.lastAssistantText = "";
			}
			finish(sessionId, result) {
				const operation = this.operations.get(sessionId);
				if (operation === void 0) return;
				operation.phase = result.ok ? "done" : result.cancelled === true ? "cancelled" : "done";
				clearTimeout(operation.timer);
				this.operations.delete(sessionId);
				operation.settle(result);
			}
			async expectOk(result) {
				if (!result.result.ok) throw new Error(`${result.result.error.code}: ${result.result.error.message}`);
			}
		};
		async function updateVoiceContext(sessionId, active, signal) {
			const response = await fetch("/dsh-realtime-voice/context", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					sessionId,
					active
				}),
				signal
			});
			if (!response.ok) {
				const body = await response.text();
				throw new Error(body || `HTTP ${response.status}`);
			}
		}
		async function abortableDelay(ms, signal) {
			if (signal.aborted) return;
			await new Promise((resolve) => {
				const timer = setTimeout(done, ms);
				function done() {
					clearTimeout(timer);
					signal.removeEventListener("abort", done);
					resolve();
				}
				signal.addEventListener("abort", done, { once: true });
			});
		}
		function extractAssistantText(message) {
			if (typeof message === "string") return message.trim();
			if (typeof message !== "object" || message === null) return "";
			const record = message;
			if (!Array.isArray(record.content)) return typeof record.text === "string" ? record.text.trim() : "";
			return record.content.map((part) => {
				if (typeof part !== "object" || part === null) return "";
				const block = part;
				return block.type === "text" && typeof block.text === "string" ? block.text : "";
			}).join("\n").trim();
		}
		function objectField(value, key) {
			if (typeof value !== "object" || value === null) return void 0;
			const nested = value[key];
			return typeof nested === "object" && nested !== null ? nested : void 0;
		}
		function isToolChunk(chunk) {
			return chunk?.type === "tool-call-delta" || chunk?.type === "block-start" && chunk.blockType === "tool-call";
		}
		function stringField(value, key) {
			if (typeof value !== "object" || value === null) return void 0;
			const nested = value[key];
			return typeof nested === "string" ? nested : typeof nested === "number" ? String(nested) : void 0;
		}
		//#endregion
		//#region src/client/floor-manager.ts
		const DEFAULT_ACK = "嗯，我认真想一下。";
		/**
		* A latency race, not a second answering agent. Harness remains the only
		* reasoning writer; this manager may emit at most one non-committal cue while
		* the first visible result token is still absent.
		*/
		var FloorManager = class {
			delayMs;
			emit;
			timer;
			resultStarted = false;
			disposed = false;
			constructor(delayMs, emit) {
				this.delayMs = delayMs;
				this.emit = emit;
			}
			start(task = "") {
				this.cancelTimer();
				this.resultStarted = false;
				this.disposed = false;
				const cue = floorAcknowledgement(task);
				this.timer = setTimeout(() => {
					this.timer = void 0;
					if (!this.disposed && !this.resultStarted) this.emit(cue);
				}, this.delayMs);
			}
			resultAvailable() {
				this.resultStarted = true;
				this.cancelTimer();
			}
			dispose() {
				this.disposed = true;
				this.cancelTimer();
			}
			cancelTimer() {
				if (this.timer !== void 0) clearTimeout(this.timer);
				this.timer = void 0;
			}
		};
		function floorAcknowledgement(task) {
			const normalized = task.replace(/\s+/g, "");
			if (/(对比|比较|选哪个|哪个好|区别|优缺点)/.test(normalized)) return "好，我先帮你理一理。";
			if (/(查|搜索|天气|新闻|资料|附近|哪里|几点|价格)/.test(normalized)) return "嗯，我先查一下。";
			if (/(写|改|修|安装|创建|生成|处理|执行|操作)/.test(normalized)) return "好，我来处理。";
			if (/(计划|规划|分析|为什么|怎么办|怎么练|怎么做|建议)/.test(normalized)) return DEFAULT_ACK;
			return "嗯，我想一下。";
		}
		//#endregion
		//#region src/client/prefs.ts
		const KEY = "dsh-realtime-voice:prefs:v1";
		const PREFS_URL = "/dsh-realtime-voice/prefs";
		const DEFAULTS = {
			provider: "qwen",
			qwenWorkspaceId: "",
			qwenRegion: "cn-beijing",
			qwenModel: "qwen3.5-omni-plus-realtime",
			qwenVoice: "Tina",
			qwenAsrModel: "qwen3-asr-flash-realtime",
			qwenTtsModel: "qwen3-tts-flash-realtime",
			qwenTtsVoice: "Chelsie",
			qwenVadThreshold: .85,
			qwenSilenceMs: 700,
			qwenMergeMs: 1200,
			floorDelayMs: 800,
			openaiModel: "gpt-realtime-2.1",
			openaiVoice: "marin",
			instructions: "请用自然、简洁、适合口语播报的中文表达，并允许用户随时打断。"
		};
		let cache;
		const listeners = /* @__PURE__ */ new Set();
		function loadPrefs() {
			if (cache !== void 0) return cache;
			try {
				const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}");
				cache = sanitize({
					...DEFAULTS,
					...parsed
				});
			} catch {
				cache = { ...DEFAULTS };
			}
			return cache;
		}
		function updatePrefs(patch) {
			cache = sanitize({
				...loadPrefs(),
				...patch
			});
			localStorage.setItem(KEY, JSON.stringify(cache));
			persistPrefs(cache);
			listeners.forEach((listener) => listener());
			return cache;
		}
		/** Push the current prefs to the host bridge so they survive browser switches and port changes. */
		function persistPrefs(prefs) {
			try {
				fetch(PREFS_URL, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(prefs),
					cache: "no-store"
				}).catch(() => {});
			} catch {}
		}
		function hasCustomPrefs(prefs) {
			return prefs.provider !== "qwen" || prefs.qwenWorkspaceId !== "" || prefs.qwenModel !== DEFAULTS.qwenModel || prefs.qwenVoice !== DEFAULTS.qwenVoice || prefs.qwenAsrModel !== DEFAULTS.qwenAsrModel || prefs.qwenTtsModel !== DEFAULTS.qwenTtsModel || prefs.qwenTtsVoice !== DEFAULTS.qwenTtsVoice || prefs.qwenVadThreshold !== DEFAULTS.qwenVadThreshold || prefs.qwenSilenceMs !== DEFAULTS.qwenSilenceMs || prefs.qwenMergeMs !== DEFAULTS.qwenMergeMs || prefs.floorDelayMs !== DEFAULTS.floorDelayMs || prefs.openaiModel !== DEFAULTS.openaiModel || prefs.openaiVoice !== DEFAULTS.openaiVoice || prefs.instructions !== DEFAULTS.instructions;
		}
		/**
		* One-shot hydration: pull prefs persisted on the host (settings document) and
		* merge them over localStorage. When the host has nothing yet but this browser
		* already has custom values (pre-fix state), push them up so they are saved.
		*/
		function hydrateFromHost() {
			fetch(PREFS_URL, {
				cache: "no-store",
				headers: { accept: "application/json" }
			}).then((response) => response.ok ? response.json() : null).then((data) => {
				const local = loadPrefs();
				if (data && data.hasUserData && typeof data.prefs === "object" && data.prefs !== null) {
					cache = sanitize({
						...local,
						...data.prefs
					});
					localStorage.setItem(KEY, JSON.stringify(cache));
					listeners.forEach((listener) => listener());
				} else if (hasCustomPrefs(local)) persistPrefs(local);
			}).catch(() => {});
		}
		function subscribePrefs(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
		function sanitize(value) {
			return {
				provider: value.provider === "openai" ? "openai" : "qwen",
				qwenWorkspaceId: text(value.qwenWorkspaceId, 128),
				qwenRegion: value.qwenRegion === "ap-southeast-1" ? "ap-southeast-1" : "cn-beijing",
				qwenModel: text(value.qwenModel, 128) || DEFAULTS.qwenModel,
				qwenVoice: text(value.qwenVoice, 128) || DEFAULTS.qwenVoice,
				qwenAsrModel: text(value.qwenAsrModel, 128) || DEFAULTS.qwenAsrModel,
				qwenTtsModel: text(value.qwenTtsModel, 128) || DEFAULTS.qwenTtsModel,
				qwenTtsVoice: text(value.qwenTtsVoice, 128) || DEFAULTS.qwenTtsVoice,
				qwenVadThreshold: numberInRange(value.qwenVadThreshold, -1, 1, DEFAULTS.qwenVadThreshold),
				qwenSilenceMs: numberInRange(value.qwenSilenceMs, 200, 6e3, DEFAULTS.qwenSilenceMs),
				qwenMergeMs: numberInRange(value.qwenMergeMs, 100, 5e3, DEFAULTS.qwenMergeMs),
				floorDelayMs: numberInRange(value.floorDelayMs, 400, 3e3, DEFAULTS.floorDelayMs),
				openaiModel: text(value.openaiModel, 128) || DEFAULTS.openaiModel,
				openaiVoice: text(value.openaiVoice, 128) || DEFAULTS.openaiVoice,
				instructions: text(value.instructions, 12e3) || DEFAULTS.instructions
			};
		}
		function numberInRange(value, min, max, fallback) {
			return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
		}
		function text(value, max) {
			return typeof value === "string" ? value.slice(0, max) : "";
		}
		//#endregion
		//#region src/client/protocol.ts
		const HARNESS_FIRST_POLICY = `
你是 DeepSeek Harness 的实时语音输入输出层，不是独立回答问题的助手。
对用户的每一次有效发言，无论是闲聊、知识问答、天气查询、电脑操作还是多步骤任务，你的第一步且唯一允许的处理方式都是调用 delegate_to_harness。
调用时必须把用户原意完整、忠实地写入 task；不得自行回答、搜索、推理、执行工具或省略用户要求。
收到 delegate_to_harness 的结果后，只朗读工具输出中的自然语言内容，不补充、不改写、不总结，也不要再次调用工具。
`.trim();
		function sessionUpdate(prefs) {
			const functions = [{
				name: "delegate_to_harness",
				description: "必须对用户每一次有效发言调用。把完整原意交给当前 DeepSeek Harness 会话，由 Harness 统一完成推理、记忆、搜索、插件和工具调度。",
				parameters: {
					type: "object",
					properties: { task: {
						type: "string",
						description: "完整、忠实、可执行的用户原意；不要自行回答或删改"
					} },
					required: ["task"],
					additionalProperties: false
				}
			}];
			const instructions = `${prefs.instructions.trim()}\n\n${HARNESS_FIRST_POLICY}`.trim();
			if (prefs.provider === "openai") return {
				type: "session.update",
				session: {
					type: "realtime",
					instructions,
					output_modalities: ["audio"],
					audio: {
						input: { turn_detection: {
							type: "semantic_vad",
							eagerness: "auto",
							create_response: true,
							interrupt_response: true
						} },
						output: { voice: prefs.openaiVoice }
					},
					tools: functions.map((fn) => ({
						type: "function",
						...fn
					})),
					tool_choice: "required"
				}
			};
			return {
				type: "session.update",
				session: {
					modalities: ["text", "audio"],
					instructions,
					voice: prefs.qwenVoice,
					input_audio_transcription: {
						model: "qwen3-asr-flash-realtime",
						language: "zh"
					},
					turn_detection: {
						type: "server_vad",
						threshold: .5,
						silence_duration_ms: 450,
						create_response: true
					},
					tools: functions.map((fn) => ({
						type: "function",
						function: fn
					})),
					tool_choice: "auto"
				}
			};
		}
		function parseToolCall(event) {
			if (typeof event !== "object" || event === null) return void 0;
			const record = event;
			if (record.type === "response.function_call_arguments.done") {
				if (record.name !== "delegate_to_harness" && record.name !== "cancel_harness_task") return void 0;
				if (typeof record.call_id !== "string") return void 0;
				return {
					callId: record.call_id,
					name: record.name,
					arguments: typeof record.arguments === "string" ? record.arguments : "{}"
				};
			}
			const item = record.type === "response.output_item.done" ? record.item : record.type === "conversation.item.created" ? record.item : void 0;
			if (typeof item !== "object" || item === null) return void 0;
			const call = item;
			if (call.type !== "function_call") return void 0;
			if (call.name !== "delegate_to_harness" && call.name !== "cancel_harness_task") return void 0;
			const callId = typeof call.call_id === "string" ? call.call_id : typeof call.id === "string" ? call.id : void 0;
			if (callId === void 0) return void 0;
			return {
				callId,
				name: call.name,
				arguments: typeof call.arguments === "string" ? call.arguments : "{}"
			};
		}
		function toolOutput(callId, output) {
			return [{
				type: "conversation.item.create",
				item: {
					type: "function_call_output",
					call_id: callId,
					output: normalizeHarnessOutput(output)
				}
			}, { type: "response.create" }];
		}
		function normalizeHarnessOutput(output) {
			if (typeof output === "object" && output !== null) {
				const result = output;
				if (result.ok === true && typeof result.text === "string" && result.text.trim() !== "") return result.text;
				if (result.cancelled === true) return "任务已取消。";
				if (typeof result.error === "string" && result.error.trim() !== "") return `Harness 执行失败：${result.error}`;
			}
			return typeof output === "string" ? output : JSON.stringify(output);
		}
		//#endregion
		//#region src/client/realtime.ts
		var RealtimeConnection = class {
			prefs;
			callbacks;
			peer;
			channel;
			inboundChannel;
			microphone;
			microphoneTrack;
			audioSender;
			audio;
			seenCalls = /* @__PURE__ */ new Set();
			sessionCreated = false;
			updateSent = false;
			responseActive = false;
			constructor(prefs, callbacks) {
				this.prefs = prefs;
				this.callbacks = callbacks;
			}
			async connect() {
				this.callbacks.onState("connecting");
				if (this.prefs.provider === "qwen" && this.prefs.qwenWorkspaceId.trim() === "") throw new Error("请先在插件设置中填写阿里云百炼 Workspace ID");
				if (navigator.mediaDevices?.getUserMedia === void 0) throw new Error("当前页面无法访问麦克风，请用 Chrome 打开此 Harness 地址");
				this.microphone = await navigator.mediaDevices.getUserMedia({ audio: {
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true,
					channelCount: 1
				} });
				const peer = new RTCPeerConnection({ iceServers: [] });
				this.peer = peer;
				const track = this.microphone.getAudioTracks()[0];
				if (track === void 0) throw new Error("没有可用的麦克风音轨");
				this.microphoneTrack = track;
				this.audioSender = peer.addTrack(track, this.microphone);
				await this.audioSender.replaceTrack(null);
				this.audio = document.createElement("audio");
				this.audio.autoplay = true;
				this.audio.style.display = "none";
				document.body.appendChild(this.audio);
				peer.ontrack = (event) => {
					if (this.audio !== void 0) this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
				};
				peer.onconnectionstatechange = () => {
					if (peer.connectionState === "failed" || peer.connectionState === "disconnected") this.callbacks.onState("error", `WebRTC ${peer.connectionState}`);
				};
				peer.ondatachannel = (event) => {
					this.inboundChannel = event.channel;
					event.channel.onmessage = (message) => {
						this.handleEvent(message.data);
					};
				};
				const channel = peer.createDataChannel("oai-events");
				this.channel = channel;
				channel.onmessage = (event) => {
					this.handleEvent(event.data);
				};
				channel.onopen = () => {
					this.maybeSendSessionUpdate();
				};
				const offer = await peer.createOffer();
				await peer.setLocalDescription(offer);
				await waitForIce(peer, 3e3);
				const localSdp = peer.localDescription?.sdp;
				if (localSdp === void 0) throw new Error("无法生成 WebRTC SDP");
				const payload = {
					sdp: localSdp,
					instructions: this.prefs.instructions
				};
				if (this.prefs.provider === "openai") {
					payload.model = this.prefs.openaiModel;
					payload.voice = this.prefs.openaiVoice;
				} else {
					payload.model = this.prefs.qwenModel;
					payload.voice = this.prefs.qwenVoice;
					payload.workspaceId = this.prefs.qwenWorkspaceId;
					payload.region = this.prefs.qwenRegion;
				}
				const response = await fetch(`/dsh-realtime-voice/signaling/${this.prefs.provider}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload)
				});
				if (!response.ok) {
					const error = await response.json().catch(() => ({ error: response.statusText }));
					throw new Error(error.error ?? `信令失败：${response.status}`);
				}
				await peer.setRemoteDescription({
					type: "answer",
					sdp: normalizeSdp(await response.text())
				});
			}
			disconnect() {
				try {
					this.send({ type: "response.cancel" });
				} catch {}
				this.channel?.close();
				this.inboundChannel?.close();
				this.peer?.close();
				this.microphone?.getTracks().forEach((track) => track.stop());
				this.audio?.remove();
				this.channel = void 0;
				this.inboundChannel = void 0;
				this.peer = void 0;
				this.microphone = void 0;
				this.microphoneTrack = void 0;
				this.audioSender = void 0;
				this.audio = void 0;
				this.seenCalls.clear();
				this.sessionCreated = false;
				this.updateSent = false;
				this.responseActive = false;
			}
			async handleEvent(raw) {
				let event;
				try {
					event = typeof raw === "string" ? JSON.parse(raw) : raw;
				} catch {
					return;
				}
				const type = typeof event === "object" && event !== null ? event.type : void 0;
				if (type === "session.created") {
					this.sessionCreated = true;
					this.maybeSendSessionUpdate();
				}
				if (type === "session.updated") {
					if (this.audioSender !== void 0 && this.microphoneTrack !== void 0) await this.audioSender.replaceTrack(this.microphoneTrack);
					this.callbacks.onState("listening");
				}
				if (type === "input_audio_buffer.speech_started") {
					if (this.responseActive) this.send({ type: "response.cancel" });
					this.callbacks.onState("listening");
				}
				if (type === "response.created") this.responseActive = true;
				if (type === "response.audio.delta" || type === "response.audio_transcript.delta") this.callbacks.onState("speaking");
				if (type === "response.done") {
					this.responseActive = false;
					this.callbacks.onState("listening");
				}
				if (type === "error") {
					const detail = JSON.stringify(event.error ?? event).slice(0, 500);
					this.callbacks.onState("error", detail);
				}
				const call = parseToolCall(event);
				if (call === void 0 || this.seenCalls.has(call.callId)) return;
				this.seenCalls.add(call.callId);
				try {
					const output = await this.callbacks.onToolCall(call);
					for (const outbound of toolOutput(call.callId, output)) this.send(outbound);
				} catch (error) {
					for (const outbound of toolOutput(call.callId, {
						ok: false,
						error: error instanceof Error ? error.message : String(error)
					})) this.send(outbound);
				}
			}
			send(event) {
				if (this.channel?.readyState !== "open") return;
				this.channel.send(JSON.stringify(event));
			}
			maybeSendSessionUpdate() {
				if (!this.sessionCreated || this.updateSent || this.channel?.readyState !== "open") return;
				this.updateSent = true;
				this.send(sessionUpdate(this.prefs));
			}
		};
		function normalizeSdp(sdp) {
			return sdp.replace(/\r?\n/g, "\r\n").replace(/(?:\r\n)*$/, "\r\n");
		}
		async function waitForIce(peer, timeoutMs) {
			if (peer.iceGatheringState === "complete") return;
			await new Promise((resolve) => {
				const timer = setTimeout(done, timeoutMs);
				function done() {
					clearTimeout(timer);
					peer.removeEventListener("icegatheringstatechange", changed);
					resolve();
				}
				function changed() {
					if (peer.iceGatheringState === "complete") done();
				}
				peer.addEventListener("icegatheringstatechange", changed);
			});
		}
		//#endregion
		//#region src/client/qwen-pipeline.ts
		var QwenPipelineConnection = class {
			prefs;
			callbacks;
			asr;
			tts;
			microphone;
			captureContext;
			captureSource;
			processor;
			silentGain;
			player = new PcmPlayer();
			ttsReady;
			resolveTtsReady;
			rejectTtsReady;
			speechResolve;
			speechReject;
			disposed = false;
			speechAudible = false;
			currentSpeechText = "";
			inputPhase = "listening";
			bargeInGate = new LocalBargeInGate();
			bargeInCandidate = false;
			bargeInTimer;
			ttsStartedAt = 0;
			ttsInterruptedForBargeIn = false;
			speechEpoch = 0;
			asrEventTail = Promise.resolve();
			quarantinedItems = /* @__PURE__ */ new Set();
			ignoredItems = /* @__PURE__ */ new Set();
			utteranceBusy = /* @__PURE__ */ new Map();
			asrRestarting = false;
			asrContaminated = false;
			constructor(prefs, callbacks) {
				this.prefs = prefs;
				this.callbacks = callbacks;
			}
			async connect() {
				this.callbacks.onState("connecting");
				if (this.prefs.qwenWorkspaceId.trim() === "") throw new Error("请先在插件设置中填写阿里云百炼 Workspace ID");
				if (navigator.mediaDevices?.getUserMedia === void 0) throw new Error("当前页面无法访问麦克风，请用 Chrome 打开此 Harness 地址");
				this.microphone = await navigator.mediaDevices.getUserMedia({ audio: {
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: false,
					channelCount: 1
				} });
				await this.openTts();
				await this.openAsr();
				this.startCapture();
			}
			async speak(text) {
				const epoch = this.speechEpoch;
				const chunks = splitForTts(text);
				if (chunks.length === 0 || this.disposed) return;
				if (this.tts?.readyState !== WebSocket.OPEN) await this.openTts();
				await this.ttsReady;
				if (this.speechEpoch !== epoch) throw new Error("语音已被替换");
				if (this.disposed || this.tts?.readyState !== WebSocket.OPEN) throw new Error("千问 TTS 连接已关闭");
				this.currentSpeechText = joinSpeechText(this.currentSpeechText, text);
				for (const chunk of chunks) {
					if (this.speechEpoch !== epoch) throw new Error("语音已被替换");
					if (this.disposed || this.tts?.readyState !== WebSocket.OPEN) throw new Error("千问 TTS 连接已关闭");
					await new Promise((resolve, reject) => {
						this.speechResolve = resolve;
						this.speechReject = reject;
						this.sendTts({
							type: "input_text_buffer.append",
							event_id: eventId(),
							text: chunk
						});
						this.sendTts({
							type: "input_text_buffer.commit",
							event_id: eventId()
						});
					});
				}
			}
			async waitForSpeechIdle() {
				await this.player.waitUntilIdle();
				this.speechAudible = false;
				this.currentSpeechText = "";
			}
			cancelSpeech() {
				this.speechEpoch++;
				if (this.isTtsActive() || this.speechResolve !== void 0 || this.speechReject !== void 0) this.interruptTts();
			}
			setInputPhase(phase) {
				if (this.inputPhase === phase) return;
				this.inputPhase = phase;
				if (phase === "tts-speaking") {
					this.ttsStartedAt = Date.now();
					this.ttsInterruptedForBargeIn = false;
					this.resetBargeIn(false);
					return;
				}
				if (phase === "post-playback") {
					if (this.bargeInCandidate) this.rejectFalseBargeIn();
					else {
						this.resetBargeIn(true);
						if (this.asrContaminated) this.restartAsr();
					}
					return;
				}
				if (phase === "listening" || phase === "harness" || phase === "tts-pending") this.resetBargeIn(false);
			}
			disconnect() {
				this.disposed = true;
				this.player.dispose();
				this.processor?.disconnect();
				this.captureSource?.disconnect();
				this.silentGain?.disconnect();
				this.captureContext?.close();
				this.microphone?.getTracks().forEach((track) => track.stop());
				finishAndClose(this.asr);
				finishAndClose(this.tts);
				this.asr = void 0;
				this.tts = void 0;
				this.speechReject?.(/* @__PURE__ */ new Error("语音连接已关闭"));
				this.speechResolve = void 0;
				this.speechReject = void 0;
				this.speechAudible = false;
				this.currentSpeechText = "";
				this.resetBargeIn(false);
				this.quarantinedItems.clear();
				this.ignoredItems.clear();
				this.utteranceBusy.clear();
			}
			async openAsr() {
				const socket = new WebSocket(proxyUrl("asr", this.prefs.qwenWorkspaceId, this.prefs.qwenRegion, this.prefs.qwenAsrModel));
				this.asr = socket;
				await opened(socket);
				socket.onmessage = (event) => {
					this.asrEventTail = this.asrEventTail.then(() => this.handleAsr(event.data), () => this.handleAsr(event.data));
				};
				socket.onerror = () => this.callbacks.onState("error", "千问专用 ASR 连接失败");
				socket.onclose = () => {
					if (this.asr !== socket) return;
					this.asr = void 0;
					if (!this.disposed) this.callbacks.onState("error", "千问专用 ASR 已断开");
				};
				this.sendAsr({
					type: "session.update",
					event_id: eventId(),
					session: {
						input_audio_format: "pcm",
						sample_rate: 16e3,
						input_audio_transcription: { language: "zh" },
						turn_detection: {
							type: "server_vad",
							threshold: this.prefs.qwenVadThreshold,
							silence_duration_ms: this.prefs.qwenSilenceMs
						}
					}
				});
			}
			async openTts() {
				if (this.tts?.readyState === WebSocket.OPEN || this.tts?.readyState === WebSocket.CONNECTING) return await this.ttsReady;
				this.ttsReady = new Promise((resolve, reject) => {
					this.resolveTtsReady = resolve;
					this.rejectTtsReady = reject;
				});
				const socket = new WebSocket(proxyUrl("tts", this.prefs.qwenWorkspaceId, this.prefs.qwenRegion, this.prefs.qwenTtsModel));
				this.tts = socket;
				socket.onmessage = (event) => this.handleTts(event.data);
				socket.onerror = () => this.rejectTtsReady?.(/* @__PURE__ */ new Error("千问专用 TTS 连接失败"));
				socket.onclose = () => {
					if (this.tts !== socket) return;
					this.tts = void 0;
					this.speechReject?.(/* @__PURE__ */ new Error("千问专用 TTS 已断开"));
					this.speechResolve = void 0;
					this.speechReject = void 0;
				};
				await opened(socket);
				await this.ttsReady;
			}
			startCapture() {
				if (this.microphone === void 0) return;
				const context = new AudioContext();
				const source = context.createMediaStreamSource(this.microphone);
				const processor = context.createScriptProcessor(2048, 1, 1);
				const silent = context.createGain();
				silent.gain.value = 0;
				processor.onaudioprocess = (event) => {
					if (this.asr?.readyState !== WebSocket.OPEN) return;
					const pcm = downsampleToPcm16(event.inputBuffer.getChannelData(0), context.sampleRate, 16e3);
					if (pcm.byteLength === 0 || this.asr.bufferedAmount > 524288) return;
					if (this.inputPhase === "post-playback") return;
					if (this.inputPhase === "tts-speaking") {
						if (!this.speechAudible && !this.player.isPlaying) return;
						const decision = this.bargeInGate.push(pcm, Date.now() - this.ttsStartedAt);
						if (!decision.forward) return;
						if (!this.bargeInCandidate) {
							this.bargeInCandidate = true;
							this.asrContaminated = true;
							this.player.pause();
							this.bargeInTimer = setTimeout(() => this.rejectFalseBargeIn(), 2200);
							for (const frame of decision.preRoll) this.appendAsr(frame);
							return;
						}
					} else this.bargeInGate.observe(pcm);
					this.appendAsr(pcm);
				};
				source.connect(processor);
				processor.connect(silent);
				silent.connect(context.destination);
				this.captureContext = context;
				this.captureSource = source;
				this.processor = processor;
				this.silentGain = silent;
			}
			async handleAsr(raw) {
				const event = jsonEvent(raw);
				if (event === void 0) return;
				const type = event.type;
				if (type === "session.updated") this.callbacks.onState("listening");
				if (type === "input_audio_buffer.speech_started") {
					const itemId = typeof event.item_id === "string" ? event.item_id : "";
					if (itemId !== "") {
						this.utteranceBusy.set(itemId, this.inputPhase !== "listening" && this.inputPhase !== "endpoint-candidate");
						if (this.bargeInCandidate) this.quarantinedItems.add(itemId);
					}
				}
				if (type === "conversation.item.input_audio_transcription.text" && this.bargeInCandidate) {
					const preview = `${typeof event.text === "string" ? event.text : ""}${typeof event.stash === "string" ? event.stash : ""}`.trim();
					if (isExplicitBargeIn(normalizeSpeech(preview)) && !isLikelyTtsEcho(preview, this.currentSpeechText)) this.interruptTts();
				}
				if (type === "conversation.item.input_audio_transcription.completed") {
					const transcript = typeof event.transcript === "string" ? event.transcript.trim() : "";
					const itemId = typeof event.item_id === "string" ? event.item_id : "";
					const capturedWhileBusy = itemId !== "" ? this.utteranceBusy.get(itemId) ?? (this.inputPhase !== "listening" && this.inputPhase !== "endpoint-candidate") : this.inputPhase !== "listening" && this.inputPhase !== "endpoint-candidate";
					if (itemId !== "") this.utteranceBusy.delete(itemId);
					if (itemId !== "" && this.ignoredItems.delete(itemId)) return;
					const quarantined = this.bargeInCandidate || itemId !== "" && this.quarantinedItems.delete(itemId);
					if (quarantined && (!isActionableTranscript(transcript) || isLikelyTtsEcho(transcript, this.currentSpeechText))) {
						this.rejectFalseBargeIn();
						return;
					}
					if (!isActionableTranscript(transcript)) return;
					if (quarantined) this.interruptTts();
					if (this.inputPhase === "post-playback" && !quarantined) return;
					await this.callbacks.onTranscript?.(transcript, { capturedWhileBusy });
				}
				if (type === "error") this.callbacks.onState("error", safeError(event));
			}
			handleTts(raw) {
				const event = jsonEvent(raw);
				if (event === void 0) return;
				if (event.type === "session.created") this.sendTts({
					type: "session.update",
					event_id: eventId(),
					session: {
						voice: this.prefs.qwenTtsVoice,
						mode: "commit",
						language_type: "Chinese",
						response_format: "pcm",
						sample_rate: 24e3
					}
				});
				if (event.type === "session.updated") {
					this.resolveTtsReady?.();
					this.resolveTtsReady = void 0;
					this.rejectTtsReady = void 0;
				}
				if (event.type === "response.audio.delta" && typeof event.delta === "string") {
					if (!this.speechAudible) {
						this.speechAudible = true;
						this.callbacks.onState("speaking");
					}
					this.player.enqueue(event.delta, 24e3);
				}
				if (event.type === "response.done") {
					this.speechResolve?.();
					this.speechResolve = void 0;
					this.speechReject = void 0;
				}
				if (event.type === "error") {
					const error = new Error(safeError(event));
					this.rejectTtsReady?.(error);
					this.speechReject?.(error);
					this.speechResolve = void 0;
					this.speechReject = void 0;
				}
			}
			isTtsActive() {
				return this.speechAudible || this.player.isPlaying;
			}
			interruptTts() {
				if (this.ttsInterruptedForBargeIn) return;
				this.ttsInterruptedForBargeIn = true;
				this.player.stop();
				const rejectSpeech = this.speechReject;
				this.speechResolve = void 0;
				this.speechReject = void 0;
				rejectSpeech?.(/* @__PURE__ */ new Error("语音播放已被用户打断"));
				const socket = this.tts;
				if (socket !== void 0) socket.close(1e3, "barge-in");
				this.tts = void 0;
				this.ttsReady = void 0;
				this.speechAudible = false;
				this.currentSpeechText = "";
				this.resetBargeIn(false);
				if (!this.disposed) this.openTts().catch((error) => this.callbacks.onState("error", error instanceof Error ? error.message : String(error)));
			}
			rejectFalseBargeIn() {
				if (!this.bargeInCandidate) return;
				for (const itemId of this.quarantinedItems) this.ignoredItems.add(itemId);
				this.quarantinedItems.clear();
				this.resetBargeIn(true);
				this.restartAsr();
			}
			resetBargeIn(resume) {
				if (this.bargeInTimer !== void 0) clearTimeout(this.bargeInTimer);
				this.bargeInTimer = void 0;
				this.bargeInCandidate = false;
				this.bargeInGate.reset();
				if (resume) this.player.resume();
			}
			appendAsr(pcm) {
				this.sendAsr({
					type: "input_audio_buffer.append",
					event_id: eventId(),
					audio: base64(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
				});
			}
			restartAsr() {
				if (this.disposed || this.asrRestarting) return;
				this.asrRestarting = true;
				this.asrContaminated = false;
				const socket = this.asr;
				this.asr = void 0;
				socket?.close(1e3, "reset contaminated input");
				this.openAsr().catch((error) => {
					if (!this.disposed) this.callbacks.onState("error", error instanceof Error ? error.message : String(error));
				}).finally(() => {
					this.asrRestarting = false;
				});
			}
			sendAsr(event) {
				this.asr?.send(JSON.stringify(event));
			}
			sendTts(event) {
				this.tts?.send(JSON.stringify(event));
			}
		};
		function isLikelyTtsEcho(transcript, speech) {
			const heard = normalizeSpeech(transcript);
			const spoken = normalizeSpeech(speech);
			if (heard.length < 3 || spoken.length < 3 || isExplicitBargeIn(heard)) return false;
			if (spoken.includes(heard)) return true;
			if (heard.length >= 6 && heard.includes(spoken)) return true;
			const shorter = Math.min(heard.length, spoken.length);
			if (shorter / Math.max(heard.length, spoken.length) < .25) return false;
			if (longestCommonSubstring(heard, spoken) / shorter >= .72) return true;
			return bigramDice(heard, spoken) >= .62;
		}
		function isExplicitBargeIn(normalized) {
			return /^(停|停止|停下|打住|别说了|等一下|等等|不对|取消|取消任务|不要了|算了)$/.test(normalized);
		}
		function normalizeSpeech(text) {
			return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
		}
		function joinSpeechText(existing, addition) {
			const clean = addition.trim();
			return existing === "" ? clean : clean === "" ? existing : `${existing} ${clean}`;
		}
		function longestCommonSubstring(left, right) {
			const row = new Uint16Array(right.length + 1);
			let longest = 0;
			for (let i = 1; i <= left.length; i++) for (let j = right.length; j >= 1; j--) {
				const value = left.charAt(i - 1) === right.charAt(j - 1) ? (row[j - 1] ?? 0) + 1 : 0;
				row[j] = value;
				if (value > longest) longest = value;
			}
			return longest;
		}
		function bigramDice(left, right) {
			if (left.length < 2 || right.length < 2) return left === right ? 1 : 0;
			const counts = /* @__PURE__ */ new Map();
			for (let index = 0; index < left.length - 1; index++) {
				const gram = left.slice(index, index + 2);
				counts.set(gram, (counts.get(gram) ?? 0) + 1);
			}
			let overlap = 0;
			for (let index = 0; index < right.length - 1; index++) {
				const gram = right.slice(index, index + 2);
				const count = counts.get(gram) ?? 0;
				if (count <= 0) continue;
				overlap++;
				counts.set(gram, count - 1);
			}
			return 2 * overlap / (left.length + right.length - 2);
		}
		var LocalBargeInGate = class {
			noiseFloor = .006;
			activeMs = 0;
			candidate = false;
			bufferedMs = 0;
			frames = [];
			observe(pcm) {
				const level = pcmRms(pcm);
				if (level < .05) this.noiseFloor = this.noiseFloor * .98 + level * .02;
			}
			push(pcm, playbackElapsedMs) {
				const durationMs = pcm.length / 16e3 * 1e3;
				this.frames.push({
					pcm: pcm.slice(),
					durationMs
				});
				this.bufferedMs += durationMs;
				while (this.bufferedMs > 850 && this.frames.length > 1) {
					const removed = this.frames.shift();
					if (removed !== void 0) this.bufferedMs -= removed.durationMs;
				}
				if (this.candidate) return {
					forward: true,
					preRoll: []
				};
				if (playbackElapsedMs < 350) return {
					forward: false,
					preRoll: []
				};
				const threshold = Math.max(.018, this.noiseFloor * 3.2);
				const level = pcmRms(pcm);
				this.activeMs = level >= threshold ? this.activeMs + durationMs : Math.max(0, this.activeMs - durationMs * 1.5);
				if (this.activeMs < 500) return {
					forward: false,
					preRoll: []
				};
				this.candidate = true;
				return {
					forward: true,
					preRoll: this.frames.map((frame) => frame.pcm)
				};
			}
			reset() {
				this.activeMs = 0;
				this.candidate = false;
				this.bufferedMs = 0;
				this.frames = [];
			}
		};
		function pcmRms(pcm) {
			if (pcm.length === 0) return 0;
			let sum = 0;
			for (let index = 0; index < pcm.length; index++) {
				const value = (pcm[index] ?? 0) / 32768;
				sum += value * value;
			}
			return Math.sqrt(sum / pcm.length);
		}
		var PcmPlayer = class {
			context;
			gain;
			nextStart = 0;
			sources = /* @__PURE__ */ new Set();
			idleWaiters = [];
			paused = false;
			get isPlaying() {
				return this.sources.size > 0;
			}
			enqueue(encoded, sampleRate) {
				const bytes = fromBase64(encoded);
				if (bytes.byteLength < 2) return;
				const context = this.context ??= new AudioContext();
				if (this.gain === void 0) {
					this.gain = context.createGain();
					this.gain.connect(context.destination);
				}
				const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
				const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
				for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(index * 2, true) / 32768;
				const buffer = context.createBuffer(1, samples.length, sampleRate);
				buffer.copyToChannel(samples, 0);
				const source = context.createBufferSource();
				source.buffer = buffer;
				source.connect(this.gain);
				const start = Math.max(context.currentTime + .02, this.nextStart);
				source.start(start);
				this.nextStart = start + buffer.duration;
				this.sources.add(source);
				source.onended = () => {
					this.sources.delete(source);
					this.resolveIdle();
				};
			}
			duck(enabled) {
				if (this.gain !== void 0 && this.context !== void 0) this.gain.gain.setTargetAtTime(enabled ? .25 : 1, this.context.currentTime, .03);
			}
			pause() {
				if (this.context === void 0 || this.paused) return;
				this.paused = true;
				this.context.suspend();
			}
			resume() {
				if (this.context === void 0 || !this.paused) return;
				this.paused = false;
				this.context.resume();
			}
			stop() {
				this.resume();
				for (const source of this.sources) try {
					source.stop();
				} catch {}
				this.sources.clear();
				this.nextStart = 0;
				this.duck(false);
				this.resolveIdle();
			}
			async waitUntilIdle() {
				if (this.sources.size === 0) return;
				await new Promise((resolve) => this.idleWaiters.push(resolve));
			}
			resolveIdle() {
				if (this.sources.size !== 0) return;
				this.idleWaiters.splice(0).forEach((resolve) => resolve());
			}
			dispose() {
				this.stop();
				this.context?.close();
				this.context = void 0;
				this.gain = void 0;
				this.paused = false;
			}
		};
		function proxyUrl(kind, workspaceId, region, model) {
			const protocol = location.protocol === "https:" ? "wss:" : "ws:";
			const query = new URLSearchParams({
				workspaceId,
				region,
				model
			});
			return `${protocol}//${location.host}/dsh-realtime-voice/${kind}/qwen?${query}`;
		}
		function opened(socket) {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					cleanup();
					try {
						socket.close();
					} catch {}
					reject(/* @__PURE__ */ new Error("本地语音代理连接超时"));
				}, 1e4);
				const onOpen = () => {
					cleanup();
					resolve();
				};
				const onError = () => {
					cleanup();
					reject(/* @__PURE__ */ new Error("本地语音代理连接失败"));
				};
				const cleanup = () => {
					clearTimeout(timer);
					socket.removeEventListener("open", onOpen);
					socket.removeEventListener("error", onError);
				};
				socket.addEventListener("open", onOpen, { once: true });
				socket.addEventListener("error", onError, { once: true });
			});
		}
		function finishAndClose(socket) {
			if (socket?.readyState !== WebSocket.OPEN) return socket?.close();
			socket.send(JSON.stringify({
				type: "session.finish",
				event_id: eventId()
			}));
			setTimeout(() => socket.close(1e3, "finished"), 200);
		}
		function jsonEvent(raw) {
			try {
				const value = JSON.parse(typeof raw === "string" ? raw : String(raw));
				return typeof value === "object" && value !== null ? value : void 0;
			} catch {
				return;
			}
		}
		function safeError(event) {
			const error = typeof event.error === "object" && event.error !== null ? event.error : event;
			return typeof error.message === "string" ? error.message.slice(0, 300) : "语音服务错误";
		}
		function eventId() {
			return `event_${crypto.randomUUID()}`;
		}
		function isActionableTranscript(text) {
			const normalized = text.replace(/[\s，。！？,.!?、]/g, "");
			return normalized !== "" && !/^(嗯+|啊+|呃+|额+|唔+|哦+|哈+)$/.test(normalized);
		}
		/** Keep only speakable prose and stay below Qwen's weighted text limit. */
		function splitForTts(text, maxWeight = 1e3) {
			const spoken = text.replace(/```[\s\S]*?```/g, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<\/?[^>]+>/g, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/https?:\/\/\S+/g, " ").replace(/[`*_#>|<]/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
			if (spoken === "") return [];
			const units = spoken.split(/(?<=[。！？!?；;：:\n])/u).map((value) => value.trim()).filter(Boolean);
			const chunks = [];
			let current = "";
			for (const unit of units) for (const part of splitWeighted(unit, maxWeight)) {
				const candidate = current === "" ? part : `${current}${needsSpace(current, part) ? " " : ""}${part}`;
				if (ttsWeight(candidate) <= maxWeight) current = candidate;
				else {
					if (current !== "") chunks.push(current);
					current = part;
				}
			}
			if (current !== "") chunks.push(current);
			return chunks;
		}
		function splitWeighted(text, maxWeight) {
			const output = [];
			let current = "";
			let weight = 0;
			for (const char of text) {
				const charWeight = isCjk(char) ? 2 : 1;
				if (current !== "" && weight + charWeight > maxWeight) {
					output.push(current);
					current = "";
					weight = 0;
				}
				current += char;
				weight += charWeight;
			}
			if (current !== "") output.push(current);
			return output;
		}
		function ttsWeight(text) {
			let weight = 0;
			for (const char of text) weight += isCjk(char) ? 2 : 1;
			return weight;
		}
		function isCjk(char) {
			return /[\u3400-\u9fff\uf900-\ufaff]/u.test(char);
		}
		function needsSpace(left, right) {
			return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
		}
		function downsampleToPcm16(input, inputRate, outputRate) {
			const ratio = inputRate / outputRate;
			const length = Math.floor(input.length / ratio);
			const output = new Int16Array(length);
			for (let index = 0; index < length; index++) {
				const start = Math.floor(index * ratio);
				const end = Math.max(start + 1, Math.floor((index + 1) * ratio));
				let sum = 0;
				for (let at = start; at < end && at < input.length; at++) sum += input[at] ?? 0;
				const sample = Math.max(-1, Math.min(1, sum / (end - start)));
				output[index] = sample < 0 ? sample * 32768 : sample * 32767;
			}
			return output;
		}
		function base64(buffer) {
			const bytes = new Uint8Array(buffer);
			let binary = "";
			for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
			return btoa(binary);
		}
		function fromBase64(value) {
			const binary = atob(value);
			const bytes = new Uint8Array(binary.length);
			for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
			return bytes;
		}
		//#endregion
		//#region src/client/turn-coordinator.ts
		/**
		* Owns voice turn identity and serializes every state-changing event. Audio,
		* Harness and TTS callbacks can arrive from unrelated transports; allowing
		* them to mutate the controller directly is what previously produced mixed
		* turns and stale playback.
		*/
		var TurnCoordinator = class {
			currentPhase = "listening";
			currentTurn = 0;
			tail = Promise.resolve();
			get phase() {
				return this.currentPhase;
			}
			get turnId() {
				return this.currentTurn;
			}
			begin() {
				this.currentTurn++;
				this.currentPhase = "harness";
				return this.currentTurn;
			}
			transition(turnId, phase) {
				if (turnId !== this.currentTurn) return false;
				this.currentPhase = phase;
				return true;
			}
			isCurrent(turnId) {
				return turnId === this.currentTurn;
			}
			invalidate() {
				this.currentTurn++;
				this.currentPhase = "listening";
			}
			enqueue(operation) {
				const result = this.tail.then(operation, operation);
				this.tail = result.then(() => void 0, () => void 0);
				return result;
			}
		};
		//#endregion
		//#region src/voice-contract.ts
		const VOICE_SUMMARY_START = "<!--voice-summary-->";
		const VOICE_SUMMARY_END = "<!--/voice-summary-->";
		//#endregion
		//#region src/client/voice-summary.ts
		const MAX_SUMMARY_WEIGHT = 240;
		/**
		* Streams only the first natural paragraph of the final visible answer.
		* Legacy voice-summary comments are accepted for in-flight/older sessions, but
		* new answers need no machine marker and therefore render cleanly in Harness.
		*/
		var VoiceSummaryStream = class {
			emit;
			input = "";
			pendingSpeech = "";
			mode = "undecided";
			ended = false;
			emitted = false;
			acceptedWeight = 0;
			constructor(emit) {
				this.emit = emit;
			}
			push(delta) {
				if (delta === "" || this.ended) return;
				this.input += delta;
				if (this.mode === "undecided") {
					const normalized = normalizeSummaryMarkers(this.input);
					const legacyStart = normalized.indexOf(VOICE_SUMMARY_START);
					if (legacyStart >= 0) {
						this.mode = "legacy";
						this.input = normalized.slice(legacyStart + 20);
					} else if (couldBeLegacyPrefix(this.input)) return;
					else {
						this.mode = "lead";
						this.input = this.input.trimStart();
						if (isUnsafeLead(this.input)) {
							this.input = "";
							this.ended = true;
							return;
						}
					}
				}
				if (this.mode === "legacy") this.drainLegacy();
				else this.drainLead(false);
			}
			finish(finalText) {
				if (!this.ended) {
					if (this.mode === "undecided") {
						const fallback = extractVoiceSummary(finalText);
						if (fallback !== "") this.emitSpeech(fallback);
						this.ended = true;
						return;
					}
					if (this.mode === "legacy") this.drainLegacy();
					else this.drainLead(true);
				}
				if (this.pendingSpeech.trim() !== "") this.emitSpeech(this.pendingSpeech);
				this.pendingSpeech = "";
				if (!this.emitted) {
					const fallback = extractVoiceSummary(finalText);
					if (fallback !== "") this.emitSpeech(fallback);
				}
			}
			drainLead(final) {
				const separator = paragraphBoundary(this.input);
				if (separator !== void 0) {
					this.accept(this.input.slice(0, separator.index), true);
					this.input = "";
					this.ended = true;
					return;
				}
				if (final) {
					this.accept(this.input, true);
					this.input = "";
					this.ended = true;
					return;
				}
				const held = partialParagraphSuffixLength(this.input);
				const safeLength = this.input.length - held;
				if (safeLength <= 0) return;
				this.accept(this.input.slice(0, safeLength), false);
				this.input = this.input.slice(safeLength);
			}
			drainLegacy() {
				this.input = normalizeSummaryMarkers(this.input);
				const end = this.input.indexOf(VOICE_SUMMARY_END);
				if (end >= 0) {
					this.accept(this.input.slice(0, end), true);
					this.input = "";
					this.ended = true;
					return;
				}
				const held = Math.max(partialMarkerSuffixLength(this.input, VOICE_SUMMARY_END), partialHtmlCommentSuffixLength(this.input));
				const safeLength = this.input.length - held;
				if (safeLength <= 0) return;
				this.accept(this.input.slice(0, safeLength), false);
				this.input = this.input.slice(safeLength);
			}
			accept(text, flush) {
				const remaining = MAX_SUMMARY_WEIGHT - this.acceptedWeight;
				if (remaining <= 0) {
					if (flush && this.pendingSpeech.trim() !== "") {
						this.emitSpeech(this.pendingSpeech);
						this.pendingSpeech = "";
					}
					return;
				}
				const bounded = takeWeighted(text, remaining);
				this.acceptedWeight += speechWeight(bounded);
				this.pendingSpeech += bounded;
				let boundary = completedSentenceBoundary(this.pendingSpeech);
				while (boundary > 0) {
					const sentence = this.pendingSpeech.slice(0, boundary);
					this.pendingSpeech = this.pendingSpeech.slice(boundary);
					this.emitSpeech(sentence);
					boundary = completedSentenceBoundary(this.pendingSpeech);
				}
				if (flush && this.pendingSpeech.trim() !== "") {
					this.emitSpeech(this.pendingSpeech);
					this.pendingSpeech = "";
				}
			}
			emitSpeech(text) {
				const clean = cleanSpeechText(text);
				if (clean === "") return;
				this.emitted = true;
				this.emit(clean);
			}
		};
		function extractVoiceSummary(text) {
			const normalized = normalizeSummaryMarkers(text);
			const start = normalized.indexOf(VOICE_SUMMARY_START);
			if (start >= 0) {
				const bodyStart = start + 20;
				const end = normalized.indexOf(VOICE_SUMMARY_END, bodyStart);
				if (end < 0) return "";
				return cleanSpeechText(takeWeighted(normalized.slice(bodyStart, end), MAX_SUMMARY_WEIGHT));
			}
			const body = text.trimStart();
			if (body === "" || isUnsafeLead(body)) return "";
			const separator = paragraphBoundary(body);
			const lead = separator === void 0 ? body : body.slice(0, separator.index);
			if (/<!--|-->/u.test(lead)) return "";
			return cleanSpeechText(takeWeighted(lead, MAX_SUMMARY_WEIGHT));
		}
		function normalizeSummaryMarkers(text) {
			return text.replace(/<!--\s*voice-summary\s*-->/gi, VOICE_SUMMARY_START).replace(/<!--\s*\/voice-summary\s*-->/gi, VOICE_SUMMARY_END);
		}
		function couldBeLegacyPrefix(text) {
			const trimmed = text.trimStart();
			if (trimmed === "") return true;
			return "<!-- voice-summary -->".startsWith(trimmed.toLowerCase()) || "<!--voice-summary-->".startsWith(trimmed.toLowerCase());
		}
		function isUnsafeLead(text) {
			return /^(?:`|<!--|<|\{|\[|#|\*|>|-|\+\s|\d+[.、)]|\||[•·])/u.test(text.trimStart());
		}
		function paragraphBoundary(text) {
			const match = /\r?\n[\t ]*\r?\n/u.exec(text);
			if (match === null || match.index === void 0) return void 0;
			return {
				index: match.index,
				length: match[0].length
			};
		}
		function partialParagraphSuffixLength(text) {
			const match = /\r?\n[\t ]*$/u.exec(text);
			return match === null ? 0 : match[0].length;
		}
		function completedSentenceBoundary(text) {
			const match = /[。！？!?；;](?:[”’」』】）)])?/u.exec(text);
			if (match === null || match.index === void 0) return 0;
			return match.index + match[0].length;
		}
		function cleanSpeechText(text) {
			return text.replace(/```[\s\S]*?```/g, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<\/?[^>]+>/g, " ").replace(/`([^`]+)`/g, "$1").replace(/!??\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/[>*_~]/g, "").replace(/\s+/g, " ").trim();
		}
		function partialHtmlCommentSuffixLength(text) {
			const open = text.lastIndexOf("<!--");
			if (open >= 0 && text.indexOf("-->", open + 4) < 0) return text.length - open;
			for (const prefix of [
				"<!-",
				"<!",
				"<"
			]) if (text.endsWith(prefix)) return prefix.length;
			return 0;
		}
		function partialMarkerSuffixLength(text, marker) {
			const max = Math.min(text.length, marker.length - 1);
			for (let length = max; length > 0; length--) if (text.endsWith(marker.slice(0, length))) return length;
			return 0;
		}
		function takeWeighted(text, limit) {
			let weight = 0;
			let result = "";
			for (const char of text) {
				const next = speechWeight(char);
				if (weight + next > limit) break;
				result += char;
				weight += next;
			}
			return result;
		}
		function speechWeight(text) {
			let value = 0;
			for (const char of text) value += /[\u3400-\u9fff\uf900-\ufaff]/u.test(char) ? 2 : 1;
			return value;
		}
		//#endregion
		//#region src/client/controller.ts
		var VoiceController = class {
			sessionId;
			bridge;
			createConnection;
			connection;
			snapshot = {
				state: "idle",
				detail: "",
				provider: loadPrefs().provider
			};
			listeners = /* @__PURE__ */ new Set();
			taskAbort;
			connectionEpoch = 0;
			transcriptTimer;
			transcriptSource;
			transcriptSegments = [];
			transcriptWasBusy = false;
			draftTarget;
			boundDraft = "";
			deferredDraft = "";
			turns = new TurnCoordinator();
			composerOnly = false;
			stopObserving;
			voiceContextTimer;
			observedSpeech;
			nativeSubmitPending = false;
			nativeSubmitTimer;
			nativeSubmittedTask = "";
			constructor(sessionId, bridge, createConnection = (prefs, callbacks) => prefs.provider === "qwen" ? new QwenPipelineConnection(prefs, callbacks) : new RealtimeConnection(prefs, callbacks)) {
				this.sessionId = sessionId;
				this.bridge = bridge;
				this.createConnection = createConnection;
			}
			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			};
			getSnapshot = () => this.snapshot;
			bindDraft(target) {
				this.draftTarget = target;
				this.boundDraft = target.getDraft();
				if (this.deferredDraft !== "") {
					this.appendToDraft(this.deferredDraft);
					this.deferredDraft = "";
				}
				return () => {
					if (this.draftTarget === target) this.draftTarget = void 0;
				};
			}
			async toggle() {
				if (this.connection !== void 0) return this.stop();
				if (new URLSearchParams(location.search).has("dsh-desktop-platform")) {
					this.setState("error", "桌面壳暂不开放麦克风；正在用默认浏览器打开同一会话");
					window.open(location.href.replace(/([?&])dsh-desktop-platform=[^&]*&?/, "$1").replace(/[?&]$/, ""), "_blank", "noopener");
					return;
				}
				const prefs = loadPrefs();
				this.snapshot = {
					state: "connecting",
					detail: "",
					provider: prefs.provider
				};
				this.emit();
				const epoch = ++this.connectionEpoch;
				let connection;
				connection = this.createConnection(prefs, {
					onState: (state, detail) => {
						if (this.connection !== connection) return;
						if (state === "speaking" && this.turns.phase === "tts-pending") this.setTurnPhase(this.turns.turnId, "tts-speaking");
						if (state === "listening" && this.turns.phase !== "listening" && this.turns.phase !== "endpoint-candidate") return;
						if (this.taskAbort === void 0) this.setState(state, detail ?? "");
					},
					onToolCall: (call) => this.handleToolCall(connection, call),
					onTranscript: (text, meta) => this.turns.enqueue(() => this.bufferTranscript(connection, text, meta?.capturedWhileBusy === true))
				});
				this.connection = connection;
				try {
					if (prefs.provider === "qwen") {
						const enabled = this.enableNativeComposer(connection);
						this.composerOnly = typeof enabled === "boolean" ? enabled : await enabled;
					}
					await connection.connect();
				} catch (error) {
					this.disableNativeComposer();
					connection.disconnect();
					if (this.connectionEpoch !== epoch || this.connection !== connection) return;
					this.connection = void 0;
					this.setState("error", error instanceof Error ? error.message : String(error));
				}
			}
			stop() {
				this.connectionEpoch++;
				this.turns.invalidate();
				this.flushBufferedTranscriptToDraft();
				this.taskAbort?.abort();
				this.taskAbort = void 0;
				this.clearNativeSubmitPending();
				this.disableNativeComposer();
				this.cancelObservedSpeech();
				const connection = this.connection;
				this.connection = void 0;
				connection?.disconnect();
				this.setState("idle", "");
			}
			dispose() {
				this.stop();
				this.listeners.clear();
			}
			async bufferTranscript(source, transcript, capturedWhileBusy = false) {
				if (this.connection !== source) return;
				const segment = transcript.trim();
				if (segment === "") return;
				if (this.transcriptSource !== void 0 && this.transcriptSource !== source) this.flushBufferedTranscriptToDraft();
				this.transcriptSource = source;
				this.transcriptSegments.push(segment);
				const wasBusy = capturedWhileBusy || this.hasPendingDraft() || this.nativeSubmitPending || this.taskAbort !== void 0 || this.turns.phase !== "listening" && this.turns.phase !== "endpoint-candidate";
				this.transcriptWasBusy ||= wasBusy;
				if (!wasBusy && this.turns.phase === "listening") this.setTurnPhase(this.turns.turnId, "endpoint-candidate");
				if (this.transcriptTimer !== void 0) clearTimeout(this.transcriptTimer);
				this.transcriptTimer = setTimeout(() => {
					this.transcriptTimer = void 0;
					const wasBusy = this.transcriptWasBusy;
					const combined = this.takeBufferedTranscript();
					if (combined !== "") this.turns.enqueue(() => this.composerOnly ? wasBusy ? this.stageComposerTranscript(source, combined) : this.submitComposerTranscript(source, combined) : wasBusy ? this.handleBusyTranscript(source, combined) : this.handleTranscript(source, combined));
				}, loadPrefs().qwenMergeMs);
			}
			async handleToolCall(source, call) {
				if (this.connection !== source) return {
					ok: false,
					error: "语音连接已关闭"
				};
				if (call.name === "cancel_harness_task") {
					this.taskAbort?.abort();
					const cancelled = await this.bridge.cancel(this.sessionId);
					if (this.connection === source) {
						this.invalidateCurrentTurn(source);
						this.setState("listening", cancelled ? "Harness 任务已取消" : "没有正在执行的 Harness 任务");
					}
					return {
						ok: true,
						cancelled
					};
				}
				let task = "";
				try {
					const args = JSON.parse(call.arguments);
					if (typeof args.task === "string") task = args.task.trim();
				} catch {}
				if (task === "") return {
					ok: false,
					error: "delegate_to_harness 缺少 task"
				};
				this.setState("working", task.slice(0, 100));
				const taskAbort = new AbortController();
				this.taskAbort = taskAbort;
				const result = await this.bridge.delegate(this.sessionId, task, taskAbort.signal);
				if (this.taskAbort === taskAbort) this.taskAbort = void 0;
				if (this.connection === source) this.setState("listening", result.ok ? "Harness 已完成" : result.error);
				return result;
			}
			async handleTranscript(source, transcript) {
				if (this.connection !== source) return;
				const task = transcript.trim();
				if (task === "") return;
				if (this.taskAbort !== void 0) {
					if (isExplicitCancel(task)) {
						const active = this.taskAbort;
						active.abort();
						const cancelled = await this.bridge.cancel(this.sessionId);
						if (this.taskAbort === active) this.taskAbort = void 0;
						if (this.connection === source) {
							this.invalidateCurrentTurn(source);
							this.setState("listening", cancelled ? "Harness 任务已取消" : "没有正在执行的 Harness 任务");
						}
					} else {
						this.appendToDraft(task);
						this.setState("working", "继续任务：新语音已转成文字；发送后排队处理，也可以直接清空");
					}
					return;
				}
				if (this.turns.phase === "tts-pending" || this.turns.phase === "tts-speaking" || this.turns.phase === "post-playback") {
					this.appendToDraft(task);
					this.setState(this.turns.phase === "tts-speaking" ? "speaking" : "working", "继续任务：新语音已保留在输入框；发送后处理，或直接清空");
					return;
				}
				const turnId = this.turns.begin();
				this.setTurnPhase(turnId, "harness");
				this.setState("working", task.slice(0, 100));
				const taskAbort = new AbortController();
				this.taskAbort = taskAbort;
				this.runHarnessTurn(source, task, turnId, taskAbort).catch((error) => {
					if (this.connection !== source || !this.turns.isCurrent(turnId)) return;
					this.setTurnPhase(turnId, "listening");
					this.setState("error", error instanceof Error ? error.message : String(error));
				});
			}
			async handleBusyTranscript(source, transcript) {
				if (this.connection !== source) return;
				const task = transcript.trim();
				if (task === "") return;
				if (this.taskAbort !== void 0 && isExplicitCancel(task)) {
					await this.handleTranscript(source, task);
					return;
				}
				this.appendToDraft(task);
				const playback = this.turns.phase === "tts-speaking" || this.turns.phase === "post-playback";
				this.setState(playback ? "speaking" : this.taskAbort !== void 0 ? "working" : "listening", "继续任务：新语音已保留在输入框；发送后处理，或直接清空");
			}
			stageComposerTranscript(source, transcript) {
				if (this.connection !== source) return;
				this.appendToDraft(transcript);
				if (this.turns.phase === "endpoint-candidate") this.setTurnPhase(this.turns.turnId, "listening");
				if (this.turns.phase === "listening") this.setState("listening", "语音已写入输入框；继续说会合并，发送后由 Harness 处理");
			}
			submitComposerTranscript(source, transcript) {
				if (this.connection !== source) return;
				const target = this.draftTarget;
				if (target?.submit === void 0) {
					this.stageComposerTranscript(source, transcript);
					return;
				}
				this.appendToDraft(transcript);
				this.nativeSubmittedTask = transcript.trim();
				this.nativeSubmitPending = true;
				this.setState("working", "语音已识别，正在交给 Harness");
				queueMicrotask(() => {
					if (this.connection !== source || !this.nativeSubmitPending) return;
					try {
						target.submit?.();
						this.boundDraft = "";
					} catch (error) {
						this.nativeSubmittedTask = "";
						this.clearNativeSubmitPending();
						if (this.turns.phase === "endpoint-candidate") this.setTurnPhase(this.turns.turnId, "listening");
						this.setState("error", `自动发送失败，文字已保留在输入框：${error instanceof Error ? error.message : String(error)}`);
						return;
					}
					if (!this.nativeSubmitPending) return;
					this.nativeSubmitTimer = setTimeout(() => {
						this.nativeSubmitTimer = void 0;
						if (!this.nativeSubmitPending || this.connection !== source) return;
						this.nativeSubmitPending = false;
						this.nativeSubmittedTask = "";
						if (this.turns.phase === "endpoint-candidate") this.setTurnPhase(this.turns.turnId, "listening");
						this.setState("error", "Harness 未确认自动发送；请检查输入框后手动发送");
					}, 1e4);
				});
			}
			enableNativeComposer(source) {
				const bridge = this.bridge;
				if (typeof bridge.observeSession !== "function" || typeof bridge.setVoiceMode !== "function") return false;
				this.stopObserving = bridge.observeSession(this.sessionId, {
					onTurnStart: (harnessTurn) => this.beginObservedTurn(source, harnessTurn),
					onTextDelta: (harnessTurn, delta) => this.pushObservedDelta(harnessTurn, delta),
					onTextReset: (harnessTurn) => this.resetObservedSpeech(harnessTurn),
					onTurnEnd: (harnessTurn, result) => {
						this.finishObservedTurn(harnessTurn, result);
					}
				});
				return bridge.setVoiceMode(this.sessionId, true).then(() => {
					this.voiceContextTimer = setInterval(() => {
						bridge.setVoiceMode?.(this.sessionId, true).catch(() => {});
					}, 6e5);
					return true;
				});
			}
			disableNativeComposer() {
				this.stopObserving?.();
				this.stopObserving = void 0;
				if (this.voiceContextTimer !== void 0) clearInterval(this.voiceContextTimer);
				this.voiceContextTimer = void 0;
				this.clearNativeSubmitPending();
				this.cancelObservedSpeech();
				if (this.composerOnly) this.bridge.setVoiceMode?.(this.sessionId, false).catch(() => {});
				this.composerOnly = false;
				this.nativeSubmittedTask = "";
			}
			beginObservedTurn(source, harnessTurn) {
				if (this.connection !== source || !this.composerOnly) return;
				this.cancelObservedSpeech();
				const submittedTask = this.nativeSubmittedTask;
				this.nativeSubmittedTask = "";
				this.clearNativeSubmitPending();
				const turnId = this.turns.begin();
				this.setTurnPhase(turnId, "harness");
				this.setState("working", "输入已发送，Harness 正在处理");
				const observed = {};
				observed.harnessTurn = harnessTurn;
				observed.turnId = turnId;
				observed.source = source;
				observed.speechQueue = Promise.resolve();
				observed.speechCancelled = false;
				observed.speechGeneration = 0;
				const enqueueSpeech = (sentence) => {
					if (source.speak === void 0 || observed.speechCancelled) return;
					const generation = observed.speechGeneration;
					if (this.connection === source && this.turns.isCurrent(turnId)) this.setTurnPhase(turnId, "tts-pending");
					observed.speechQueue = observed.speechQueue.then(async () => {
						if (generation !== observed.speechGeneration || observed.speechCancelled || this.connection !== source || !this.turns.isCurrent(turnId)) return;
						await source.speak?.(sentence);
					}).catch((error) => {
						if (generation !== observed.speechGeneration) return;
						observed.speechError = error;
						observed.speechCancelled = true;
					});
				};
				observed.floor = new FloorManager(loadPrefs().floorDelayMs, enqueueSpeech);
				observed.floor.start(submittedTask);
				observed.summary = new VoiceSummaryStream((sentence) => {
					enqueueSpeech(sentence);
				});
				this.observedSpeech = observed;
			}
			pushObservedDelta(harnessTurn, delta) {
				const observed = this.observedSpeech;
				if (observed?.harnessTurn === harnessTurn) {
					observed.floor.resultAvailable();
					observed.summary.push(delta);
				}
			}
			resetObservedSpeech(harnessTurn) {
				const observed = this.observedSpeech;
				if (observed?.harnessTurn !== harnessTurn) return;
				observed.floor.resultAvailable();
				observed.speechGeneration++;
				observed.source.cancelSpeech?.();
				observed.speechQueue = Promise.resolve();
				observed.speechCancelled = false;
				observed.speechError = void 0;
				observed.summary = new VoiceSummaryStream((sentence) => {
					if (observed.source.speak === void 0 || observed.speechCancelled) return;
					const generation = observed.speechGeneration;
					observed.speechQueue = observed.speechQueue.then(async () => {
						if (generation !== observed.speechGeneration || observed.speechCancelled || this.connection !== observed.source || !this.turns.isCurrent(observed.turnId)) return;
						await observed.source.speak?.(sentence);
					}).catch((error) => {
						if (generation !== observed.speechGeneration) return;
						observed.speechError = error;
						observed.speechCancelled = true;
					});
				});
				if (this.turns.isCurrent(observed.turnId)) this.setTurnPhase(observed.turnId, "harness");
			}
			async finishObservedTurn(harnessTurn, result) {
				const observed = this.observedSpeech;
				if (observed?.harnessTurn !== harnessTurn) return;
				observed.floor.dispose();
				const { source, turnId } = observed;
				const release = () => {
					if (this.observedSpeech === observed) this.observedSpeech = void 0;
				};
				if (this.connection !== source || !this.turns.isCurrent(turnId)) {
					release();
					return;
				}
				if (!result.ok) {
					observed.speechGeneration++;
					observed.source.cancelSpeech?.();
					this.setTurnPhase(turnId, "listening");
					this.setState(result.cancelled === true ? "listening" : "error", result.error);
					release();
					return;
				}
				try {
					observed.summary.finish(result.text);
					await observed.speechQueue;
					await source.waitForSpeechIdle?.();
					if (observed.speechError !== void 0 && !isBargeInError(observed.speechError)) throw observed.speechError;
					if (this.connection !== source || !this.turns.isCurrent(turnId)) {
						release();
						return;
					}
					this.setTurnPhase(turnId, "post-playback");
					await delay(400);
					if (this.connection !== source || !this.turns.isCurrent(turnId)) {
						release();
						return;
					}
					this.setTurnPhase(turnId, "listening");
					this.setState("listening", isBargeInError(observed.speechError) ? "播报已打断；识别文字保留在输入框" : this.hasPendingDraft() ? "Harness 已完成；输入框里的后续语音可发送或清空" : "Harness 已完成；继续说将自动处理");
					release();
				} catch (error) {
					if (this.connection === source && this.turns.isCurrent(turnId)) {
						this.setTurnPhase(turnId, "listening");
						this.setState("error", error instanceof Error ? error.message : String(error));
					}
					release();
				}
			}
			async runHarnessTurn(source, task, turnId, taskAbort) {
				let speechError;
				let speechCancelled = false;
				let speechQueue = Promise.resolve();
				let speechGeneration = 0;
				const enqueueSpeech = (sentence) => {
					if (source.speak === void 0) return;
					if (this.connection === source && this.turns.isCurrent(turnId)) this.setTurnPhase(turnId, "tts-pending");
					const generation = speechGeneration;
					speechQueue = speechQueue.then(async () => {
						if (generation !== speechGeneration || speechCancelled || this.connection !== source || !this.turns.isCurrent(turnId)) return;
						await source.speak?.(sentence);
					}).catch((error) => {
						if (generation !== speechGeneration) return;
						speechError = error;
						speechCancelled = true;
					});
				};
				let summary = new VoiceSummaryStream(enqueueSpeech);
				const floor = new FloorManager(loadPrefs().floorDelayMs, enqueueSpeech);
				floor.start(task);
				const result = await this.bridge.delegate(this.sessionId, task, taskAbort.signal, {
					voiceOutputContract: true,
					onTextDelta: (delta) => {
						floor.resultAvailable();
						summary.push(delta);
					},
					onTextReset: () => {
						floor.resultAvailable();
						speechGeneration++;
						source.cancelSpeech?.();
						speechQueue = Promise.resolve();
						speechCancelled = false;
						speechError = void 0;
						summary = new VoiceSummaryStream(enqueueSpeech);
						if (this.turns.isCurrent(turnId)) this.setTurnPhase(turnId, "harness");
					}
				});
				floor.dispose();
				if (this.taskAbort === taskAbort) this.taskAbort = void 0;
				if (this.connection !== source || !this.turns.isCurrent(turnId)) return;
				if (!result.ok) {
					speechGeneration++;
					source.cancelSpeech?.();
					this.setTurnPhase(turnId, "listening");
					this.setState("error", result.error);
					return;
				}
				if (source.speak === void 0) {
					this.setTurnPhase(turnId, "listening");
					this.setState("error", "当前语音连接没有独立 TTS");
					return;
				}
				try {
					summary.finish(result.text);
					await speechQueue;
					await source.waitForSpeechIdle?.();
					if (speechError !== void 0 && !isBargeInError(speechError)) throw speechError;
					if (this.connection === source && this.turns.isCurrent(turnId)) {
						this.setTurnPhase(turnId, "post-playback");
						await delay(400);
						if (this.connection !== source || !this.turns.isCurrent(turnId)) return;
						this.setTurnPhase(turnId, "listening");
						this.setState("listening", isBargeInError(speechError) ? "播报已打断；新语音已保留在输入框，可发送或清空" : "Harness 已完成");
					}
				} catch (error) {
					if (this.connection === source && this.turns.isCurrent(turnId)) {
						this.setTurnPhase(turnId, "listening");
						this.setState("error", error instanceof Error ? error.message : String(error));
					}
				}
			}
			cancelObservedSpeech() {
				const observed = this.observedSpeech;
				if (observed === void 0) return;
				observed.floor?.dispose();
				observed.speechGeneration++;
				observed.speechCancelled = true;
				observed.source.cancelSpeech?.();
				this.observedSpeech = void 0;
			}
			setState(state, detail) {
				this.snapshot = {
					state,
					detail,
					provider: loadPrefs().provider
				};
				this.emit();
			}
			emit() {
				this.listeners.forEach((listener) => listener());
			}
			setTurnPhase(turnId, phase) {
				if (!this.turns.transition(turnId, phase)) return;
				this.connection?.setInputPhase?.(phase);
			}
			invalidateCurrentTurn(source) {
				this.turns.invalidate();
				source.setInputPhase?.("listening");
			}
			takeBufferedTranscript() {
				const combined = this.transcriptSegments.splice(0).join("\n").trim();
				this.transcriptSource = void 0;
				this.transcriptWasBusy = false;
				return combined;
			}
			flushBufferedTranscriptToDraft() {
				if (this.transcriptTimer !== void 0) clearTimeout(this.transcriptTimer);
				this.transcriptTimer = void 0;
				const combined = this.takeBufferedTranscript();
				if (combined !== "") this.appendToDraft(combined);
			}
			appendToDraft(text) {
				const addition = text.trim();
				if (addition === "") return;
				const target = this.draftTarget;
				if (target === void 0) {
					this.deferredDraft = joinDraft(this.deferredDraft, addition);
					return;
				}
				const next = joinDraft(this.boundDraft || target.getDraft(), addition);
				this.boundDraft = next;
				target.setDraft(next);
			}
			hasPendingDraft() {
				if (this.deferredDraft.trim() !== "") return true;
				return (this.draftTarget?.getDraft() ?? this.boundDraft).trim() !== "";
			}
			clearNativeSubmitPending() {
				this.nativeSubmitPending = false;
				this.nativeSubmittedTask = "";
				if (this.nativeSubmitTimer !== void 0) clearTimeout(this.nativeSubmitTimer);
				this.nativeSubmitTimer = void 0;
			}
		};
		function isExplicitCancel(text) {
			const normalized = text.replace(/[\s，。！？,.!?、]/g, "");
			return /^(停|停止|停下|别说了|取消|取消任务|不要了|算了)$/.test(normalized);
		}
		function isBargeInError(error) {
			return error instanceof Error && error.message === "语音播放已被用户打断";
		}
		function joinDraft(existing, addition) {
			const before = existing.trimEnd();
			return before === "" ? addition : `${before}\n${addition}`;
		}
		function delay(ms) {
			return new Promise((resolve) => setTimeout(resolve, ms));
		}
		//#endregion
		//#region src/client/components.tsx
		const styles = {
			button: {
				width: 32,
				height: 32,
				border: 0,
				borderRadius: 999,
				cursor: "pointer",
				display: "grid",
				placeItems: "center",
				color: "var(--dsw-alias-label-secondary)",
				background: "transparent"
			},
			active: {
				color: "#fff",
				background: "#2563eb"
			},
			dock: {
				margin: "0 auto 4px",
				maxWidth: 760,
				padding: "5px 12px",
				borderRadius: "10px 10px 0 0",
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)",
				background: "var(--dsw-specific-tip)"
			},
			continueDock: {
				display: "flex",
				alignItems: "center",
				gap: 10,
				padding: "8px 12px"
			},
			continueTitle: {
				flex: "none",
				color: "var(--dsw-alias-label-primary)",
				fontWeight: 600
			},
			card: {
				listStyle: "none",
				padding: "14px 16px",
				borderBottom: "1px solid var(--dsw-alias-border-l1)"
			},
			row: {
				display: "grid",
				gridTemplateColumns: "150px 1fr",
				gap: 12,
				alignItems: "center",
				marginTop: 10
			},
			input: {
				minWidth: 0,
				padding: "7px 9px",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 7,
				background: "var(--dsw-alias-bg-base)",
				color: "inherit"
			}
		};
		function MicButton({ controller }) {
			const snapshot = (0, react.useSyncExternalStore)(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
			const active = snapshot.state !== "idle" && snapshot.state !== "error";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				"aria-label": active ? "停止实时语音" : "开始实时语音",
				"aria-pressed": active,
				title: active ? "停止实时语音" : `开始实时语音（${snapshot.provider === "qwen" ? "千问" : "GPT"}）`,
				style: {
					...styles.button,
					...active ? styles.active : {}
				},
				onClick: () => {
					controller.toggle();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
					width: "19",
					height: "19",
					viewBox: "0 0 24 24",
					"aria-hidden": "true",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						fill: "currentColor",
						d: "M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm6-3a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.94V22h2v-2.06A8 8 0 0 0 20 12h-2Z"
					})
				})
			});
		}
		function VoiceStatus({ controller, input, inputActions }) {
			const snapshot = (0, react.useSyncExternalStore)(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
			(0, react.useEffect)(() => controller.bindDraft({
				getDraft: () => input.draft,
				setDraft: (text) => inputActions.setDraft(text),
				submit: () => inputActions.submit()
			}), [
				controller,
				input.draft,
				inputActions
			]);
			if (snapshot.state === "idle") return null;
			const labels = {
				connecting: "正在连接",
				listening: "正在聆听",
				speaking: "正在说话",
				working: "Harness 正在执行",
				error: "语音不可用"
			};
			if (snapshot.detail.startsWith("继续任务：")) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				role: "status",
				"data-voice-continue-task": "",
				style: {
					...styles.dock,
					...styles.continueDock
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						"aria-hidden": "true",
						children: "↪"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: styles.continueTitle,
						children: "继续任务"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: snapshot.detail.slice(5) })
				]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				role: snapshot.state === "error" ? "alert" : "status",
				style: styles.dock,
				children: [
					snapshot.provider === "qwen" ? "千问" : "GPT",
					" · ",
					labels[snapshot.state],
					snapshot.detail ? `：${snapshot.detail}` : ""
				]
			});
		}
		function SettingsCard() {
			const prefs = (0, react.useSyncExternalStore)(subscribePrefs, loadPrefs, loadPrefs);
			const [open, setOpen] = (0, react.useState)(false);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				style: styles.card,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					onClick: () => setOpen(!open),
					style: {
						width: "100%",
						border: 0,
						background: "transparent",
						color: "inherit",
						textAlign: "left",
						cursor: "pointer",
						padding: 0
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "实时语音（千问 / GPT）" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							opacity: .66,
							marginTop: 4
						},
						children: "独立 ASR → Harness 推理/插件 → 独立 TTS；不会由语音模型直接回答"
					})]
				}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "服务商",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							style: styles.input,
							value: prefs.provider,
							onChange: (e) => updatePrefs({ provider: e.currentTarget.value === "openai" ? "openai" : "qwen" }),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "qwen",
								children: "国内：千问专用 ASR / TTS"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "openai",
								children: "全球：OpenAI GPT Realtime"
							})]
						})
					}),
					prefs.provider === "qwen" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "Workspace ID",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.input,
								value: prefs.qwenWorkspaceId,
								placeholder: "阿里云百炼 Workspace ID",
								onChange: (e) => updatePrefs({ qwenWorkspaceId: e.currentTarget.value })
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "区域",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								style: styles.input,
								value: prefs.qwenRegion,
								onChange: (e) => updatePrefs({ qwenRegion: e.currentTarget.value === "ap-southeast-1" ? "ap-southeast-1" : "cn-beijing" }),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "cn-beijing",
									children: "北京"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "ap-southeast-1",
									children: "新加坡"
								})]
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "ASR 模型",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.input,
								value: prefs.qwenAsrModel,
								onChange: (e) => updatePrefs({ qwenAsrModel: e.currentTarget.value })
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "TTS 模型",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.input,
								value: prefs.qwenTtsModel,
								onChange: (e) => updatePrefs({ qwenTtsModel: e.currentTarget.value })
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "TTS 音色",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								style: styles.input,
								value: prefs.qwenTtsVoice,
								onChange: (e) => updatePrefs({ qwenTtsVoice: e.currentTarget.value }),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "Chelsie",
										children: "Chelsie（软糯亲昵，最接近 Tina）"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "Cherry",
										children: "Cherry（清亮活泼）"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "Serena",
										children: "Serena（甜润亲切）"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "Ethan",
										children: "Ethan（清朗男声）"
									})
								]
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "人声阈值",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.input,
								type: "number",
								min: -1,
								max: 1,
								step: .05,
								value: prefs.qwenVadThreshold,
								onChange: (e) => updatePrefs({ qwenVadThreshold: e.currentTarget.valueAsNumber })
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "断句等待(ms)",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.input,
								type: "number",
								min: 200,
								max: 6e3,
								step: 100,
								value: prefs.qwenSilenceMs,
								onChange: (e) => updatePrefs({ qwenSilenceMs: e.currentTarget.valueAsNumber })
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "语段合并等待(ms)",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.input,
								type: "number",
								min: 100,
								max: 5e3,
								step: 100,
								value: prefs.qwenMergeMs,
								onChange: (e) => updatePrefs({ qwenMergeMs: e.currentTarget.valueAsNumber })
							})
						})
					] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "模型",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: styles.input,
							value: prefs.openaiModel,
							onChange: (e) => updatePrefs({ openaiModel: e.currentTarget.value })
						})
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "声音",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: styles.input,
							value: prefs.openaiVoice,
							onChange: (e) => updatePrefs({ openaiVoice: e.currentTarget.value })
						})
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "自然接场等待(ms)",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: styles.input,
							type: "number",
							min: 400,
							max: 3e3,
							step: 100,
							value: prefs.floorDelayMs,
							onChange: (e) => updatePrefs({ floorDelayMs: e.currentTarget.valueAsNumber })
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "播报风格",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							style: {
								...styles.input,
								minHeight: 84,
								resize: "vertical"
							},
							value: prefs.instructions,
							onChange: (e) => updatePrefs({ instructions: e.currentTarget.value })
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						style: {
							opacity: .66,
							fontSize: 12,
							lineHeight: 1.55
						},
						children: [
							"密钥不会进入浏览器或插件配置：请由 Harness 凭据系统提供 ",
							prefs.provider === "qwen" ? "DASHSCOPE_API_KEY" : "OPENAI_API_KEY",
							"。空闲且输入框为空时，千问识别出的完整语句会自动交给 Harness；Harness 推理或播报期间的新语音才保留在原生输入框，等待发送或清空。Tina 属于 Omni，专用 TTS 不支持；默认改用最接近其风格的 Chelsie。桌面壳当前禁用麦克风，点击话筒会在外部浏览器打开同一会话。"
						]
					})
				] })]
			});
		}
		function Field({ label, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				style: styles.row,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }), children]
			});
		}
		//#endregion
		//#region src/client/index.ts
		const name = "dsh-realtime-voice-client";
		const inject = ["slots", "connection"];
		function apply(ctx) {
			const api = ctx.connection.api;
			const bridge = new HarnessBridge(api);
			const controllers = /* @__PURE__ */ new Map();
			hydrateFromHost();
			const controllerFor = (sessionId) => {
				let controller = controllers.get(sessionId);
				if (controller === void 0) {
					controller = new VoiceController(sessionId, bridge);
					controllers.set(sessionId, controller);
				}
				return controller;
			};
			ctx.effect(() => () => {
				controllers.forEach((controller) => controller.dispose());
				controllers.clear();
				bridge.dispose();
			}, "dsh-realtime-voice: controller lifecycle");
			ctx.effect(() => ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "realtime-voice-mic",
				order: 30,
				inject: (sessionId) => ({ controller: controllerFor(sessionId) })
			}, MicButton)), "dsh-realtime-voice: mic button");
			ctx.effect(() => ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "realtime-voice-status",
				order: 80,
				inject: (sessionId) => ({ controller: controllerFor(sessionId) })
			}, VoiceStatus)), "dsh-realtime-voice: status dock");
			ctx.effect(() => ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				id: "realtime-voice-settings",
				order: 25,
				inject: () => ({})
			}, SettingsCard)), "dsh-realtime-voice: settings");
		}
		//#endregion
		exports.HarnessBridge = HarnessBridge;
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		exports.parseToolCall = parseToolCall;
		exports.sessionUpdate = sessionUpdate;
		exports.toolOutput = toolOutput;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
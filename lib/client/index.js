import { HarnessBridge } from "./harness-delegate.js";
import { VoiceController } from "./controller.js";
import { MicButton, SettingsCard, VoiceStatus } from "./components.js";
import { hydrateFromHost } from "./prefs.js";
export const name = 'dsh-realtime-voice-client';
export const inject = ['slots', 'connection'];
export function apply(ctx) {
    const api = ctx.connection.api;
    const bridge = new HarnessBridge(api);
    const controllers = new Map();
    // Pull prefs persisted on the host (settings document) into this browser's
    // localStorage cache on startup, and push this browser's values up when the
    // host has none yet — so the config survives browser/port changes.
    hydrateFromHost();
    const controllerFor = (sessionId) => {
        let controller = controllers.get(sessionId);
        if (controller === undefined) {
            controller = new VoiceController(sessionId, bridge);
            controllers.set(sessionId, controller);
        }
        return controller;
    };
    ctx.effect(() => () => {
        controllers.forEach(controller => controller.dispose());
        controllers.clear();
        bridge.dispose();
    }, 'dsh-realtime-voice: controller lifecycle');
    ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'realtime-voice-mic',
        order: 30,
        inject: (sessionId) => ({ controller: controllerFor(sessionId) }),
    }, MicButton)), 'dsh-realtime-voice: mic button');
    ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'realtime-voice-status',
        order: 80,
        inject: (sessionId) => ({ controller: controllerFor(sessionId) }),
    }, VoiceStatus)), 'dsh-realtime-voice: status dock');
    ctx.effect(() => ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        id: 'realtime-voice-settings',
        order: 25,
        inject: () => ({}),
    }, SettingsCard)), 'dsh-realtime-voice: settings');
}
export { HarnessBridge } from "./harness-delegate.js";
export { parseToolCall, sessionUpdate, toolOutput } from "./protocol.js";

import { loadPrefs } from "./prefs.js";
const URL = '/dsh-realtime-voice/floor-compose';
export const resolveDynamicFloorCue = async (request, signal) => {
    const prefs = loadPrefs();
    if (!prefs.floorComposerEnabled)
        return undefined;
    const response = await fetch(URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ...request, provider: prefs.provider }),
        cache: 'no-store',
        signal,
    });
    if (!response.ok)
        return undefined;
    const body = await response.json();
    return typeof body.cue === 'string' ? body.cue : undefined;
};

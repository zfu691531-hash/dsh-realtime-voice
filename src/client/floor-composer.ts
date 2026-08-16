import type { FloorCueResolver } from './floor-manager.ts'
import { loadPrefs } from './prefs.ts'

const URL = '/dsh-realtime-voice/floor-compose'

export const resolveDynamicFloorCue: FloorCueResolver = async (request, signal) => {
  const prefs = loadPrefs()
  if (!prefs.floorComposerEnabled) return undefined
  const response = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ ...request, provider: prefs.provider }),
    cache: 'no-store',
    signal,
  })
  if (!response.ok) return undefined
  const body = await response.json() as { cue?: unknown }
  return typeof body.cue === 'string' ? body.cue : undefined
}

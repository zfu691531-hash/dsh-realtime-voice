/**
 * Owns voice turn identity and serializes every state-changing event. Audio,
 * Harness and TTS callbacks can arrive from unrelated transports; allowing
 * them to mutate the controller directly is what previously produced mixed
 * turns and stale playback.
 */
export class TurnCoordinator {
    currentPhase = 'listening';
    currentTurn = 0;
    tail = Promise.resolve();
    get phase() { return this.currentPhase; }
    get turnId() { return this.currentTurn; }
    begin() {
        this.currentTurn++;
        this.currentPhase = 'harness';
        return this.currentTurn;
    }
    transition(turnId, phase) {
        if (turnId !== this.currentTurn)
            return false;
        this.currentPhase = phase;
        return true;
    }
    isCurrent(turnId) { return turnId === this.currentTurn; }
    invalidate() {
        this.currentTurn++;
        this.currentPhase = 'listening';
    }
    enqueue(operation) {
        const result = this.tail.then(operation, operation);
        this.tail = result.then(() => undefined, () => undefined);
        return result;
    }
}

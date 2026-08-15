const DEFAULT_ACK = '嗯，我认真想一下。';
/**
 * A latency race, not a second answering agent. Harness remains the only
 * reasoning writer; this manager may emit at most one non-committal cue while
 * the first visible result token is still absent.
 */
export class FloorManager {
    delayMs;
    emit;
    timer;
    resultStarted = false;
    disposed = false;
    constructor(delayMs, emit) {
        this.delayMs = delayMs;
        this.emit = emit;
    }
    start(task = '') {
        this.cancelTimer();
        this.resultStarted = false;
        this.disposed = false;
        const cue = floorAcknowledgement(task);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            if (!this.disposed && !this.resultStarted)
                this.emit(cue);
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
        if (this.timer !== undefined)
            clearTimeout(this.timer);
        this.timer = undefined;
    }
}
export function floorAcknowledgement(task) {
    const normalized = task.replace(/\s+/g, '');
    if (/(对比|比较|选哪个|哪个好|区别|优缺点)/.test(normalized))
        return '好，我先帮你理一理。';
    if (/(查|搜索|天气|新闻|资料|附近|哪里|几点|价格)/.test(normalized))
        return '嗯，我先查一下。';
    if (/(写|改|修|安装|创建|生成|处理|执行|操作)/.test(normalized))
        return '好，我来处理。';
    if (/(计划|规划|分析|为什么|怎么办|怎么练|怎么做|建议)/.test(normalized))
        return DEFAULT_ACK;
    return '嗯，我想一下。';
}

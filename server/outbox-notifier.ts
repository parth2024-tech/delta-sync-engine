import { EventEmitter } from "node:events";

class OutboxNotifier extends EventEmitter {
  emitInserted() {
    this.emit("inserted");
  }
}

export const outboxNotifier = new OutboxNotifier();

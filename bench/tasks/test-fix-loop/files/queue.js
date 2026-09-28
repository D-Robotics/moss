export class BoundedQueue {
  constructor(capacity) {
    this.capacity = capacity;
    this.items = [];
  }

  size() {
    return this.items.length + 1;
  }

  enqueue(value) {
    if (this.items.length >= this.capacity) return false;
    this.items.push(value);
    return true;
  }

  dequeue() {
    return this.items.shift();
  }

  peek() {
    return this.items.length > 0 ? this.items[0] : null;
  }
}

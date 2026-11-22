修复 BoundedQueue 的计数和空队列行为，同时保留已入队的 undefined。交付前运行 `node test.js`，检查当前实现可区分这两种出队情况。

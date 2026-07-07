import { useEffect, useRef, useState } from "react";

/**
 * useEffect cleanup 模式
 *
 * 为什么要 cleanup？
 * 组件卸载（unmount）或依赖变化导致 effect 重新执行前，上一次 effect 的副作用
 * 仍然残留在内存/浏览器中。如果不清理，会导致：
 *   1. 内存泄漏 —— 闭包持有已卸载组件的引用，无法被 GC 回收；
 *   2. 状态更新报错 —— 对已卸载组件调用 setState，React 会警告（异步任务尤其常见）；
 *   3. 重复触发 —— 定时器/订阅叠加，同一个事件被处理多次；
 *   4. 脏数据 —— 旧的异步请求晚于新请求返回，覆盖了正确结果（竞态）。
 *
 * 规则：effect 里做了什么"持续存在"的动作，cleanup 就要把它撤销。
 */

// ---------- 1. 事件监听 ----------
function WindowWidth() {
  const [width, setWidth] = useState(window.innerWidth);

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    // cleanup：移除监听，否则卸载后 resize 仍会调用已失效的 setState
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return <p>当前窗口宽度：{width}px</p>;
}

// ---------- 2. 定时器 ----------
function Clock() {
  const [time, setTime] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setTime(Date.now()), 1000);
    // cleanup：清除定时器，否则卸载后它仍在跑，持续调用失效 setState
    return () => clearInterval(id);
  }, []);

  return <p>现在时刻：{new Date(time).toLocaleTimeString()}</p>;
}

// ---------- 3. 异步请求 + 竞态防护 ----------
function UserProfile({ userId }: { userId: string }) {
  const [name, setName] = useState<string>("");

  useEffect(() => {
    let cancelled = false; // cleanup 会把它置 true

    fetch(`/api/users/${userId}`)
      .then((r) => r.json())
      .then((data) => {
        // 如果在此请求返回前组件已卸载或 userId 已变，则丢弃结果
        if (!cancelled) setName(data.name);
      })
      .catch(() => {
        if (!cancelled) setName("加载失败");
      });

    // cleanup：标记本次请求作废，防止旧响应覆盖新响应（竞态），也避免卸载后 setState
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return <p>用户名：{name || "加载中…"}</p>;
}

// ---------- 4. 外部资源：WebSocket 连接 ----------
function LiveMessages() {
  const [messages, setMessages] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket("wss://example.com/messages");
    wsRef.current = ws;

    ws.onmessage = (e) => setMessages((prev) => [...prev, e.data]);

    // cleanup：关闭连接并清空引用，否则卸载后 socket 仍占资源、仍回调失效 setState
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, []);

  return (
    <ul>
      {messages.map((m, i) => (
        <li key={i}>{m}</li>
      ))}
    </ul>
  );
}
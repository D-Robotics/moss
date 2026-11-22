通过真实 HTTP 连接请求 HEAD 时，响应要与同一路由 GET 的长度元数据一致且不发送正文。验证普通路由、回退路由和请求头行为。

用最小 Axum 服务注册返回短文本的 GET 路由和 fallback，分别用 curl -i 和 curl -I 比较。

验证时请运行 `RUSTFLAGS=-Awarnings cargo test --package axum --lib -- routing::tests`。请保留现有测试和配置。

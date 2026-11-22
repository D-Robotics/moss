让组件返回 new String(...) 时渲染对应文本，保留普通字符串和其它子节点行为。修复后运行组件浏览器测试。

令一个组件从 render 返回 new String("sample")，另一个组件返回普通字符串，用 DOM 文本核对。

验证时请运行 `COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="test/browser/components.test.js"`。请保留现有测试和配置。

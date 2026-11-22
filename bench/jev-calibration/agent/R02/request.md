修复 SVG use 元素传入带冒号的 xlink:href 时生成错误属性名的问题。保持其它已有 SVG 属性行为，修复后运行 SVG 浏览器测试。

渲染 createElement("svg", {}, createElement("use", {"xlink:href": "#foo"}))，检查实际 DOM 属性，而非只看组件 props。

验证时请运行 `COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="test/browser/svg.test.js"`。请保留现有测试和配置。

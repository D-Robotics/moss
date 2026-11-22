页面集合没有任何页面带相应参数时，GroupByParam 应得到可空迭代的结果且不报错。修复后验证正常分组和缺失参数。

在带至少一个普通内容页面的站点模板中运行 range site.Pages.GroupByParam "missing_tag"，再用已有参数做对照。

验证时请运行 `go test -v ./resources/page -run '^TestGroupBy'`。请保留现有测试和配置。

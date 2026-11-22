修复 OrderedSet 与 OrderedMap 在值及顺序相等时，因为删除或重插历史不同而产生不同哈希的问题。验证两种集合。

对比直接创建的单元素集合与创建两个元素后删除第一个的集合，分别比较 equals 和 hashCode。

验证时请运行 `npm run build && npx jest __tests__/OrderedMap.ts __tests__/OrderedSet.ts --runInBand`。请保留现有测试和配置。

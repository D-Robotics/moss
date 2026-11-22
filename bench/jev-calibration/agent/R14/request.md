修复有符号零使地理形状违反 equals/hashCode 约定的问题。验证 XY 与经纬度对象，保留正常坐标行为。

执行 Gradle 的 TestXYPoint.testEqualsAndHashCode，使用 seed 3ABEFE4D876DD310，再比较含 +0.0 和 -0.0 的构造结果。

验证时请运行 `./gradlew test --tests TestXYPoint.testEqualsAndHashCode -Dtests.seed=3ABEFE4D876DD310 -Dtests.nightly=true -Dtests.locale=es-419 -Dtests.timezone=Asia/Ulaanbaatar -Dtests.asserts=true -Dtests.file.encoding=UTF-8`。请保留现有测试和配置。

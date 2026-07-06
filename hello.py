"""Hello World 示例：演示类、函数与注释的写法。"""


# 定义一个问候类
class Greeter:
    def __init__(self, name: str):
        """初始化问候对象。

        Args:
            name: 被问候者的名字。
        """
        self.name = name

    def greet(self) -> str:
        """返回问候语。"""
        return f"Hello, {self.name}!"


# 顶层函数：创建 Greeter 并打印问候
def say_hello(name: str = "World") -> None:
    greeter = Greeter(name)  # 实例化 Greeter
    print(greeter.greet())   # 打印问候语


if __name__ == "__main__":
    say_hello()
    say_hello("Moss")
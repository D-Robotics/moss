#!/usr/bin/env python3
"""Chinese TUI chrome. Each snapshot is printed so the JS scanner can read it."""

import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "scripts", "tui-feel"))

from screen import Session  # noqa: E402


def text(session) -> str:
    return "\n".join(session.lines())


def dump(name: str, body: str) -> None:
    print(f"===SCREEN {name}===")
    print(body)
    print("===END===")


def wait_for(session, needle: str, timeout: float = 20.0) -> str:
    end = time.time() + timeout
    seen = ""
    while time.time() < end:
        seen = text(session)
        if needle in seen:
            return seen
        session.pump(0.1)
    raise AssertionError(f"missing {needle!r}\n{seen}")


def welcome() -> None:
    zh = {
        "LANG": "zh_CN.UTF-8",
        "LC_ALL": "zh_CN.UTF-8",
        "LC_MESSAGES": "zh_CN.UTF-8",
        "MOSS_NO_BUNDLED_DEFAULT": "1",
    }
    with Session(
        cols=100,
        rows=36,
        extra_env=zh,
        config={"apiKey": "", "model": "deepseek"},
    ) as session:
        seen = wait_for(session, "选择服务商")
        if "Moss 设置" not in seen:
            raise AssertionError(f"welcome title missing\n{seen}")
        if "界面语言：中文" not in seen:
            raise AssertionError(f"first-run English offer missing\n{seen}")
        dump("welcome", seen)


def chrome() -> None:
    with Session(cols=120, rows=40, config={"model": "deepseek"}) as session:
        session.wait_for_prompt()
        session.submit("/language zh", wait=1.5)
        wait_for(session, "界面语言")
        session.submit("/language", wait=1.5)
        seen = wait_for(session, "只切换本会话")
        if "记到用户配置" not in seen:
            raise AssertionError(f"/language card missing the save line\n{seen}")
        if "界面语言：中文" not in seen:
            raise AssertionError(f"/language card missing the Chinese status\n{seen}")
        if "语言" not in seen:
            raise AssertionError(f"/language card title missing\n{seen}")
        dump("language", seen)
        seen = wait_for(session, "全开已开启")
        dump("status", seen)
        session.submit("/help", wait=1.0)
        seen = wait_for(session, "快捷键")
        if "帮助" not in seen:
            raise AssertionError(f"/help title missing\n{seen}")
        if "为本会话选择或切换当前模型" not in seen:
            raise AssertionError(f"/help commands stayed in English\n{seen}")
        dump("help", seen)
        session.key("esc")
        session.submit("/doctor", wait=2.0)
        seen = wait_for(session, "诊断")
        for needle in ("模型", "版本", "认证"):
            if needle not in seen:
                raise AssertionError(f"/doctor card missing {needle}\n{seen}")
        dump("doctor", seen)


def main() -> None:
    welcome()
    chrome()
    print("[PASS] zh TUI welcome /help /language status doctor")


if __name__ == "__main__":
    main()

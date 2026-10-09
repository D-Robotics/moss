# 真实终端清单（P7）

自动化入口是 `python3 scripts/tui-feel/real-terminals.py`（`test/tui-real-terminals.spec.mjs` 会调它）。缺哪个终端，脚本就跳过哪一项，退出码仍是 0；装上了但断言失败才是 1。先 `npm run build`，需要本地 stub，不走外网模型。

2026-10-09 在这台 Mac 上的结果：

| 终端                                        | 结果                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| tmux 3.7c，鼠标关 / 开（session 与 global） | 通过。关：内联，`alternate_on=0`。开：全屏，`alternate_on=1`，SGR 鼠标开。光标在提示符上 |
| GNU screen 4.00.03                          | 通过。画面是 attach 之后从 pty 读的，不是 `hardcopy`                                     |
| Terminal.app                                | 通过。只创建并关闭标题 `moss-p7-<pid>` 的窗口                                            |
| iTerm2                                      | 未安装，脚本 skip                                                                        |
| VS Code 集成终端                            | 未安装，脚本 skip。装上之后仍然不自动驱动                                                |
| Windows Terminal                            | 本机做不了                                                                               |
| 中文输入法候选框                            | 本机没有自动打开候选窗。硬件光标位置在 tmux 里核对过                                     |

云上的 Linux VM 可以重跑 tmux 和 GNU screen。它开不了 iTerm2、Terminal.app、VS Code 终端，也开不了 macOS / Windows 的输入法候选框。

## 已经自动化的行为

- tmux 鼠标关：不进备用屏幕，不打开 SGR 鼠标，光标在 `❯` 后第 2 列，输入 `hello` 后能看到 stub 的 `Done.`
- tmux 鼠标开（`set -t` 和 `set -g` 各一次）：备用屏幕开，SGR 鼠标开，光标在提示符行。composer 一出现就送 `测`，必须只有一个，光标列是 4（提示符 2 列 + 宽字符 2 列）
- GNU screen：内联 composer 和 `Done.`。macOS 自带的 screen 4.00.03 对 detached 会话 `hardcopy` 会写出 0 字节文件，所以脚本改为 attach 到一块设了 `TERM=xterm-256color` 的 pty 再读
- Terminal.app：`do script` 开自己的窗口，`contents` 读可见文本，`do script "hello" in tab` 送输入。结束时先 `/quit` 再 `exit` 再 `close`。不要先杀掉 tty，否则 `close` 会返回成功但窗口还在

## iTerm2（本机未安装）

1. 安装 iTerm2，确认存在 `/Applications/iTerm.app` 或 `iTerm2.app`。
2. `npm run build`
3. `python3 scripts/tui-feel/real-terminals.py`
4. 脚本会自己开一个名字以 `moss-p7-iterm-` 开头的会话。通过标准与 Terminal.app 相同：能看到 `❯` 和 `mode on`，`hello` 之后能看到 `Done.`，然后只关掉这个会话。
5. 若脚本 skip 或打不开窗口，手工做：
   - 新开一个 iTerm 窗口，运行构建出的 `dist/cli.js`（配置指向 `scripts/tui-feel/stub.mjs`，权限 `full`）
   - 空闲时硬件光标在 `❯ ` 后面，不在状态行上
   - 输入 `测`，只出现一个，光标向右移两格
   - 回车后看到 `Done.`
   - 退出后备用屏幕关掉，鼠标跟踪关掉（点击不会在 shell 里打出 `0;84;44M`）

## VS Code 集成终端

本机没有 `Visual Studio Code.app`，也没有 `code`。装上之后脚本会认出它，然后仍然 skip：集成终端没有等价于 tmux `capture-pane` 的接口，自动化要点击编辑器，会抢焦点。

手工：

1. 用 VS Code 打开一个空目录，打开集成终端（Terminal: Create New Terminal）。
2. 在那个终端里启动 moss（同上，本地 stub，`npm run build` 之后的 `dist/cli.js`）。
3. 确认是全屏（备用屏幕）：滚轮滚的是 moss 的 transcript，不是终端自己的 scrollback。
4. 光标在底部 composer 的 `❯ ` 之后。
5. 输入 `测`，只有一个；候选框那一项见下面的输入法清单。
6. `hello` 回车，看到 `Done.`
7. `/quit` 退出。终端回到 shell 提示符，点击不会插入鼠标上报。

## Windows Terminal（只能在 Windows 上）

Moss 在非 TTY、`MOSS_NO_TUI=1` 或 Windows 上走 readline REPL，不走全屏 Ink。这项核对的是回退，不是全屏。

1. 在 Windows Terminal 里打开 PowerShell 或 cmd，`node dist/cli.js`（先 `npm run build`）。
2. 确认没有备用屏幕、没有鼠标跟踪：界面是普通滚动的 REPL，提示符是 `›`，不是全屏 `❯` 帧。
3. 输入一行文字回车，能看到模型回复或明确的错误，而不是一屏 ANSI 乱码。
4. 退出后 shell 仍可用，点击不会打出 SGR 鼠标序列。
5. 若有人在 Windows 上强制 `MOSS_TUI_RENDERER=fullscreen`，记下实际发生了什么（进了全屏，还是仍回退），不要把它写成通过。

## 中文输入法候选框

候选窗是否贴着硬件光标，脚本打不开输入法，所以不能报通过。tmux 上已经核对的是光标格本身：全屏时空闲光标在提示符列 2，输入一个 `测` 后在列 4。

在 Mac 上用 Terminal.app 或 iTerm2 再看候选窗：

1. 切到中文输入法（拼音或注音），打开 moss 全屏。
2. 焦点在 composer。按一个拼音音节，候选窗的左上角应贴着 `❯ ` 后面的那个格子，而不是窗口左上角、状态行或上一行的横线。
3. 用方向键把光标移到已输入文字中间，再调出候选窗，窗还是跟着光标，不粘在行尾。
4. 在审批选项上（`❯` 标出的那一行）调出候选窗，窗跟着那一行的标记，不回到 composer。
5. 候选窗打开时继续输入，已上屏的字只出现一次，光标按字宽移动（一个汉字两列）。
6. 关掉候选窗并退出 moss。shell 里点击，不应出现 `0;…M`。

Windows Terminal 上用微软拼音重复第 2 步和第 5 步。VS Code 集成终端上同样做第 2 步：VS Code 自己的候选窗有时不跟着终端光标，那是编辑器的行为，记下“窗不跟随”和当时的 VS Code 版本，不要改 moss 去迁就它，除非 moss 的硬件光标本身就不在输入位置。







export type ChannelSource = string;

export interface ChannelSafetyResult {
  blocked: boolean;
  reason?: string;
}







const CMD =
  '(?:^|[\\n;&|(]|\\|\\||&&|\\$\\(|`|\\bsudo\\s+|\\bnice\\s+(?:-n\\s+-?\\d+\\s+)?|\\btime\\s+|\\bxargs\\s+(?:-[^\\s]+\\s+)*|\\benv\\s+(?:[A-Za-z_]\\w*=\\S*\\s+)*|(?:[A-Za-z_]\\w*=\\S*\\s+)+)\\s*';
const at = (body: string, flags = 'i'): RegExp => new RegExp(CMD + body, flags);

const DANGEROUS_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?.*\/(\.ssh|\.config|\/etc)/i,
    reason: '禁止删除关键系统/项目目录',
  },
  // rm recursive delete of root/home — short flags containing r (-rf/-fr/-r/-rv…).
  // Tolerates the `--` end-of-options marker, additional short/long options around
  // the recursive flag, and `$HOME`/`${HOME}` shell expansion — the previous
  // pattern `rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+[/~]` was bypassed by `rm -rf -- /`,
  // `rm -r --force /`, and `rm -rf $HOME` (the flag-then-`[/~]` anchor broke on
  // the `--` separator and on `$`).
  {
    pattern: /\brm\s+(?:-[a-z]+\s+)*-[a-z]*r[a-z]*(?:\s+--?[a-z-]+)*\s*(?:--\s+)?["']?(?:[/~]|\$HOME\b|\$\{HOME\})/i,
    reason: '禁止递归删除根目录或用户目录',
  },
  // rm recursive delete of root/home — long --recursive flag (any option order).
  {
    pattern: /\brm\s+(?:-[a-z]+\s+)*--recursive(?:\s+--?[a-z-]+)*\s*(?:--\s+)?["']?(?:[/~]|\$HOME\b|\$\{HOME\})/i,
    reason: '禁止递归删除根目录或用户目录',
  },



  { pattern: at('(?:mkfs(?:\\.\\w+)?|fdisk)\\b'), reason: '禁止格式化磁盘操作' },
  { pattern: /\bformat\s+[a-zA-Z]:/i, reason: '禁止格式化磁盘操作' },
  { pattern: /\bdd\s+.*of=\/dev\//i, reason: '禁止直接写入设备' },
  { pattern: at('(?:shutdown|reboot|halt|poweroff)\\b'), reason: '禁止关机/重启本机' },
  { pattern: /\bchmod\s+(?:-[a-z]+\s+)*777\s+\//i, reason: '禁止修改根目录权限（含 -R 递归与 /etc 等子路径）' },
  {
    pattern: /\b(curl|wget)\b.*\|\s*(env\s+)?(\/\w+\/)*\w*(sh|bash|zsh|dash)\b/i,
    reason: '禁止从网络管道执行脚本',
  },
  { pattern: /\$\(\s*(curl|wget)\b/i, reason: '禁止通过命令替换执行网络脚本' },
  { pattern: /`\s*(curl|wget)\b/i, reason: '禁止通过反引号执行网络脚本' },
  {
    pattern: /\b(sh|bash|zsh|dash)\s+<\(\s*(curl|wget)\b/i,
    reason: '禁止通过进程替换执行网络脚本',
  },
  { pattern: /\b(source|eval)\b.*\b(curl|wget)\b/i, reason: '禁止 source/eval 执行网络内容' },
  { pattern: /\bnpm\s+(un)?publish\b/i, reason: '禁止外部通道发布/撤回 npm 包' },
  { pattern: /\bgit\s+push\s+.*(?:--force\b|-f\b)/i, reason: '禁止强制推送' },
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: '禁止 fork 炸弹' },
  {
    pattern: /\b(curl|wget)\b.*\|\s*(python|python3|perl|ruby|node)\b/i,
    reason: '禁止从网络管道执行脚本',
  },
  {
    pattern: at(
      '(?:cat|less|more|head|tail|grep|sed|awk)\\b[^\\n;&|`]*\\s/(?:etc/(?:shadow|passwd|sudoers)|root/\\.ssh)\\b'
    ),
    reason: '禁止读取敏感系统账户/凭据文件',
  },

  { pattern: at('(?:chown|chgrp)\\b'), reason: '禁止修改文件所有者/组' },
  {
    pattern: at('(?:useradd|usermod|userdel|groupadd|groupmod|passwd)\\b'),
    reason: '禁止用户/密码管理操作',
  },

  { pattern: at('(?:nc|ncat|socat|nmap)\\b'), reason: '禁止网络工具/反弹 shell' },
  { pattern: /\/dev\/tcp\//i, reason: '禁止 bash 反向 shell' },

  {
    pattern: /\b(python|python3|perl|ruby|node)\s+-[a-zA-Z]*c\b/i,
    reason: '禁止解释器 -c 任意代码执行',
  },
  { pattern: /\b(node|python|python3|perl|ruby)\s+-e\b/i, reason: '禁止解释器 -e 任意代码执行' },

  { pattern: at('crontab\\b(?!\\s+-l\\b)'), reason: '禁止定时任务修改（crontab -l 只读列出除外）' },
  { pattern: at('at\\s+(?!-l\\b)'), reason: '禁止延迟任务执行（at -l/atq 只读除外）' },

  { pattern: at('u?mount\\b'), reason: '禁止挂载/卸载文件系统' },
  { pattern: at('(?:iptables|ufw|pft?ctl)\\b'), reason: '禁止防火墙修改' },

  { pattern: /\bfind\s+.*-exec(?:dir)?\b/i, reason: '禁止 find -exec/-execdir 任意命令执行' },
  { pattern: /\bawk\s+.*system\b/i, reason: '禁止 awk system 调用' },
  { pattern: /\btar\b.*--checkpoint-action/i, reason: '禁止 tar 命令注入' },
  { pattern: /\bzip\b.*-T[T]/i, reason: '禁止 zip 命令注入' },

  { pattern: /\bbase64\b.*\|\s*(sh|bash|zsh|dash)/i, reason: '禁止 base64 解码执行' },




  { pattern: at('(?:vim?|nano)\\b'), reason: '禁止编辑器（支持 shell escape）' },
];

const BASE_PROTECTED_PATH_KEYWORDS = [
  '/node_modules',
  '/system32',
  '/windows',
  '/.ssh',
  '/.gnupg',
  '/.cursor',
  '/.env',
  '/credentials',
  '/apikey',
  '/secret',
  '/token.json',
];

let _extraProtectedPaths: string[] = [];






export function registerProtectedPaths(paths: string[]): void {
  _extraProtectedPaths = [...paths];
}

function getAllProtectedPathKeywords(): string[] {
  return [...BASE_PROTECTED_PATH_KEYWORDS, ..._extraProtectedPaths];
}

function normalizePathForProtection(targetPath: string): string[] {
  const lower = String(targetPath || '')
    .toLowerCase()
    .replace(/\\/g, '/');
  const compact = lower.replace(/[\s_-]+/g, '');
  return compact === lower ? [lower] : [lower, compact];
}


export function stripShellPrefixBeforeHeredoc(command: string): string {
  const idx = command.indexOf('<<');
  if (idx === -1) return command;
  return command.slice(0, idx);
}


function matchesDangerousPatterns(text: string): boolean {
  for (const { pattern } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

export function isCommandDangerous(command: string): ChannelSafetyResult {
  const shellOnly = stripShellPrefixBeforeHeredoc(command);

  if (matchesDangerousPatterns(shellOnly)) {
    for (const { pattern, reason } of DANGEROUS_COMMAND_PATTERNS) {
      if (pattern.test(shellOnly)) return { blocked: true, reason };
    }
  }

  const heredocMatch = command.match(/<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1/);
  if (heredocMatch) {
    const heredocBody = heredocMatch[2];
    if (matchesDangerousPatterns(heredocBody)) {
      for (const { pattern, reason } of DANGEROUS_COMMAND_PATTERNS) {
        if (pattern.test(heredocBody)) return { blocked: true, reason };
      }
    }
    const afterHeredoc = command.slice(heredocMatch.index! + heredocMatch[0].length);
    if (afterHeredoc && matchesDangerousPatterns(afterHeredoc)) {
      for (const { pattern, reason } of DANGEROUS_COMMAND_PATTERNS) {
        if (pattern.test(afterHeredoc)) return { blocked: true, reason };
      }
    }
  }
  return { blocked: false };
}

export function isPathProtected(targetPath: string): boolean {
  const haystacks = normalizePathForProtection(targetPath);
  return getAllProtectedPathKeywords().some((kw) => {
    const needles = normalizePathForProtection(kw);
    return needles.some((needle) => haystacks.some((haystack) => haystack.includes(needle)));
  });
}

const APPROVAL_KEYWORDS_ALLOW: string[] = [
  '允许',
  '同意',
  '好的',
  '可以',
  '确认',
  '批准',
  'ok',
  'yes',
  'approve',
  '通过',
  '行',
  '没问题',
  '继续',
  '执行吧',
  'go',
  '好',
  '嗯',
  '对',
];

const APPROVAL_KEYWORDS_DENY: string[] = [
  '拒绝',
  '不行',
  '不要',
  '取消',
  '停止',
  '不可以',
  '不允许',
  '不同意',
  'no',
  'deny',
  'reject',
  '算了',
  '别执行',
  'stop',
  'cancel',
];

export type TextApprovalResult =
  | { matched: true; decision: 'allow_once' | 'deny' }
  | { matched: false };

export function matchTextApproval(text: string): TextApprovalResult {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return { matched: false };

  if (APPROVAL_KEYWORDS_ALLOW.some((kw) => trimmed === kw)) {
    return { matched: true, decision: 'allow_once' };
  }
  if (APPROVAL_KEYWORDS_DENY.some((kw) => trimmed === kw)) {
    return { matched: true, decision: 'deny' };
  }

  return { matched: false };
}

const DOC_EXT_SET = new Set([
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'pdf',
  'csv',
  'txt',
  'md',
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
]);

export function classifyFileKind(filePath: string): 'image' | 'video' | 'document' | null {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const IMG = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp']);
  const VID = new Set(['mp4', 'webm', 'avi', 'mov', 'mkv']);
  if (IMG.has(ext)) return 'image';
  if (VID.has(ext)) return 'video';
  if (DOC_EXT_SET.has(ext)) return 'document';
  return null;
}

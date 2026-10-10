/**
 * Chinese labels for config source ids ('user', 'project', 'env:NAME', …).
 * Doctor, the config snapshot, onboarding and the config audit share this
 * map so a source id from any resolver path is never printed raw in zh.
 */
const ZH_SOURCE: Readonly<Record<string, string>> = {
  default: '默认',
  'provider default': '服务商默认',
  unconfigured: '未配置',
  'derived:mode': '由权限模式推导',
  missing: '缺失',
  config: '配置文件',
  user: '用户配置',
  project: '项目配置',
  legacy: '旧版配置',
  env: '环境变量',
  cli: '命令行',
  'built-in': '内置',
  unprobed: '未探测',
  cwd: '当前目录',
  'provider-api': '服务商接口',
};

/**
 * Translate one source id, or a comma-joined list of them, to Chinese.
 * `glossProfile` names a profile (e.g. `profile:fast`); unknown ids stay literal.
 */
export function zhConfigSource(
  source: string,
  glossProfile: (name: string) => string = (name) => name
): string {
  if (source.includes(', ')) {
    return source
      .split(', ')
      .map((part) => zhConfigSource(part, glossProfile))
      .join('、');
  }
  if (source.startsWith('env:')) return `环境变量 ${source.slice(4)}`;
  if (source.startsWith('MOSS_')) return `环境变量 ${source}`;
  if (source.startsWith('profile:')) return `配置档：${glossProfile(source.slice(8))}`;
  return ZH_SOURCE[source] ?? source;
}

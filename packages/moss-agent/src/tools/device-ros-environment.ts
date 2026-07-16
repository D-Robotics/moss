export interface RosEnvironmentOptions {
  commandName: 'ros2' | 'rostopic';
  command: string;
  rosDomainId?: number;
}

export function buildRosEnvironmentCommand(options: RosEnvironmentOptions): string {
  const domain =
    options.commandName === 'ros2' && Number.isInteger(options.rosDomainId)
      ? `export ROS_DOMAIN_ID=${options.rosDomainId};`
      : '';
  return [
    'set +u',
    domain,
    `if ! command -v ${options.commandName} >/dev/null 2>&1; then`,
    '  for setup in /opt/tros/*/setup.bash /opt/ros/*/setup.bash "$HOME"/*/devel/setup.bash "$HOME"/*/install/setup.bash "$HOME"/*/*/devel/setup.bash "$HOME"/*/*/install/setup.bash; do',
    '    [ -f "$setup" ] || continue',
    '    . "$setup" >/dev/null 2>&1 || continue',
    `    command -v ${options.commandName} >/dev/null 2>&1 && break`,
    '  done',
    'fi',
    `command -v ${options.commandName} >/dev/null 2>&1 || { echo "${options.commandName} is not available; install/source the matching ROS environment" >&2; exit 127; }`,
    options.command,
  ].filter(Boolean).join('\n');
}

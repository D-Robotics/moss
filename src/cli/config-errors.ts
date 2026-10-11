export class CliConfigFileError extends Error {
  readonly configPath: string;

  constructor(configPath: string, reason: string) {
    super(`Invalid moss config at ${configPath}: ${reason}`);
    this.name = 'CliConfigFileError';
    this.configPath = configPath;
  }
}

/**
 * O89: a config file error whose displayed message is fully localized. Under
 * the zh UI the base class's English frame (`Invalid moss config at …`) would
 * itself put non-whitelisted English words into the copy, so this subclass
 * replaces the whole message while keeping `name`, `configPath`, and the
 * `instanceof CliConfigFileError` checks cli-main and the exit-code mapping
 * rely on.
 */
export class CliLocalizedConfigFileError extends CliConfigFileError {
  constructor(configPath: string, localizedMessage: string) {
    super(configPath, localizedMessage);
    this.message = localizedMessage;
  }
}

export class CliConfigWriteError extends Error {
  readonly configPath: string;

  constructor(configPath: string, reason: string) {
    super(`cannot write config to ${configPath}: ${reason}`);
    this.name = 'CliConfigWriteError';
    this.configPath = configPath;
  }
}

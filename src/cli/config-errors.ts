export class CliConfigFileError extends Error {
  readonly configPath: string;

  constructor(configPath: string, reason: string) {
    super(`Invalid moss config at ${configPath}: ${reason}`);
    this.name = 'CliConfigFileError';
    this.configPath = configPath;
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

/**
 * An input validation error whose text is written for the person editing the settings (it never carries a stored value)
 * and is shown as is when saving fails. Any other error is reduced to a generic line, so a module has to opt in.
 */
export class SettingsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsInputError';
  }
}

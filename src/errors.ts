/** Errors that come from the caller's arguments rather than from the server. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/**
 * An IMAP failure, carrying whatever the server said.
 *
 * `responseText` is upstream output and gets the same truncation treatment as
 * any other remote string before it reaches the model.
 */
export class MailError extends Error {
  /** Nothing of the command reached the server, so repeating it cannot do anything twice. */
  readonly neverSent: boolean;

  constructor(
    message: string,
    readonly code: string | undefined = undefined,
    readonly responseText: string = '',
    options: { neverSent?: boolean } = {}
  ) {
    super(message);
    this.name = 'MailError';
    this.neverSent = options.neverSent === true;
  }
}

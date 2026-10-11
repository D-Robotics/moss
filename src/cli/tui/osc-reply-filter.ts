/**
 * OSC terminal replies (the OSC 11 background answer in particular) must never
 * reach the composer as typed text. Ink hands unknown escape sequences to
 * useInput with the leading ESC stripped, and the pty may split a reply at any
 * byte boundary — a reply delivered as `\x1b]11` + `;rgb:…\x07` arrives as two
 * chunks (`]11`, then `;rgb:…`), neither of which matches a `]11;` search.
 * This filter reassembles replies across chunk boundaries and yields everything
 * else unchanged. It works on the post-ink mangled form, so it never relies on
 * seeing the ESC byte of the reply head.
 */

const REPLY_PREFIX = ']11;';

/** A reply longer than this without a terminator is typed text, not a reply. */
const MAX_PENDING = 48;

/** Proper suffixes of the reply prefix: a chunk ending in one may be a split head. */
const PARTIAL_SUFFIXES = [']11', ']1', ']'] as const;

/** BEL, ESC (start of ST), or the backslash tail of an ESC-less ST. */
const TERMINATOR = /[\u0007\u001b\\]/;

export interface OscReplyFilterResult {
  /** Bytes that are not part of a terminal reply; safe to treat as user input. */
  passthrough: string;
  /** Payload of a completed OSC 11 reply, if one completed during this feed. */
  body?: string;
}

export interface OscReplyFilter {
  feed(chunk: string): OscReplyFilterResult;
}

export function createOsc11ReplyFilter(): OscReplyFilter {
  let pending = '';
  let collecting = false;
  let swallowStTail = false;

  const finishPending = (): OscReplyFilterResult => {
    const term = pending.search(TERMINATOR);
    if (term !== -1) {
      const body = pending.slice(REPLY_PREFIX.length, term);
      let rest = pending.slice(term + 1);
      const termChar = pending[term];
      if (termChar === '\u001b' && rest.startsWith('\\')) rest = rest.slice(1);
      pending = '';
      collecting = false;
      swallowStTail = rest === '' && termChar === '\u001b';
      return { passthrough: rest, body: body === '' ? undefined : body };
    }
    if (pending.length > MAX_PENDING) {
      const held = pending;
      pending = '';
      collecting = false;
      return { passthrough: held };
    }
    return { passthrough: '' };
  };

  const feed = (chunk: string): OscReplyFilterResult => {
    if (swallowStTail && chunk.startsWith('\\')) {
      swallowStTail = false;
      chunk = chunk.slice(1);
    }
    swallowStTail = false;
    const acc = pending + chunk;
    if (!collecting) {
      pending = '';
      const start = acc.indexOf(REPLY_PREFIX);
      if (start === -1) {
        for (const part of PARTIAL_SUFFIXES) {
          if (acc.endsWith(part)) {
            pending = part;
            return { passthrough: acc.slice(0, acc.length - part.length) };
          }
        }
        return { passthrough: acc };
      }
      pending = acc.slice(start);
      collecting = true;
      let head = acc.slice(0, start);
      if (head.endsWith('\u001b')) head = head.slice(0, -1);
      const tail = finishPending();
      return { passthrough: head + tail.passthrough, body: tail.body };
    }
    pending = acc;
    return finishPending();
  };

  return { feed };
}

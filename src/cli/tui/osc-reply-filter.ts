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
  /** Flush a partial head as literal input before a composer control key. */
  flushText(): string;
}

export function createOsc11ReplyFilter(): OscReplyFilter {
  let pending = '';
  let collecting = false;
  let swallowStTail = false;

  const feed = (chunk: string): OscReplyFilterResult => {
    if (swallowStTail && chunk.startsWith('\\')) {
      swallowStTail = false;
      chunk = chunk.slice(1);
    }
    swallowStTail = false;
    let acc = pending + chunk;
    pending = '';
    let passthrough = '';
    let body: string | undefined;
    for (;;) {
      if (collecting) {
        const term = acc.search(TERMINATOR);
        if (term === -1) {
          if (acc.length > MAX_PENDING) {
            collecting = false;
            return { passthrough: passthrough + acc, body };
          }
          pending = acc;
          return { passthrough, body };
        }
        body = acc.slice(REPLY_PREFIX.length, term) || body;
        const termChar = acc[term];
        acc = acc.slice(term + 1);
        if (termChar === '\u001b' && acc.startsWith('\\')) acc = acc.slice(1);
        swallowStTail = acc === '' && termChar === '\u001b';
        collecting = false;
      }
      const start = acc.indexOf(REPLY_PREFIX);
      if (start === -1) {
        for (const part of PARTIAL_SUFFIXES) {
          if (acc.endsWith(part)) {
            pending = part;
            return { passthrough: passthrough + acc.slice(0, acc.length - part.length), body };
          }
        }
        return { passthrough: passthrough + acc, body };
      }
      collecting = true;
      let head = acc.slice(0, start);
      if (head.endsWith('\u001b')) head = head.slice(0, -1);
      passthrough += head;
      acc = acc.slice(start);
    }
  };

  return {
    feed,
    flushText() {
      if (collecting) return '';
      const held = pending;
      pending = '';
      return held;
    },
  };
}

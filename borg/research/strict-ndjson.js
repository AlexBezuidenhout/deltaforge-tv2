'use strict';

/**
 * Yield records framed by the NDJSON delimiter byte (LF) only.
 *
 * Node's readline also treats Unicode U+2028/U+2029 as line separators. Both
 * are legal inside JSON strings, so readline can truncate valid market/rule
 * text and make a causal replay silently omit evidence. Buffer until LF before
 * UTF-8 decoding so multibyte characters split across chunks remain intact.
 */
async function* lfDelimitedLines(readable) {
  let pending = Buffer.alloc(0);
  for await (const rawChunk of readable) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let start = 0;
    let end = chunk.indexOf(0x0a, start);
    while (end !== -1) {
      let line = pending.length
        ? Buffer.concat([pending, chunk.subarray(start, end)])
        : chunk.subarray(start, end);
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      yield line.toString('utf8');
      pending = Buffer.alloc(0);
      start = end + 1;
      end = chunk.indexOf(0x0a, start);
    }
    if (start < chunk.length) {
      const tail = chunk.subarray(start);
      pending = pending.length ? Buffer.concat([pending, tail]) : Buffer.from(tail);
    }
  }
  if (pending.length) yield pending.toString('utf8');
}

module.exports = { lfDelimitedLines };

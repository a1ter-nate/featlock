const PY_EXT = ".py";
const SINGLE_QUOTE_STRING_EXTS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs", ".py"]);
const BACKTICK_EXTS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs", ".go"]);

function pushSpaces(out: string[], ch: string): void {
  out.push(ch === "\n" ? "\n" : " ");
}

function consumeQuoted(src: string, start: number, quote: string, out: string[]): number {
  out.push(quote);
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i] ?? "";
    if (ch === "\\" && i + 1 < src.length) {
      pushSpaces(out, ch);
      pushSpaces(out, src[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (ch === quote) {
      out.push(quote);
      return i + 1;
    }
    if (ch === "\n" && quote !== "`") {
      out.push("\n");
      return i + 1;
    }
    pushSpaces(out, ch);
    i += 1;
  }
  return i;
}

function consumeTripleQuote(src: string, start: number, quote: string, out: string[]): number {
  out.push(quote, quote, quote);
  let i = start + 3;
  while (i < src.length) {
    if (src.startsWith(quote.repeat(3), i)) {
      out.push(quote, quote, quote);
      return i + 3;
    }
    const ch = src[i] ?? "";
    if (ch === "\\" && i + 1 < src.length) {
      pushSpaces(out, ch);
      pushSpaces(out, src[i + 1] ?? "");
      i += 2;
      continue;
    }
    pushSpaces(out, ch);
    i += 1;
  }
  return i;
}

function maskPython(src: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? "";
    if (ch === "#") {
      while (i < src.length && src[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
      continue;
    }
    if ((ch === '"' || ch === "'") && src.startsWith(ch.repeat(3), i)) {
      i = consumeTripleQuote(src, i, ch, out);
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = consumeQuoted(src, i, ch, out);
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}

function maskCLike(src: string, ext: string): string {
  if (!ext) throw new Error("File extension is required for lexical masking.");
  const out: string[] = [];
  const allowSingle = SINGLE_QUOTE_STRING_EXTS.has(ext);
  const allowBacktick = BACKTICK_EXTS.has(ext);
  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? "";
    const next = src[i + 1] ?? "";
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        pushSpaces(out, src[i] ?? "");
        i += 1;
      }
      if (i + 1 < src.length) {
        out.push(" ", " ");
        i += 2;
      }
      continue;
    }
    if (ch === '"' || (ch === "'" && allowSingle) || (ch === "`" && allowBacktick)) {
      i = consumeQuoted(src, i, ch, out);
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}

export function maskSourceForGuards(content: string, ext: string): string {
  if (!content) return "";
  if (ext === PY_EXT) return maskPython(content);
  return maskCLike(content, ext);
}

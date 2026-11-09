import { attrs, decode, local, TOKEN } from '../gpx/parse';

/** An XML element: its local name (namespace prefix dropped, lower-cased), attributes, child
 *  elements and the text directly inside it. */
export interface El {
  tag: string;
  attrs: Record<string, string>;
  children: El[];
  text: string;
}

/** Reads XML into a tree with the GPX reader's scanner (no DOMParser, so it runs in tests and
 *  workers). Forgiving: a stray closing tag is skipped, unclosed elements close at the end. */
export function parseXml(xml: string): El {
  const root: El = { tag: '', attrs: {}, children: [], text: '' };
  const stack: El[] = [root];
  for (const m of xml.matchAll(TOKEN)) {
    const [, cdata, close, rawTag, rawAttrs, selfClose, chars] = m;
    const top = stack[stack.length - 1];
    if (cdata !== undefined || chars !== undefined) {
      top.text += cdata ?? decode(chars!);
      continue;
    }
    if (!rawTag) continue;
    const tag = local(rawTag);
    if (close) {
      let at = stack.length - 1;
      while (at > 0 && stack[at].tag !== tag) at--;
      if (at > 0) stack.length = at;
      continue;
    }
    const el: El = { tag, attrs: attrs(rawAttrs ?? ''), children: [], text: '' };
    top.children.push(el);
    if (!selfClose) stack.push(el);
  }
  return root;
}

/** The first child element named `tag`. */
export const child = (e: El, tag: string): El | undefined => e.children.find((c) => c.tag === tag);

/** The trimmed text of the first child named `tag`, or null. */
export const childText = (e: El, tag: string): string | null => {
  const c = child(e, tag);
  return c ? c.text.trim() : null;
};

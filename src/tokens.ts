import { getEncoding, type TiktokenEncoding } from "js-tiktoken";

export interface Tokenizer {
  name: string;
  count(text: string): number;
}

// Encoders are slow to build, so each is created on first use and reused.
function lazy(name: TiktokenEncoding): Tokenizer {
  let enc: ReturnType<typeof getEncoding> | undefined;
  return { name, count: (text) => (enc ??= getEncoding(name)).encode(text).length };
}

// OpenAI tokenizers stand in for "a real BPE tokenizer". Claude's tokenizer differs;
// never present these counts as Claude counts.
export const o200k = lazy("o200k_base");
export const cl100k = lazy("cl100k_base");

/**
 * Split text into chunks of at most charLimit characters, preferring paragraph
 * boundaries, then line boundaries, hard-splitting only as a last resort.
 */
export function splitText(text: string, charLimit = 4000): string[] {
  if (text.length <= charLimit) return [text];

  const chunks: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };

  const append = (piece: string, separator: string): void => {
    if (!current) {
      current = piece;
      return;
    }
    if (current.length + separator.length + piece.length <= charLimit) {
      current += separator + piece;
    } else {
      flush();
      current = piece;
    }
  };

  for (const paragraph of text.split("\n\n")) {
    if (paragraph.length <= charLimit) {
      append(paragraph, "\n\n");
      continue;
    }
    for (const line of paragraph.split("\n")) {
      if (line.length <= charLimit) {
        append(line, "\n");
        continue;
      }
      for (let i = 0; i < line.length; i += charLimit) {
        append(line.slice(i, i + charLimit), "\n");
      }
    }
  }
  flush();
  return chunks;
}

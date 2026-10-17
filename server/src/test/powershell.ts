// Reading the Windows install scripts back in tests: every Chinese line in them is written as its UTF-16 code units
// (`powershellText`, local-executor/install-script.ts), so the script itself is ASCII. These are the lines it can print.
const TEXT = /\(-join \[char\[\]\]@\(((?:0x[0-9a-f]{4},?)+)\)\)/gi;

export function decodedLines(script: string): string[] {
  return [...script.matchAll(TEXT)].map((match) => String.fromCharCode(...match[1]!.split(',').map((unit) => Number.parseInt(unit, 16))));
}

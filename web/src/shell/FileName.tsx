// A file name on one line with a middle ellipsis (DESIGN.md「版式统一」): the head shrinks with an ellipsis, the tail
// (last digits, date stamp and extension) always shows, because names from one supplier share the head and differ
// in the tail. The full name is the hover title and stays the element's text content for readers and locators.
// Short names render as one text node.
const TAIL = 12;

export function splitFileName(name: string): { head: string; tail: string } {
  if (name.length <= TAIL * 2) return { head: name, tail: '' };
  return { head: name.slice(0, -TAIL), tail: name.slice(-TAIL) };
}

// `title` replaces the hover text when a page adds to it (the upload row appends the content hash).
export function FileName({ name, title = name, className }: { name: string; title?: string; className?: string }) {
  const { head, tail } = splitFileName(name);
  if (!tail) {
    return (
      <span className={className ? `app-filename is-short ${className}` : 'app-filename is-short'} title={title}>
        {name}
      </span>
    );
  }
  return (
    <span className={className ? `app-filename ${className}` : 'app-filename'} title={title}>
      <span className="app-filename-head">{head}</span>
      <span className="app-filename-tail">{tail}</span>
    </span>
  );
}

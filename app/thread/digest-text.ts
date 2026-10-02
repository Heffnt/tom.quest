type SlackSegment = { text: string } | { text: string; href: string };

function unescapeSlack(text: string): string {
  return text.replace(/&(amp|lt|gt);/g, (_, escape: string) => (
    escape === "amp" ? "&" : escape === "lt" ? "<" : ">"
  ));
}

export function slackSegments(text: string): SlackSegment[] {
  const segments: SlackSegment[] = [];
  const links = /<([^<>|\n]+)(?:\|([^<>\n]*))?>/g;
  let end = 0;

  function plain(value: string) {
    if (value === "") return;
    const decoded = unescapeSlack(value);
    const previous = segments.at(-1);
    if (previous !== undefined && !("href" in previous)) previous.text += decoded;
    else segments.push({ text: decoded });
  }

  for (const match of text.matchAll(links)) {
    plain(text.slice(end, match.index));
    const [whole, href, label] = match;
    if (href.startsWith("https://") || href.startsWith("/")) {
      segments.push({ text: unescapeSlack(label ?? href), href });
    } else {
      plain(whole);
    }
    end = (match.index ?? 0) + whole.length;
  }
  plain(text.slice(end));
  return segments;
}

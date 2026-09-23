/**
 * Escapes text for inclusion in the XML-ish blocks a host injects into a conversation.
 *
 * Skill content is untrusted instruction input, and the catalog and instruction blocks wrap it in
 * markup a model reads structurally. Without this, a description containing `</skill>` could close
 * the surrounding element and have whatever followed read as the host's own framing rather than as
 * the skill's content.
 */
export function escapeXml(value: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  };

  return value.replace(/[&<>"']/g, (character) => entities[character] ?? character);
}

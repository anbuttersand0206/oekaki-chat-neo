/**
 * Shared utility functions for the Oekaki Chat Neo frontend.
 */

/**
 * Escapes special HTML characters in a string to prevent XSS attacks.
 * @param s The string to escape.
 * @returns The escaped string.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * OAuth types
 * Based on the original project's src/modules/oauth.js
 */

// OAuth model alias
export interface OAuthModelAliasEntry {
  name: string;
  alias: string;
  fork?: boolean;
  forceMapping?: boolean;
  /**
   * The config entry this row was read from. Saves start from it and change only
   * the fields the UI edited, so display-name and any other keys survive.
   */
  raw?: Record<string, unknown>;
  /** Provider key spelling this entry was read under (e.g. `Codex`, `gemini_cli`). */
  sourceKey?: string;
}

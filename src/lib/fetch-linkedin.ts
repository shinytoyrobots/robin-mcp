/**
 * LinkedIn has no public API for profile data.
 * This module returns a static resource linking to the configured profile URL.
 * For actual content, use the http-fetch tool on the public profile page.
 */
export function getLinkedInResource(linkedinUrl: string): string {
  if (!linkedinUrl) {
    return "No LinkedIn URL configured. Set LINKEDIN_URL in .env";
  }

  return [
    "# LinkedIn Profile",
    "",
    `Profile URL: ${linkedinUrl}`,
    "",
    "LinkedIn does not provide a public API for profile data.",
    "To fetch the public profile page, use the `http-fetch` tool with this URL.",
  ].join("\n");
}

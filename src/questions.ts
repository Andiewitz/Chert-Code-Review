// Question template for the review screen's lens. Kept in one place so the
// wording is easy to find and edit.
export const QUESTIONS = {
  messy: (path: string) =>
    `Look at the uncommitted changes in ${path}. Is this code messy or hard to read? Explain in plain words, with the exact lines.`,
} as const

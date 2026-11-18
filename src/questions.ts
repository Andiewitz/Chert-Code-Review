// Question templates for the review screen's two lenses. Kept in one place so
// the wording is easy to find and edit.
export const QUESTIONS = {
  messy: (path: string) =>
    `Look at the uncommitted changes in ${path}. Is this code messy or hard to read? Explain in plain words, with the exact lines.`,
  safe: (path: string) =>
    `Look at the uncommitted changes in ${path}. Is there anything unsafe or that could break? Explain in plain words, with the exact lines.`,
} as const

export type QuestionKey = keyof typeof QUESTIONS

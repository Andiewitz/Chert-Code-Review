// Question templates for the guided review screen's lens buttons.
// Prompt 2 will upgrade these (better wording, diff context, etc.).
// Keep all lens wording here so it is easy to find and edit in one place.
export const QUESTIONS = {
  slow: (path: string) =>
    `Look at the uncommitted changes in ${path}. Could this code get slow when there is a lot of data? Explain in plain words, with the exact lines.`,
  messy: (path: string) =>
    `Look at the uncommitted changes in ${path}. Is this code messy or hard to read? Explain in plain words, with the exact lines.`,
  safe: (path: string) =>
    `Look at the uncommitted changes in ${path}. Is there anything unsafe or that could break? Explain in plain words, with the exact lines.`,
} as const

export type QuestionKey = keyof typeof QUESTIONS

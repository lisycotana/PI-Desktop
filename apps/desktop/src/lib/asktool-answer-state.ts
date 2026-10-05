import type { AskToolQuestion } from "@pi-desktop/shared";

export type DraftAnswer = {
  values: string[];
  customSelected: boolean;
  customText: string;
  skipped: boolean;
};

export const CUSTOM_OPTION = "__asktool_custom__";

export function emptyDrafts(questions: AskToolQuestion[]): DraftAnswer[] {
  return questions.map(() => ({
    values: [],
    customSelected: false,
    customText: "",
    skipped: false,
  }));
}

export function currentValues(draft: DraftAnswer): string[] {
  return [...draft.values, ...(draft.customSelected && draft.customText.trim() ? [draft.customText.trim()] : [])];
}

export function draftAnswers(drafts: DraftAnswer[]): Array<string[] | null> {
  return drafts.map((draft) => {
    const values = currentValues(draft);
    return values.length > 0 && !draft.skipped ? values : null;
  });
}

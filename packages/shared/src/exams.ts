import type { Modality } from "./domain.js";

export interface ExamDefinition {
  code: string;
  modality: Modality;
  contrast: boolean;
  /** How the agent says it aloud. */
  label: string;
  labelFr: string;
}

export const EXAMS = [
  {
    code: "MRI_KNEE",
    modality: "MRI",
    contrast: false,
    label: "MRI of the knee",
    labelFr: "IRM du genou",
  },
  {
    code: "MRI_BRAIN",
    modality: "MRI",
    contrast: true,
    label: "MRI of the brain with contrast",
    labelFr: "IRM du cerveau avec contraste",
  },
  {
    code: "MRI_LSPINE",
    modality: "MRI",
    contrast: false,
    label: "MRI of the lower spine",
    labelFr: "IRM de la colonne lombaire",
  },
  {
    code: "CT_HEAD",
    modality: "CT",
    contrast: false,
    label: "CT of the head",
    labelFr: "TDM de la tête",
  },
  {
    code: "CT_CHEST",
    modality: "CT",
    contrast: false,
    label: "CT of the chest",
    labelFr: "TDM du thorax",
  },
  {
    code: "CT_ABDO",
    modality: "CT",
    contrast: true,
    label: "CT of the abdomen with contrast",
    labelFr: "TDM de l'abdomen avec contraste",
  },
] as const satisfies readonly ExamDefinition[];

export type ExamCode = (typeof EXAMS)[number]["code"];

export function examLabel(code: string, language: "en" | "fr" = "en"): string {
  const exam = EXAMS.find((e) => e.code === code);
  if (!exam) return language === "fr" ? "votre examen" : "your exam";
  return language === "fr" ? exam.labelFr : exam.label;
}

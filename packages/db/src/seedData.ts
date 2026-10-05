/** Static synthetic reference data for the seed. No real people or clinics. */

export { EXAMS } from "@clinicvoice/shared";

export const SITES = [
  {
    code: "MISS",
    name: "Lakeshore MRI & CT Mississauga",
    address: "2150 Lakeshore Road West, Mississauga, Ontario",
    modalities: ["MRI", "CT"],
    hours: {
      "1": "07:00-21:00",
      "2": "07:00-21:00",
      "3": "07:00-21:00",
      "4": "07:00-21:00",
      "5": "07:00-21:00",
      "6": "08:00-16:00",
      "7": null,
    },
    parking: "Free surface parking behind the building. Accessible spots by the main entrance.",
  },
  {
    code: "TOR",
    name: "Lakeshore MRI & CT Toronto Downtown",
    address: "480 University Avenue, Suite 300, Toronto, Ontario",
    modalities: ["MRI", "CT"],
    hours: {
      "1": "07:00-20:00",
      "2": "07:00-20:00",
      "3": "07:00-20:00",
      "4": "07:00-20:00",
      "5": "07:00-20:00",
      "6": null,
      "7": null,
    },
    parking: "Paid underground parking on Elm Street. Closest subway is St. Patrick station.",
  },
  {
    code: "OAK",
    name: "Lakeshore CT Oakville",
    address: "1235 Trafalgar Road, Oakville, Ontario",
    modalities: ["CT"],
    hours: {
      "1": "08:00-18:00",
      "2": "08:00-18:00",
      "3": "08:00-18:00",
      "4": "08:00-18:00",
      "5": "08:00-18:00",
      "6": "09:00-13:00",
      "7": null,
    },
    parking: "Free parking in the plaza lot.",
  },
] as const;

export const SLOT_MINUTES = { MRI: 45, CT: 20 } as const;

/**
 * Patients the scripted conversation suite and the README refer to by name. Keep stable.
 * Phone numbers use the reserved fictional 555-01xx range.
 */
export const DEMO_PATIENTS = [
  {
    first: "Maria",
    last: "Santos",
    dob: "1984-03-12",
    phone: "+14165550121",
    lang: "en",
    exam: "MRI_KNEE",
    booked: true,
  },
  {
    first: "Jean",
    last: "Tremblay",
    dob: "1979-11-02",
    phone: "+14165550134",
    lang: "fr",
    exam: "MRI_BRAIN",
    booked: true,
  },
  {
    first: "David",
    last: "Okafor",
    dob: "1962-07-25",
    phone: "+14165550147",
    lang: "en",
    exam: "CT_ABDO",
    booked: true,
  },
  {
    first: "Priya",
    last: "Raman",
    dob: "1991-01-30",
    phone: "+14165550158",
    lang: "en",
    exam: "MRI_LSPINE",
    booked: false,
  },
] as const;

export const FIRST_NAMES = [
  "Aisha",
  "Benjamin",
  "Chloe",
  "Daniel",
  "Elena",
  "Farid",
  "Grace",
  "Hiroshi",
  "Isabelle",
  "Jamal",
  "Karen",
  "Liam",
  "Mei",
  "Nathan",
  "Olivia",
  "Pedro",
  "Quinn",
  "Rachel",
  "Samuel",
  "Tanvi",
  "Umar",
  "Valerie",
  "William",
  "Ximena",
  "Yusuf",
  "Zoe",
  "Amir",
  "Brigitte",
  "Carlos",
  "Dana",
  "Ethan",
  "Fatima",
  "Gabriel",
  "Hannah",
  "Ivan",
  "Julia",
];

export const LAST_NAMES = [
  "Anderson",
  "Bouchard",
  "Chen",
  "Dubois",
  "Evans",
  "Fernandes",
  "Gagnon",
  "Haddad",
  "Ivanova",
  "Jensen",
  "Kowalski",
  "Lefebvre",
  "MacDonald",
  "Nguyen",
  "Osei",
  "Patel",
  "Roy",
  "Singh",
  "Thompson",
  "Usman",
  "Valdez",
  "Wong",
  "Yamamoto",
  "Zhang",
  "Ahmed",
  "Brown",
  "Campbell",
  "Desai",
  "Ellis",
  "Fraser",
  "Gill",
  "Hughes",
  "Ibrahim",
  "Johnson",
  "Kaur",
  "Lam",
];

export const PREP_TEMPLATES: Record<string, { en: string; fr: string }> = {
  MRI_KNEE: {
    en: "Lakeshore MRI & CT: For your knee MRI, wear clothing without metal and arrive 15 minutes early. Remove jewellery before your scan. Questions? Call us back.",
    fr: "Lakeshore IRM et TDM : Pour votre IRM du genou, portez des vêtements sans métal et arrivez 15 minutes à l'avance. Retirez vos bijoux avant l'examen.",
  },
  MRI_BRAIN: {
    en: "Lakeshore MRI & CT: For your brain MRI with contrast, arrive 30 minutes early. You may eat and drink normally. Tell staff about any kidney problems or allergies.",
    fr: "Lakeshore IRM et TDM : Pour votre IRM du cerveau avec produit de contraste, arrivez 30 minutes à l'avance. Informez le personnel de tout problème rénal ou allergie.",
  },
  MRI_LSPINE: {
    en: "Lakeshore MRI & CT: For your spine MRI, wear clothing without metal and arrive 15 minutes early. The scan takes about 30 minutes.",
    fr: "Lakeshore IRM et TDM : Pour votre IRM de la colonne, portez des vêtements sans métal et arrivez 15 minutes à l'avance. L'examen dure environ 30 minutes.",
  },
  CT_HEAD: {
    en: "Lakeshore MRI & CT: For your head CT, arrive 15 minutes early. No special preparation is needed.",
    fr: "Lakeshore IRM et TDM : Pour votre TDM de la tête, arrivez 15 minutes à l'avance. Aucune préparation particulière n'est nécessaire.",
  },
  CT_CHEST: {
    en: "Lakeshore MRI & CT: For your chest CT, arrive 15 minutes early and remove any metal from your upper body.",
    fr: "Lakeshore IRM et TDM : Pour votre TDM du thorax, arrivez 15 minutes à l'avance et retirez tout métal du haut du corps.",
  },
  CT_ABDO: {
    en: "Lakeshore MRI & CT: For your abdominal CT with contrast, do not eat for 4 hours before. Clear fluids are fine. Arrive 60 minutes early to drink oral contrast.",
    fr: "Lakeshore IRM et TDM : Pour votre TDM abdominale avec contraste, ne mangez pas pendant 4 heures avant. Les liquides clairs sont permis. Arrivez 60 minutes à l'avance.",
  },
};

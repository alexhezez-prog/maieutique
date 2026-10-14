/**
 * Maïeutique — relais serveur (Cloudflare Worker)
 *
 * Rôle : recevoir la demande du parent (sujet, niveau, texte de la leçon,
 * consignes), appeler l'API Claude avec la clé secrète et renvoyer du JSON.
 * La clé API ne quitte jamais ce serveur.
 *
 * Requêtes : { step: "preparer" | "fiche" | "qcm", ... }
 *
 * Variables à définir dans Cloudflare (Settings > Variables and Secrets) :
 *   ANTHROPIC_API_KEY  (secret)  clé API Anthropic
 *   ACCESS_CODE        (secret)  code d'accès saisi dans l'appli (anti-abus)
 *   ALLOWED_ORIGIN     (texte)   ex. https://alexhezez-prog.github.io   (ou * pour tester)
 *   MODEL              (texte, optionnel) défaut : claude-sonnet-5-5
 */

const DEFAULT_MODEL = "claude-sonnet-5-5";
const FALLBACK_MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5-20251001"];
const MAX_TEXT = 40_000;
const MAX_LECON = 30_000;

/* =====================================================================
   OUTILS COMMUNS
   ===================================================================== */

function corsHeaders(env, request) {
  const allowed = env.ALLOWED_ORIGIN || "*";
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = allowed === "*" ? "*" : (origin === allowed ? origin : allowed);
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Access-Code",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function text(v, max = MAX_TEXT) {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/** Remet en forme les tableaux/objets parfois renvoyés sous forme de texte JSON. */
function normalize(v, depth = 0) {
  if (depth > 6) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if ((t.startsWith("[") && t.endsWith("]")) || (t.startsWith("{") && t.endsWith("}"))) {
      try { return normalize(JSON.parse(t), depth + 1); } catch { return v; }
    }
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => normalize(x, depth + 1));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = normalize(x, depth + 1);
    return o;
  }
  return v;
}
const asArray = (v) => (Array.isArray(v) ? v : []);

async function callTool(env, { system, content, tool, maxTokens = 4096 }) {
  const models = [...new Set([env.MODEL || DEFAULT_MODEL, ...FALLBACK_MODELS])];
  let lastError = "Réponse inattendue du service d'IA.";

  for (const model of models) {
    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: system + `\n\nTu dois OBLIGATOIREMENT répondre en appelant l'outil ${tool.name}, sans aucun texte autour.`,
          tools: [tool],
          tool_choice: { type: "auto" },
          messages: [{ role: "user", content }],
        }),
      });
    } catch {
      throw new UserError("Impossible de joindre le service d'IA. Réessaie dans un instant.", 502);
    }

    if (!res.ok) {
      const detail = await res.text();
      console.log("Anthropic error", model, res.status, detail);
      if (res.status === 429 || res.status === 529) {
        throw new UserError("Le service est très demandé. Réessaie dans une minute.", 502);
      }
      if (res.status === 400 || res.status === 404) {
        lastError = "Le service d'IA a renvoyé une erreur (" + res.status + ").";
        continue;
      }
      throw new UserError("Le service d'IA a renvoyé une erreur (" + res.status + ").", 502);
    }

    const data = await res.json();
    const block = (data.content || []).find((b) => b.type === "tool_use" && b.name === tool.name);
    if (block && data.stop_reason !== "max_tokens") {
      return { input: normalize(block.input || {}), usage: data.usage || null, model };
    }
    lastError = data.stop_reason === "max_tokens"
      ? "La réponse était trop longue. Raccourcis la leçon ou le nombre de questions."
      : "Réponse inattendue du service d'IA.";
    console.log("No usable tool_use", model, data.stop_reason);
  }
  throw new UserError(lastError, 502);
}

const validQcm = (q) =>
  q && typeof q.question === "string" && Array.isArray(q.choices) && q.choices.length === 4 &&
  Number.isInteger(q.answer_index) && q.answer_index >= 0 && q.answer_index <= 3;

/* =====================================================================
   CADRE PÉDAGOGIQUE
   ===================================================================== */

const NIVEAUX = {
  CP: "CP", CE1: "CE1", CE2: "CE2", CM1: "CM1", CM2: "CM2",
  "6e": "sixième", "5e": "cinquième", "4e": "quatrième", "3e": "troisième",
  "2de": "seconde", "1re": "première", Tle: "terminale", Sup: "enseignement supérieur",
};
const DIFFICULTES = {
  facile: "Facile : vérifier que l'essentiel est su. Questions directes, une notion par question, distracteurs nettement faux pour qui connaît la leçon.",
  standard: "Standard : niveau d'une interrogation en classe. Mélange de restitution et de compréhension, distracteurs plausibles.",
  exigeant: "Exigeant : niveau d'un contrôle bien noté. Davantage d'application et de cas nouveaux, distracteurs fondés sur les erreurs les plus fréquentes.",
};

const BASE = `Tu es un enseignant expérimenté des programmes scolaires français (école primaire, collège, lycée, y compris les spécialités). Un parent, ou un élève autonome, veut vérifier qu'une leçon est bien sue.

Principes communs :
- Le contenu de référence fourni fait foi. N'introduis aucune notion qui n'y figure pas. Tu peux inventer de nouvelles situations, de nouveaux nombres ou de courts exemples pour faire APPLIQUER ce contenu.
- Adapte strictement le vocabulaire, la longueur des phrases et la difficulté au niveau indiqué. En primaire et en début de collège : phrases courtes, mots simples, un seul piège à la fois.
- Respecte les consignes du parent dès qu'elles sont compatibles avec ces principes.
- Formules : en LaTeX entre \\( et \\) (en ligne) ou \\[ et \\] (centrées), jamais avec $. Nombres décimaux à la française (virgule).
- Mise en forme : uniquement le **gras** et les listes commençant par "- ".`;

function niveauLabel(n) { return NIVEAUX[n] || "non précisé"; }

/** Contexte commun aux étapes fiche et qcm. */
function contexte(body) {
  const notions = asArray(body.notions).slice(0, 10);
  const listing = notions
    .filter((n) => n && typeof n.id === "string")
    .map((n) => `- ${n.id} : ${text(n.label, 200)}${n.resume ? " — " + text(n.resume, 400) : ""}`)
    .join("\n");
  const contenu = text(body.contenu);
  if (!contenu) throw new UserError("Le contenu de la leçon est manquant. Recommence depuis l'accueil.");
  const consignes = text(body.consignes, 1500);
  return {
    ids: notions.map((n) => n && n.id).filter(Boolean),
    text:
      `Matière : ${text(body.matiere, 80) || "non précisée"}\nNiveau : ${niveauLabel(body.niveau)}\n` +
      `Sujet : ${text(body.titre, 200)}\n` +
      `Source : ${body.source === "programme" ? "aucune leçon fournie, contenu établi d'après le programme officiel" : "leçon fournie par le parent"}\n` +
      (consignes ? `Consignes du parent : ${consignes}\n` : "") +
      `\nNotions (identifiants à réutiliser) :\n${listing}\n\n<contenu>\n${contenu}\n</contenu>`,
  };
}

/* =====================================================================
   1. PRÉPARER : la demande du parent → contenu de référence + notions
   ===================================================================== */

const PREPARER_TOOL = {
  name: "preparer_lecon",
  description: "Enregistre le contenu de référence de la leçon et ses notions clés.",
  input_schema: {
    type: "object",
    properties: {
      exploitable: { type: "boolean", description: "false si la demande est trop vague ou ne porte pas sur un sujet scolaire" },
      probleme: { type: "string", description: "Si exploitable=false : ce qu'il faut préciser, en une phrase adressée au parent" },
      matiere: { type: "string", description: "Matière (Mathématiques, Français, Histoire, Géographie, SVT, Physique-chimie, Anglais, Technologie, EMC, SES…)" },
      titre: { type: "string", description: "Titre court de la leçon, 3 à 8 mots" },
      contenu: { type: "string", description: "Contenu de référence complet et organisé : si une leçon est fournie, sa restitution fidèle (corrigée des fautes de dictée, sans rien ajouter) ; sinon, l'essentiel du programme officiel sur ce sujet pour ce niveau." },
      notions: {
        type: "array", minItems: 2, maxItems: 8,
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Nom court de la notion (2 à 6 mots)" },
            resume: { type: "string", description: "Ce qu'il faut savoir, en une phrase" },
          },
          required: ["label", "resume"],
        },
      },
    },
    required: ["exploitable"],
  },
};

async function stepPreparer(env, body) {
  const sujet = text(body.sujet, 400).trim();
  const lecon = text(body.lecon, MAX_LECON).trim();
  const consignes = text(body.consignes, 1500).trim();
  if (!sujet && !lecon) throw new UserError("Indique au moins le sujet ou colle le texte de la leçon.");

  const demande =
    `Matière indiquée : ${text(body.matiere, 80) || "à déduire"}\n` +
    `Niveau : ${niveauLabel(body.niveau)}\n` +
    `Sujet : ${sujet || "à déduire de la leçon"}\n` +
    (consignes ? `Consignes du parent : ${consignes}\n` : "") +
    (lecon
      ? `\nTexte de la leçon (lu, collé ou dicté par le parent ; la dictée peut contenir des erreurs de transcription) :\n<lecon>\n${lecon}\n</lecon>\n\n` +
        `Restitue fidèlement cette leçon comme contenu de référence (corrige seulement les erreurs manifestes de dictée), puis découpe-la en 2 à 8 notions clés dans l'ordre. N'ajoute aucune notion absente du texte.`
      : `\nAucun texte de leçon n'est fourni. Établis le contenu de référence d'après le programme officiel français pour ce niveau et ce sujet, en te limitant à ce qu'un élève de ce niveau doit savoir, puis découpe-le en 2 à 8 notions clés. Si le sujet est trop vague pour savoir quoi interroger, mets exploitable à false.`);

  const { input, usage } = await callTool(env, {
    system: BASE, tool: PREPARER_TOOL, maxTokens: 8000,
    content: [{ type: "text", text: demande }],
  });

  if (input.exploitable === false) {
    return { exploitable: false, probleme: input.probleme || "Précise le sujet de la leçon (chapitre, notions attendues)." };
  }
  const notions = asArray(input.notions)
    .filter((n) => n && n.label)
    .slice(0, 8)
    .map((n, i) => ({ id: "n" + (i + 1), label: String(n.label), resume: String(n.resume || "") }));
  if (!input.contenu || notions.length < 1) {
    return { exploitable: false, probleme: "La leçon est trop courte pour en tirer un quiz. Ajoute du texte ou précise le sujet." };
  }
  return {
    exploitable: true,
    source: lecon ? "lecon" : "programme",
    matiere: input.matiere || text(body.matiere, 80) || "Leçon",
    titre: input.titre || sujet || "Leçon",
    contenu: input.contenu,
    notions,
    usage,
  };
}

/* =====================================================================
   2. FICHE RÉSUMÉ + CARTE MENTALE
   ===================================================================== */

const FICHE_TOOL = {
  name: "creer_fiche",
  description: "Enregistre la fiche résumé et la carte mentale.",
  input_schema: {
    type: "object",
    properties: {
      essentiel: { type: "string", description: "L'idée directrice de la leçon en 2 phrases maximum" },
      blocs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            notion_id: { type: "string" },
            type: { type: "string", enum: ["definition", "propriete", "formule", "date", "methode", "exemple", "vocabulaire", "regle"] },
            titre: { type: "string" },
            contenu: { type: "string", description: "À retenir, concis (1 à 4 lignes)" },
          },
          required: ["notion_id", "type", "titre", "contenu"],
        },
      },
      pieges: {
        type: "array", maxItems: 4,
        items: {
          type: "object",
          properties: {
            piege: { type: "string", description: "L'erreur fréquente" },
            correction: { type: "string", description: "Ce qu'il faut faire ou dire à la place" },
          },
          required: ["piege", "correction"],
        },
      },
      carte: {
        type: "object",
        description: "Carte mentale. Texte simple, SANS LaTeX ni Markdown (symboles Unicode autorisés : ², √, →, ≤, ×, π).",
        properties: {
          centre: { type: "string", description: "Sujet central, 2 à 5 mots" },
          branches: {
            type: "array",
            items: {
              type: "object",
              properties: {
                notion_id: { type: "string" },
                label: { type: "string", description: "Nom de la branche, 1 à 4 mots" },
                feuilles: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" }, description: "Idées clés, 3 à 9 mots chacune" },
              },
              required: ["notion_id", "label", "feuilles"],
            },
          },
        },
        required: ["centre", "branches"],
      },
    },
    required: ["essentiel", "blocs", "pieges", "carte"],
  },
};

async function stepFiche(env, body) {
  const ctx = contexte(body);
  const { input, usage } = await callTool(env, {
    system: BASE, tool: FICHE_TOOL, maxTokens: 5000,
    content: [{ type: "text", text: ctx.text + `

Rédige une fiche résumé d'une page : l'essentiel, puis des blocs courts (définitions, règles, formules, dates, méthodes, exemples) rattachés à leur notion, puis 2 à 4 pièges classiques pour ce niveau. Chaque bloc doit pouvoir être mémorisé en moins d'une minute.
Construis aussi la carte mentale : le sujet au centre, une branche par notion (même notion_id, dans l'ordre), 2 à 4 feuilles par branche.` }],
  });
  const carte = input.carte && typeof input.carte === "object" && Array.isArray(input.carte.branches) ? {
    centre: String(input.carte.centre || body.titre || "Leçon").slice(0, 80),
    branches: input.carte.branches
      .filter((b) => b && b.label)
      .slice(0, 8)
      .map((b) => ({
        notion_id: ctx.ids.includes(b.notion_id) ? b.notion_id : "",
        label: String(b.label).slice(0, 60),
        feuilles: asArray(b.feuilles).slice(0, 4).map((f) => String(f).slice(0, 90)),
      })),
  } : null;
  return {
    essentiel: input.essentiel || "",
    blocs: asArray(input.blocs).filter((b) => b && b.contenu),
    pieges: asArray(input.pieges).filter((p) => p && p.piege),
    carte,
    usage,
  };
}

/* =====================================================================
   3. QCM
   ===================================================================== */

const QCM_TOOL = {
  name: "creer_qcm",
  description: "Enregistre les questions à choix multiples.",
  input_schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            notion_id: { type: "string" },
            question: { type: "string" },
            choices: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 4 },
            answer_index: { type: "integer", minimum: 0, maximum: 3 },
            explanation: { type: "string", description: "Pourquoi la bonne réponse est juste et pourquoi le piège principal est faux (2 phrases max, au niveau de l'élève)" },
          },
          required: ["notion_id", "question", "choices", "answer_index", "explanation"],
        },
      },
    },
    required: ["questions"],
  },
};

async function stepQcm(env, body) {
  const ctx = contexte(body);
  const count = Math.min(Math.max(parseInt(body.count, 10) || 10, 3), 15);
  const diff = DIFFICULTES[body.difficulte] || DIFFICULTES.standard;
  const avoid = asArray(body.avoid).slice(0, 60).map((s) => text(s, 300)).filter(Boolean);
  const oral = body.mode === "oral";

  const { input, usage } = await callTool(env, {
    system: BASE, tool: QCM_TOOL, maxTokens: 5000,
    content: [{ type: "text", text: ctx.text +
      (avoid.length ? `\n\nQuestions déjà posées (n'en reprends aucune, change d'angle) :\n- ${avoid.join("\n- ")}` : "") + `

Crée exactement ${count} questions à choix multiples, réparties entre les notions listées (rattache chaque question à son notion_id).
- Difficulté demandée : ${diff}
- Si les consignes du parent précisent le type de questions, la répartition ou les points à vérifier, applique-les en priorité.
- 4 choix, une seule bonne réponse sans ambiguïté ; distracteurs = erreurs typiques d'un élève de ce niveau, jamais absurdes. Varie la position de la bonne réponse. Pas de « toutes/aucune de ces réponses ».` +
      (oral ? `\n- Les questions seront LUES À VOIX HAUTE par le parent : formulations courtes, sans tableau ni schéma, choix brefs et faciles à prononcer, formules simples.` : "") }],
  });
  const questions = asArray(input.questions)
    .map((q) => (q && typeof q === "object" ? { ...q, answer_index: Number(q.answer_index) } : q))
    .filter(validQcm)
    .map((q) => ({ ...q, notion_id: ctx.ids.includes(q.notion_id) ? q.notion_id : ctx.ids[0] }));
  if (questions.length < 2) throw new UserError("Les questions n'ont pas pu être générées. Réessaie.", 502);
  return { questions, usage };
}

/* =====================================================================
   POINT D'ENTRÉE
   ===================================================================== */

const STEPS = { preparer: stepPreparer, fiche: stepFiche, qcm: stepQcm };

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "Méthode non autorisée." }, 405, cors);

    if (!env.ACCESS_CODE || request.headers.get("X-Access-Code") !== env.ACCESS_CODE) {
      return json({ error: "Code d'accès incorrect. Vérifie le code d'activation." }, 401, cors);
    }
    if (!env.ANTHROPIC_API_KEY) return json({ error: "Clé API absente côté serveur." }, 500, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Requête invalide." }, 400, cors); }

    try {
      const step = STEPS[body.step];
      if (!step) return json({ error: "Étape inconnue." }, 400, cors);
      return json(await step(env, body), 200, cors);
    } catch (e) {
      if (e instanceof UserError) return json({ error: e.message }, e.status, cors);
      console.log("Unexpected", e && e.stack);
      return json({ error: "Erreur interne du serveur (" + String((e && e.message) || e).slice(0, 160) + ")." }, 500, cors);
    }
  },
};

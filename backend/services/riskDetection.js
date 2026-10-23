// Deterministic high-risk review detection. Runs regardless of AI availability,
// and AI output can never clear a flag raised here.

const RISK_RULES = [
    {
        category: "food_safety",
        patterns: [
            /\bfood[\s-]?poisoning\b/,
            /\bfood[\s-]?borne\b/,
            /\b(got|get|getting|became|become|fell|feel|felt|was|were|been|made (me|us|him|her|them|my \w+))\s+(really\s+|very\s+|so\s+|violently\s+)?(sick|ill)\b(?!\s*-|\s+of\b)/,
            /\b(vomit(ed|ing)?|threw up|throwing up|diarrh(o)?ea|salmonella|e\.?\s?coli|listeria|stomach (bug|cramps))\b/,
            /\b(cockroach(es)?|roach(es)?|rats?|mice|mouse droppings|maggots?)\b/,
            /\b(raw|undercooked)\s+(chicken|pork|meat)\b/,
        ],
    },
    {
        category: "allergy_medical",
        patterns: [
            /\ballerg(y|ies|ic|en|ens)\b/,
            /\banaphyla(xis|ctic)\b/,
            /\bepi-?pen\b/,
            /\b(hospital(i[sz]ed)?|emergency room|ambulance|paramedics?)\b/,
            /\binjur(y|ies|ed)\b/,
        ],
    },
    {
        category: "harassment_discrimination",
        patterns: [
            /\bharass(ed|ment|ing)?\b/,
            /\bdiscriminat(e|ed|ion|ing|ory)\b/,
            /\b(racis[tm]|sexis[tm]|homophobic|transphobic)\b/,
            /\bsexual(ly)?\s+(assault\w*|harass\w*)\b/,
            /\b(groped|inappropriately touched)\b/,
            /\bassault(ed)?\b/,
            /\bslurs?\b/,
        ],
    },
    {
        category: "fraud_legal",
        patterns: [
            /\bfraud(ulent)?\b/,
            /\bscam(med|mer|mers)?\b/,
            /\b(lawyer|attorney|solicitor)s?\b/,
            /\blaw\s?suit\b/,
            /\b(sue|suing|sued)\b/,
            /\b(il)?legal\b/,
            /\bsmall claims\b/,
            /\b(stole|stolen|theft)\b/,
            /\bunauthori[sz]ed (charge|transaction)s?\b/,
        ],
    },
    {
        category: "threats_police",
        patterns: [
            /\bthreat(s|en|ened|ening)?\b/,
            /\bpolice\b/,
            /\b(called|call) the cops\b/,
            /\b911\b/,
            /\b(guns?|weapons?)\b/,
            /\b(kill|hurt|beat)\s+(you|me|him|her|them|us|someone)\b/,
        ],
    },
    {
        category: "unsafe_conditions",
        patterns: [
            /\bunsafe\b/,
            /\b(dangerous|hazard(ous)?|gas leak|electrocut\w*|carbon monoxide)\b/,
            /\bhealth (department|inspector|inspection|code)\b/,
        ],
    },
];

function detectHighRisk(text) {
    const lower = typeof text === "string" ? text.toLowerCase() : "";
    if (!lower.trim()) {
        return { isHighRisk: false, categories: [] };
    }
    const categories = RISK_RULES
        .filter((rule) => rule.patterns.some((pattern) => pattern.test(lower)))
        .map((rule) => rule.category);
    return { isHighRisk: categories.length > 0, categories };
}

module.exports = { detectHighRisk, RISK_CATEGORIES: RISK_RULES.map((r) => r.category) };
